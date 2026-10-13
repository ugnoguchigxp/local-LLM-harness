#!/usr/bin/env python3
"""Japanese synthetic-speech ASR comparison; all media/results stay outside the repo."""

from __future__ import annotations

import argparse
import array
import dataclasses
import hashlib
import json
import math
import os
from pathlib import Path
import random
import resource
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import wave


TEXTS = [
    ("s01", "short", "明日の天気を教えて。"),
    ("s02", "short", "音量を少し下げてください。"),
    ("s03", "short", "予約は変更しないでください。"),
    ("s04", "short", "田中さんに電話をかけて。"),
    ("s05", "short", "パソコンの設定を開いて。"),
    ("s06", "short", "水曜日の予定を確認して。"),
    ("l01", "long", "明日の午後三時に田中さんとオンラインで打ち合わせをするので、開始する少し前に知らせてください。"),
    ("l02", "long", "このファイルは削除せずに新しい名前で保存してから、共有フォルダにコピーしておいてください。"),
    ("l03", "long", "京都駅から奈良公園まで電車で移動したいので、乗り換えが少ない行き方を調べて教えてください。"),
    ("l04", "long", "冷蔵庫にある豆腐と野菜を使って、辛くない夕食を作りたいので、簡単な献立を提案してください。"),
    ("l05", "long", "音声認識の設定を確認して、日本語の専門用語と固有名詞を正しく文字起こしできるか試してください。"),
    ("l06", "long", "昨夜注文した商品の届け先を会社ではなく自宅に変更したいので、手続きの方法を教えてください。"),
]
VOICES = [("Kasukabe_Tsumugi", "VOICEVOX:春日部つむぎ"), ("Zundamon", "VOICEVOX:ずんだもん")]


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return "".join(c for c in text if not c.isspace() and unicodedata.category(c)[0] not in "PZ")


def distance(reference: str, hypothesis: str) -> int:
    previous = list(range(len(hypothesis) + 1))
    for i, a in enumerate(reference, 1):
        current = [i]
        for j, b in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def host_snapshot() -> dict:
    busy = []
    for path in sorted(Path("/sys/class/drm").glob("card*/device/gpu_busy_percent")):
        try:
            busy.append(int(path.read_text().strip()))
        except (OSError, ValueError):
            pass
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        if key in {"MemAvailable", "SwapFree"}:
            memory[key + "KiB"] = int(value.strip().split()[0])
    return {"gpu_busy_percent": busy, "loadavg": os.getloadavg(), **memory}


def request_json(url: str, payload: dict) -> tuple[bytes, dict]:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    for attempt in range(15):
        try:
            with urllib.request.urlopen(req, timeout=180) as response:
                return response.read(), dict(response.headers)
        except urllib.error.HTTPError as error:
            if error.code not in (429, 503) or attempt == 14:
                raise RuntimeError(f"HTTP {error.code}: {error.read().decode(errors='replace')}") from error
            time.sleep(1)
    raise AssertionError("unreachable")


def synthesize(args) -> None:
    args.root.mkdir(parents=True, exist_ok=True)
    audio = args.root / "audio"
    audio.mkdir(exist_ok=True)
    clips = []
    for voice, credit in VOICES:
        for text_id, group, text in TEXTS:
            clip_id = text_id + "-" + voice
            raw = audio / (clip_id + "-source.wav")
            wav = audio / (clip_id + ".wav")
            synthesis_seconds = None
            headers = {}
            if not raw.exists():
                start = time.perf_counter()
                body, headers = request_json(args.url + "/v1/audio/speech", {
                    "model": "voicevox-core", "input": text, "voice": voice,
                    "response_format": "wav", "speed": 1.0,
                })
                synthesis_seconds = time.perf_counter() - start
                raw.write_bytes(body)
            if not wav.exists():
                subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(raw),
                                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav)], check=True)
            with wave.open(str(wav), "rb") as source:
                assert source.getframerate() == 16000 and source.getnchannels() == 1 and source.getsampwidth() == 2
                seconds = source.getnframes() / source.getframerate()
            row = {"id": clip_id, "text_id": text_id, "group": group, "reference": text,
                   "reference_chars": len(text), "voice": voice, "credit": credit,
                   "wav": str(wav), "duration_seconds": seconds,
                   "wav_sha256": hashlib.sha256(wav.read_bytes()).hexdigest(),
                   "tts_seconds": synthesis_seconds, "tts_headers": headers}
            clips.append(row)
            print(f"synthesized {clip_id}: {len(text)} chars, {seconds:.2f}s", flush=True)
    manifest = {"language": "ja", "tts": "VOICEVOX CORE 0.17.0, CPU, normal style, speed=1.0",
                "sample_rate": 16000, "channels": 1, "format": "PCM s16le",
                "normalization": "NFKC, lower case, remove whitespace and Unicode punctuation; no numeric/kanji substitution",
                "limitations": "Synthetic clean speech from one TTS engine; two voices are not independent natural speakers.",
                "clips": clips}
    (args.root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")


def load_pcm(path: str) -> array.array:
    with wave.open(path, "rb") as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 16000)
        data = wav.readframes(wav.getnframes())
    samples = array.array("h")
    samples.frombytes(data)
    if sys.byteorder != "little":
        samples.byteswap()
    return array.array("f", (s / 32768 for s in samples))


