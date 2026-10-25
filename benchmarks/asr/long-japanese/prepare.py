#!/usr/bin/env python3
"""Prepare ~200-character synthetic ASR inputs outside the source repository."""
from __future__ import annotations

import argparse
import array
import hashlib
import io
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import urllib.request
import wave

SOURCE = Path(__file__).resolve().parent
REPO = SOURCE.parents[2]
RATE = 16000


def pcm(path: Path) -> array.array:
    with wave.open(str(path)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, RATE)
        values = array.array("h", w.readframes(w.getnframes()))
    if sys.byteorder != "little":
        values.byteswap()
    return values


def write_wav(path: Path, values: array.array) -> None:
    encoded = array.array("h", values)
    if sys.byteorder != "little":
        encoded.byteswap()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(encoded.tobytes())


def split_at_pauses(values: array.array) -> tuple[list[array.array], int]:
    """Bound every request below Granite's 12 s cap; don't use ASR outputs."""
    parts = []
    forced = 0
    while len(values) > int(11.5 * RATE):
        quiet = []
        for start in range(3 * RATE, int(10.5 * RATE), 160):
            frame = values[start:start + 3200]
            if len(frame) == 3200 and max(abs(x) for x in frame) < 120:
                quiet.append(start + 1600)
        cut = quiet[-1] if quiet else int(10.5 * RATE)
        forced += int(not quiet)
        parts.append(values[:cut])
        values = values[cut:]
    parts.append(values)
    return parts, forced


def outside_repo(path: Path) -> Path:
    path = path.resolve()
    if path == REPO or REPO in path.parents:
        raise ValueError("Audio and results must be outside the source repository")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = outside_repo(args.output)
    output.mkdir(parents=True, exist_ok=False)
    audio = output / "audio"
    audio.mkdir()
    corpus = json.loads((SOURCE / "corpus.json").read_text())
    rows = []
    selected_second = {"meeting", "numbers", "self_correction", "colloquial"}
    stress = {"numbers", "names", "self_correction", "colloquial"}

    def emit(entry, voice, condition, segments, forced=0):
        clip_id = f"{entry['id']}-{voice}-{condition}"
        paths = []
        whole = array.array("h")
        for i, values in enumerate(segments):
            path = audio / f"{clip_id}-{i:02d}.wav"
            write_wav(path, values)
            paths.append(str(path))
            if whole:
                whole.extend(array.array("h", [0]) * 4000)
            whole.extend(values)
        path = audio / f"{clip_id}.wav"
        write_wav(path, whole)
        row = {**entry, "id": clip_id, "text_id": entry["id"], "voice": voice,
               "condition": condition, "reference": "".join(entry["sentences"]),
               "characters": len("".join(entry["sentences"])), "audio": str(path),
               "segments": paths, "audio_seconds": len(whole) / RATE,
               "segment_seconds": [len(x) / RATE for x in segments],
               "forced_splits": forced, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        rows.append(row)
        (output / "manifest.json").write_text(json.dumps({"clips": rows}, ensure_ascii=False, indent=2) + "\n")
        print(f"prepared {clip_id}: {row['characters']} chars, {row['audio_seconds']:.2f}s, {len(segments)} parts", flush=True)

    for entry in corpus:
        assert 180 <= len("".join(entry["sentences"])) <= 220
        voices = ["Kasukabe_Tsumugi"] + (["Zundamon"] if entry["id"] in selected_second else [])
        for voice in voices:
            segments = []
            forced = 0
            for i, text in enumerate(entry["sentences"]):
                request = urllib.request.Request("http://127.0.0.1:8084/v1/audio/speech",
                    data=json.dumps({"model":"voicevox-core", "voice":voice,
                                     "input":text, "response_format":"wav", "speed":1.0}, ensure_ascii=False).encode(),
                    headers={"Content-Type":"application/json"})
                with urllib.request.urlopen(request, timeout=120) as response:
                    encoded = response.read()
                with wave.open(io.BytesIO(encoded)) as w:
                    assert w.getnframes() > 0
                source = audio / f"{entry['id']}-{voice}-sentence-{i:02d}-24k.wav"
                source.write_bytes(encoded)
                converted = source.with_name(source.stem + "-16k.wav")
                subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(source),
                                "-ar", str(RATE), "-ac", "1", "-c:a", "pcm_s16le", str(converted)], check=True)
                pieces, count = split_at_pauses(pcm(converted))
                segments.extend(pieces)
                forced += count
            emit(entry, voice, "clean", segments, forced)
            if voice == "Kasukabe_Tsumugi" and entry["id"] in stress:
                seed = int(hashlib.sha256(entry["id"].encode()).hexdigest()[:8], 16)
                rng = random.Random(seed)
                noisy = []
                for values in segments:
                    rms = math.sqrt(sum(x*x for x in values) / len(values))
                    noise_rms = rms / (10 ** (15 / 20))
                    noisy.append(array.array("h", (max(-32768, min(32767, round(x + rng.gauss(0, noise_rms)))) for x in values)))
                emit(entry, voice, "noise15db", noisy, forced)
                fast = []
                for i, values in enumerate(segments):
                    source = audio / f"{entry['id']}-speed-source-{i}.wav"
                    target = audio / f"{entry['id']}-speed-target-{i}.wav"
                    write_wav(source, values)
                    subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(source),
                                    "-af", "atempo=1.2", str(target)], check=True)
                    fast.append(pcm(target))
                emit(entry, voice, "speed1.2", fast, forced)

    for name, noise in [("silence3", 0), ("silence10", 0), ("noise10", 120)]:
        seconds = 3 if name == "silence3" else 10
        rng = random.Random(20261025)
        values = array.array("h", (round(rng.gauss(0, noise)) if noise else 0 for _ in range(seconds * RATE)))
        emit({"id":name,"category":"non_speech","sentences":[],"probes":[]}, "none", "control", [values])
    manifest = {"version":1, "reference":"TTS script; not manually verified human speech",
                "tts":"VOICEVOX Core 0.17.0 CPU16, Kasukabe_Tsumugi and Zundamon, normal, speed1.0",
                "voice_credits":{"Kasukabe_Tsumugi":"VOICEVOX:春日部つむぎ","Zundamon":"VOICEVOX:ずんだもん"},
                "format":"16 kHz mono PCM16", "sentence_gap_seconds":.25,
                "segmentation":"TTS sentence boundaries; split >11.5s at a quiet 200ms interval before 10.5s, else hard cut; no overlap",
                "stress":"15dB white Gaussian noise per segment; atempo1.2 pitch preserved",
                "corpus_sha256":hashlib.sha256((SOURCE/'corpus.json').read_bytes()).hexdigest(),
                "clips":rows}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print("complete", len(rows), "clips", flush=True)


if __name__ == "__main__":
    main()
