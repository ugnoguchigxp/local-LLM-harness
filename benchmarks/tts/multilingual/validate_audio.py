#!/usr/bin/env python3
"""Transcribe generated samples after timing; this is a reading smoke check, not MOS."""
import argparse
import json
from pathlib import Path
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--url', default='http://127.0.0.1:8081')
    parser.add_argument('--model', default='qwen3-asr-1.7b')
    parser.add_argument('--corpus', type=Path, default=Path(__file__).with_name('corpus.json'))
    parser.add_argument('--cases', default='ja-short,ja-medium,ja-long,en-short,en-medium,en-long,mixed-short,mixed-medium')
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    if not args.input.is_absolute() or args.input.resolve() == repository or repository in args.input.resolve().parents:
        parser.error('Use an external results directory')
    corpus = {c['id']: c for c in json.loads(args.corpus.read_text())}
    with urllib.request.urlopen(args.url + '/health', timeout=10) as response:
        health = json.load(response)
    boundary = 'LARM-TTS-generated-sample-validation'
    output = args.input / 'reading-smoke.jsonl'
    done = {(r['configuration'], r['case']) for r in map(json.loads, output.read_text().splitlines()) if r.get('success')} if output.exists() else set()
    for directory in sorted(args.input.iterdir()):
        if not directory.is_dir() or not (directory / 'completed.json').exists():
            continue
        for case in args.cases.split(','):
            audio = directory / 'audio' / f'{case}-0.wav'
            if not audio.exists() or (directory.name, case) in done:
                continue
            fields = {'model': args.model, 'response_format': 'json'}
            if case.startswith('en-'):
                fields['language'] = 'English'
            elif case.startswith('ja-'):
                fields['language'] = 'Japanese'
            parts = []
            for name, value in fields.items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + audio.read_bytes() + b'\r\n')
            parts.append(f'--{boundary}--\r\n'.encode())
            req = urllib.request.Request(args.url + '/v1/audio/transcriptions', b''.join(parts), {'Content-Type': 'multipart/form-data; boundary=' + boundary})
            row = dict(configuration=directory.name, case=case, expected=corpus[case]['text'], asr_health=health)
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(req, timeout=120) as response:
                        result = json.load(response)
                    row.update(success=True, transcription=result)
                    break
                except urllib.error.HTTPError as exc:
                    if exc.code == 429 and attempt < 3:
                        time.sleep(2)
                        continue
                    row.update(success=False, error=str(exc), detail=exc.read().decode(errors='replace'))
                    break
                except OSError as exc:
                    row.update(success=False, error=str(exc))
                    break
            with output.open('a') as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + '\n')
            print(json.dumps(row, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
