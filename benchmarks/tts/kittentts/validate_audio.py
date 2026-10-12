"""Reading smoke check against the existing local whisper.cpp service.

Run after timing completes. ASR agreement is not a voice-quality/MOS score.
This submits transcription requests only; it does not load or swap a model.
"""
import argparse
import json
from pathlib import Path
import re
import time
import urllib.request


def words(text):
    return re.findall(r"[a-z0-9]+", text.lower().replace("'", "").replace("’", ""))


def distance(a, b):
    previous = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        row = [i]
        for j, y in enumerate(b, 1):
            row.append(min(row[-1] + 1, previous[j] + 1, previous[j - 1] + (x != y)))
        previous = row
    return previous[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--url", default="http://127.0.0.1:8085/v1/audio/transcriptions")
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    if not args.input.is_absolute() or args.input.resolve() == repository or repository in args.input.resolve().parents:
        parser.error("Use an external audio directory")
    corpus = json.loads(Path(__file__).with_name("corpus.json").read_text())
    rows = []
    for file in sorted(args.input.glob("*.wav")):
        voice, case = file.stem.split("-", 1)
        if case.startswith("speed-"):
            continue
        expected = corpus["numbers"] if case == "numbers-clean" else corpus[case]
        boundary = "KittenTTS-reading-validation"
        parts = []
        for key, value in {"language": "ja" if case.startswith("japanese") else "en",
                           "response_format": "json", "temperature": "0.0"}.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + file.read_bytes() + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        request = urllib.request.Request(args.url, b"".join(parts),
                                         {"Content-Type": "multipart/form-data; boundary=" + boundary})
        row = dict(voice=voice, case=case, expected=expected, audio=str(file), asr_url=args.url)
        t = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.load(response)
            transcript = result["text"].strip()
            row.update(success=True, transcript=transcript, asr_wall_s=time.perf_counter() - t)
            if case not in ["numbers", "numbers-clean", "japanese_negative_control"]:
                reference = words(expected)
                row.update(word_errors=distance(reference, words(transcript)), reference_words=len(reference))
        except Exception as error:
            row.update(success=False, error=repr(error))
        rows.append(row)
        (args.input / "reading-smoke.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2))
        print(json.dumps(row, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