def transcribe_http(url: str, clip: dict, model: str) -> tuple[str, dict]:
    boundary = "larm-asr-benchmark-boundary"
    fields = {"model": model, "language": "ja", "response_format": "json"}
    chunks = []
    for key, value in fields.items():
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode())
    chunks.append(Path(clip["wav"]).read_bytes())
    chunks.append(f"\r\n--{boundary}--\r\n".encode())
    req = urllib.request.Request(url + "/v1/audio/transcriptions", data=b"".join(chunks),
                                 headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=180) as response:
        result = json.load(response)
    return result["text"], {"response": result}


def run_suite(args) -> None:
    manifest = json.loads((args.root / "manifest.json").read_text())
    clips = manifest["clips"]
    rows_path = args.root / (args.name + ".jsonl")
    if rows_path.exists():
        raise RuntimeError(f"Refusing to overwrite existing measurements: {rows_path}")
    metadata = {"name": args.name, "engine": args.engine, "model": args.model,
                "backend": args.backend, "threads": args.threads, "repeats": args.repeats,
                "start_host": host_snapshot(), "started_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "warmup": "one short and one long clip, excluded; model/session reused",
                "timing_scope": "warm offline transcription, PCM preparation/upload included; model load excluded",
                "new_provider_configuration": False}
    model_context = session = worker = native_log = None
    try:
        if args.engine == "transcribe-cpp":
            import transcribe_cpp
            start = time.perf_counter()
            model_context = transcribe_cpp.Model(args.model, backend=args.backend)
            session = model_context.session(n_threads=args.threads)
            metadata.update(load_seconds=time.perf_counter() - start,
                            native_commit=transcribe_cpp.native_commit(), actual_backend=model_context.backend,
                            device=dataclasses.asdict(model_context.device),
                            supports_language_hint=model_context.capabilities.languages,
                            supports_vocabulary=model_context.supports("vocabulary"))
            def recognize(clip):
                result = session.run(load_pcm(clip["wav"]), language="ja", timestamps="none")
                return result.text, {"timings_ms": dataclasses.asdict(result.timings), "language": result.language}
        elif args.engine == "qwen-native":
            native_log = (args.root / (args.name + "-native.log")).open("w")
            worker = subprocess.Popen([args.driver, args.model, str(args.threads)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=native_log, text=True)
            ready = json.loads(worker.stdout.readline())
            if not ready.get("ready"):
                raise RuntimeError(f"Qwen driver failed: {ready}")
            metadata.update(ready)
            def recognize(clip):
                worker.stdin.write(clip["wav"] + "\n")
                worker.stdin.flush()
                line = worker.stdout.readline()
                if not line:
                    raise RuntimeError(f"native process ended, code={worker.poll()}")
                result = json.loads(line)
                if "error" in result:
                    raise RuntimeError(result["error"])
                return result["text"], {"native_seconds": result["seconds"]}
        else:
            def recognize(clip):
                return transcribe_http(args.url, clip, args.model)
        warmup_rows = []
        for group in ("short", "long"):
            clip = next(c for c in clips if c["group"] == group)
            start = time.perf_counter()
            text, detail = recognize(clip)
            warmup_rows.append({"clip": clip["id"], "text": text, "seconds": time.perf_counter() - start, **detail})
            print(f'{args.name}: {group} warmup complete', flush=True)
        metadata["warmup_rows"] = warmup_rows
        (args.root / (args.name + "-metadata.json")).write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str) + "\n")
        with rows_path.open("w") as out:
            for repeat in range(args.repeats):
                order = list(clips)
                random.Random(20261012 + repeat).shuffle(order)
                for index, clip in enumerate(order):
                    before = host_snapshot()
                    start = time.perf_counter()
                    try:
                        text, detail = recognize(clip)
                        error = None
                    except Exception as exc:
                        text, detail, error = "", {}, f"{type(exc).__name__}: {exc}"
                    seconds = time.perf_counter() - start
                    reference = normalize(clip["reference"])
                    hypothesis = normalize(text)
                    row = {"name": args.name, "repeat": repeat, **clip, "text": text,
                           "seconds": seconds, "rtf": seconds / clip["duration_seconds"],
                           "reference_normalized": reference, "hypothesis_normalized": hypothesis,
                           "edits": distance(reference, hypothesis), "reference_units": len(reference),
                           "exact": reference == hypothesis, "error": error, "details": detail,
                           "host_before": before, "host_after": host_snapshot()}
                    out.write(json.dumps(row, ensure_ascii=False) + "\n")
                    out.flush()
                    print(f'{args.name}: round {repeat + 1}/{args.repeats} {index + 1}/{len(order)} {seconds:.3f}s {text}', flush=True)
        metadata.update(end_host=host_snapshot(), maxrss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        (args.root / (args.name + "-metadata.json")).write_text(json.dumps(metadata, ensure_ascii=False, indent=2, default=str) + "\n")
    finally:
        if session:
            session.close()
        if model_context:
            model_context.close()
        if worker:
            worker.stdin.close()
            try:
                worker.wait(timeout=30)
            except subprocess.TimeoutExpired:
                worker.terminate()
                worker.wait(timeout=15)
        if native_log:
            native_log.close()


def quantile(values: list[float], p: float) -> float:
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * p) - 1)]


