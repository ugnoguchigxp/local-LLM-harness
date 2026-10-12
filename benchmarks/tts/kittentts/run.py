"""Benchmark the demo's KittenTTS 0.8.1 using pinned local model files.

Install the official wheel in an external venv; place models and all outputs
outside this repository. The only inference change is explicit ORT thread
settings and CPU provider selection. Use --threads 0 for official defaults.
"""
import argparse
import gc
import importlib.metadata
import json
from pathlib import Path
import resource
import threading
import time
from concurrent.futures import ThreadPoolExecutor


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--variant", choices=["fp32", "int8"], default="fp32")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--sweep", action="store_true")
    parser.add_argument("--concurrency", action="store_true")
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    for path in [args.models, args.output]:
        if not path.is_absolute() or path.resolve() == repository or repository in path.resolve().parents:
            parser.error("Model and output paths must be absolute and outside the source repository")
    if args.threads < 0 or args.repeats < 1:
        parser.error("Threads must be nonnegative and repeats positive")
    args.output.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    import numpy as np
    import onnxruntime as ort
    import psutil
    import soundfile as sf
    from kittentts.onnx_model import KittenTTS_1_Onnx, chunk_text

    imported_s = time.perf_counter() - started
    process = psutil.Process()
    peak = [process.memory_info().rss]
    stop = threading.Event()

    def monitor():
        while not stop.wait(0.01):
            peak[0] = max(peak[0], process.memory_info().rss)

    watcher = threading.Thread(target=monitor, daemon=True)
    watcher.start()
    root = args.models / args.variant
    config = json.loads((root / "config.json").read_text())
    original_session = ort.InferenceSession

    def cpu_session(path):
        options = ort.SessionOptions()
        options.intra_op_num_threads = args.threads
        if args.threads:
            options.inter_op_num_threads = 1
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        return original_session(path, sess_options=options, providers=["CPUExecutionProvider"])

    ort.InferenceSession = cpu_session
    before_rss = process.memory_info().rss
    t = time.perf_counter()
    model = KittenTTS_1_Onnx(str(root / config["model_file"]), str(root / config["voices"]),
                            config["speed_priors"], config["voice_aliases"])
    load_s = time.perf_counter() - t
    ort.InferenceSession = original_session
    corpus = json.loads(Path(__file__).with_name("corpus.json").read_text())
    result = {
        "variant": args.variant, "threads": args.threads, "repeats": args.repeats,
        "import_s": imported_s, "load_s": load_s,
        "rss_after_import_mib": before_rss / 2**20,
        "rss_loaded_mib": process.memory_info().rss / 2**20,
        "available_providers": ort.get_available_providers(),
        "session_providers": model.session.get_providers(),
        "versions": {p: importlib.metadata.version(p) for p in
                     ["kittentts", "onnxruntime", "numpy", "phonemizer-fork", "torch", "spacy"]},
        "voice_aliases": config["voice_aliases"],
        "rows": [], "concurrency": []
    }

    def synth(text, voice, clean=False, speed=1):
        cpu0 = time.process_time()
        t = time.perf_counter()
        audio = model.generate(text, voice=voice, speed=speed, clean_text=clean).reshape(-1)
        elapsed = time.perf_counter() - t
        duration = len(audio) / 24000
        return audio, dict(wall_s=elapsed, audio_s=duration, rtf=elapsed / duration,
                           cpu_s=time.process_time() - cpu0,
                           finite=bool(np.isfinite(audio).all()),
                           peak=float(np.max(np.abs(audio))),
                           rms=float(np.sqrt(np.mean(audio**2))),
                           clip_fraction=float(np.mean(np.abs(audio) >= 1)),
                           samples=len(audio))

    audio, first = synth(corpus["short"], "Rosie")
    result["first_synthesis"] = first
    result["rss_after_first_synthesis_mib"] = process.memory_info().rss / 2**20
    result["startup_to_first_audio_s"] = imported_s + load_s + first["wall_s"]
    keys = ["short", "medium"] if args.sweep else list(corpus)
    for voice in ["Rosie", "Hugo"]:
        for key in keys:
            for rep in range(args.repeats):
                audio, row = synth(corpus[key], voice)
                row.update(voice=voice, case=key, repetition=rep, chars=len(corpus[key]), clean_text=False)
                result["rows"].append(row)
                if rep == 0 and not args.sweep:
                    sf.write(args.output / f"{voice}-{key}.wav", audio, 24000, subtype="PCM_16")
            print(json.dumps(dict(voice=voice, case=key, wall_s=row["wall_s"], rtf=row["rtf"])), flush=True)
    if not args.sweep:
        result["frontend_probe"] = {
            key: {"original": corpus[key], "normalized": model.preprocessor(corpus[key]),
                  "raw_chunks": chunk_text(corpus[key]),
                  "normalized_chunks": chunk_text(model.preprocessor(corpus[key]))}
            for key in ["numbers", "punctuation", "technical", "japanese_negative_control"]
        }
        for voice in ["Rosie", "Hugo"]:
            audio, row = synth(corpus["numbers"], voice, clean=True)
            row.update(voice=voice, case="numbers-clean", repetition=0, clean_text=True)
            result["rows"].append(row)
            sf.write(args.output / f"{voice}-numbers-clean.wav", audio, 24000, subtype="PCM_16")
            for speed in [0.8, 1.2]:
                audio, row = synth(corpus["short"], voice, speed=speed)
                row.update(voice=voice, case=f"speed-{speed}", repetition=0, speed=speed)
                result["rows"].append(row)
                sf.write(args.output / f"{voice}-speed-{speed}.wav", audio, 24000, subtype="PCM_16")
        # Sentence-level yielding using the official chunk generator; no native
        # streaming API exists in 0.8.1. Record this separately from full output.
        t = time.perf_counter()
        chunks = []
        for text in chunk_text(corpus["long"]):
            audio = model.generate_single_chunk(text, "Rosie").reshape(-1)
            chunks.append(dict(ready_s=time.perf_counter() - t, audio_s=len(audio) / 24000, text=text))
        result["sentence_chunk_probe"] = chunks
    result["rss_after_serial_requests_mib"] = process.memory_info().rss / 2**20
    result["serial_peak_rss_sampled_mib"] = peak[0] / 2**20
    if args.concurrency:
        # Precompute phonemes serially: shared EspeakBackend thread safety is
        # unproven. This tests simultaneous ONNX inference, not HTTP serving.
        inputs = [model._prepare_inputs(corpus["medium"], v) for v in ["Rosie", "Hugo"]]
        def infer(index, barrier):
            barrier.wait()
            t = time.perf_counter()
            audio = model.session.run(None, inputs[index % 2])[0][..., :-5000]
            return dict(wall_s=time.perf_counter() - t, audio_s=audio.size / 24000,
                        finite=bool(np.isfinite(audio).all()))
        for workers in [1, 2, 4]:
            for rep in range(3):
                barrier = threading.Barrier(workers)
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    futures = [pool.submit(infer, i, barrier) for i in range(workers)]
                    rows = [f.result() for f in futures]
                wall = max(r["wall_s"] for r in rows)
                result["concurrency"].append(dict(workers=workers, repetition=rep, rows=rows,
                                                  wall_s=wall, aggregate_rtf=wall / sum(r["audio_s"] for r in rows)))
    gc.collect()
    result["rss_after_requests_mib"] = process.memory_info().rss / 2**20
    stop.set()
    watcher.join()
    cpu0, t = time.process_time(), time.perf_counter()
    threading.Event().wait(2)
    result["idle_cpu_percent_of_one_core"] = 100 * (time.process_time() - cpu0) / (time.perf_counter() - t)
    result["peak_rss_sampled_mib"] = peak[0] / 2**20
    result["process_maxrss_mib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    (args.output / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k not in ["rows", "concurrency"]}), flush=True)


if __name__ == "__main__":
    main()
