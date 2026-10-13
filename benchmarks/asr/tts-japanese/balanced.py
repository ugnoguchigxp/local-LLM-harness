#!/usr/bin/env python3
"""Interleave three candidate ASRs and two existing providers on identical clips."""
from contextlib import ExitStack
import argparse
import dataclasses
import json
from pathlib import Path
import random
import resource
import subprocess
import time

import suite


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--qwen-model", type=Path, required=True)
    parser.add_argument("--qwen-driver", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--threads", type=int, default=16)
    args = parser.parse_args()
    output = args.root / "balanced"
    output.mkdir(exist_ok=True)
    manifest = json.loads((args.root / "manifest.json").read_text())
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    if list(output.glob("*.jsonl")):
        raise RuntimeError("Balanced measurements already exist; choose a new output directory")
    import transcribe_cpp as tc
    worker = None
    metadata = {"native_commit": tc.native_commit(), "threads": args.threads, "repeats": args.repeats,
                "selection": "Cohere Q8_0 Vulkan, Granite Q8_0 Vulkan, Qwen 1.7B native HIP Q8; existing Qwen ROCm FP16 and Whisper turbo HIP Q5_0 controls",
                "timing_scope": "warm whole-utterance final transcript; model initialization excluded; file input/PCM preparation or HTTP upload included",
                "schedule": "shuffle clips and provider order deterministically per repeat; only one measured inference at a time",
                "warmup": "one short and one long clip per provider, excluded",
                "start_host": suite.host_snapshot(), "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "new_provider_configuration": False, "models": {}}
    adapters = {}
    with ExitStack() as stack:
        try:
            for name, filename in [("cohere-vulkan-q8", "cohere-transcribe-03-2026-Q8_0.gguf"),
                                   ("granite-vulkan-q8", "granite-speech-4.1-2b-Q8_0.gguf")]:
                path = args.models / filename
                start = time.perf_counter()
                model = stack.enter_context(tc.Model(path, backend="vulkan"))
                session = stack.enter_context(model.session(n_threads=args.threads))
                metadata["models"][name] = {"path": str(path), "load_seconds": time.perf_counter() - start,
                                             "actual_backend": model.backend, "device": dataclasses.asdict(model.device)}
                def recognize(clip, session=session):
                    result = session.run(suite.load_pcm(clip["wav"]), language="ja", timestamps="none")
                    return result.text, {"timings_ms": dataclasses.asdict(result.timings)}
                adapters[name] = recognize
                print(f"loaded {name}", flush=True)
            native_log = stack.enter_context((output / "qwen-native.log").open("w"))
            worker = subprocess.Popen([str(args.qwen_driver), str(args.qwen_model), str(args.threads)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=native_log, text=True)
            ready = json.loads(worker.stdout.readline())
            if not ready.get("ready"):
                raise RuntimeError(f"Qwen initialization failed: {ready}")
            metadata["models"]["qwen-native-hip-q8"] = {"path": str(args.qwen_model), **ready}
            def recognize_native(clip):
                worker.stdin.write(clip["wav"] + "\n")
                worker.stdin.flush()
                line = worker.stdout.readline()
                if not line:
                    raise RuntimeError(f"Qwen exited: {worker.poll()}")
                result = json.loads(line)
                if "error" in result:
                    raise RuntimeError(result["error"])
                return result["text"], {"native_seconds": result["seconds"]}
            adapters["qwen-native-hip-q8"] = recognize_native
            adapters["qwen-pytorch-rocm-fp16"] = lambda clip: suite.transcribe_http("http://127.0.0.1:8081", clip, "qwen3-asr-1.7b")
            adapters["whisper-turbo-hip-q5"] = lambda clip: suite.transcribe_http("http://127.0.0.1:8085", clip, "whisper-1")
            metadata["warmups"] = []
            for name, recognize in adapters.items():
                for group in ("short", "long"):
                    clip = next(c for c in manifest["clips"] if c["group"] == group)
                    start = time.perf_counter()
                    text, detail = recognize(clip)
                    metadata["warmups"].append({"name": name, "clip": clip["id"], "text": text,
                                                "seconds": time.perf_counter() - start, "details": detail})
                print(f"warmup complete {name}", flush=True)
            (output / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str) + "\n")
            files = {name: stack.enter_context((output / (name + ".jsonl")).open("w")) for name in adapters}
            for repeat in range(args.repeats):
                generator = random.Random(20261012 + repeat)
                clips = list(manifest["clips"])
                generator.shuffle(clips)
                for clip in clips:
                    names = list(adapters)
                    generator.shuffle(names)
                    for name in names:
                        before = suite.host_snapshot()
                        start = time.perf_counter()
                        try:
                            text, detail = adapters[name](clip)
                            error = None
                        except Exception as exc:
                            text, detail, error = "", {}, f"{type(exc).__name__}: {exc}"
                        seconds = time.perf_counter() - start
                        reference = suite.normalize(clip["reference"])
                        hypothesis = suite.normalize(text)
                        row = {"name": name, "repeat": repeat, **clip, "text": text, "seconds": seconds,
                               "rtf": seconds / clip["duration_seconds"], "reference_normalized": reference,
                               "hypothesis_normalized": hypothesis, "reference_units": len(reference),
                               "edits": suite.distance(reference, hypothesis), "exact": reference == hypothesis,
                               "error": error, "details": detail, "host_before": before, "host_after": suite.host_snapshot()}
                        files[name].write(json.dumps(row, ensure_ascii=False) + "\n")
                        files[name].flush()
                        print(f'round {repeat + 1} {clip["id"]} {name} {seconds:.3f}s {text} {error or ""}', flush=True)
            metadata.update(end_host=suite.host_snapshot(), maxrss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
            (output / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str) + "\n")
        finally:
            if worker:
                worker.stdin.close()
                try:
                    worker.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    worker.terminate()
                    worker.wait(timeout=15)
    args.root = output
    suite.summarize(args)


if __name__ == "__main__":
    main()