def summarize(args) -> None:
    results = []
    for path in sorted(args.root.glob("*.jsonl")):
        rows = [json.loads(line) for line in path.read_text().splitlines() if line]
        if not rows:
            continue
        first = [row for row in rows if row["repeat"] == 0]
        groups = {}
        for group in ("all", "short", "long"):
            timings = [r for r in rows if group == "all" or r["group"] == group]
            accuracy = [r for r in first if group == "all" or r["group"] == group]
            groups[group] = {"clips": len(accuracy), "attempts": len(timings),
                             "cer": sum(r["edits"] for r in accuracy) / sum(r["reference_units"] for r in accuracy),
                             "exact_clips": sum(r["exact"] for r in accuracy),
                             "errors": sum(r["error"] is not None for r in timings),
                             "p50_seconds": quantile([r["seconds"] for r in timings], .5),
                             "p95_seconds": quantile([r["seconds"] for r in timings], .95),
                             "rtf_p50": quantile([r["rtf"] for r in timings], .5),
                             "gpu_busy_before_p50": quantile([r["host_before"]["gpu_busy_percent"][0] for r in timings], .5)}
        result = {"name": path.stem, "groups": groups, "transcripts": first,
                  "inconsistent_clips": sum(len({r["text"] for r in rows if r["id"] == clip_id}) > 1 for clip_id in {r["id"] for r in rows})}
        results.append(result)
        print(json.dumps({"name": path.stem, **groups, "inconsistent_clips": result["inconsistent_clips"]}, ensure_ascii=False))
    (args.root / "summary.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    synth = commands.add_parser("synthesize")
    synth.add_argument("--url", default="http://127.0.0.1:8084")
    run = commands.add_parser("run")
    run.add_argument("--name", required=True)
    run.add_argument("--engine", choices=("http", "transcribe-cpp", "qwen-native"), required=True)
    run.add_argument("--model", required=True)
    run.add_argument("--backend", default="vulkan")
    run.add_argument("--threads", type=int, default=16)
    run.add_argument("--repeats", type=int, default=3)
    run.add_argument("--url", default="http://127.0.0.1:8081")
    run.add_argument("--driver")
    commands.add_parser("summarize")
    args = parser.parse_args()
    if args.command == "synthesize":
        synthesize(args)
    elif args.command == "run":
        run_suite(args)
    else:
        summarize(args)


if __name__ == "__main__":
    main()
