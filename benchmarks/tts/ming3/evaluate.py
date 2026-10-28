#!/usr/bin/env python3
"""Generate a VOICEVOX control, then independently transcribe completed TTS runs."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import statistics
import subprocess
import time
import unicodedata
import urllib.request


def normalized(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).lower()
                   if not c.isspace() and unicodedata.category(c)[0] not in 'PZ')


def distance(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        row = [i]
        for j, y in enumerate(b, 1):
            row.append(min(row[-1] + 1, prev[j] + 1, prev[j - 1] + (x != y)))
        prev = row
    return prev[-1]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--corpus', type=Path, default=Path(__file__).with_name('corpus.json'))
    p.add_argument('--baseline', action='store_true')
    p.add_argument('--transcribe', action='store_true')
    p.add_argument('--qwen-driver', type=Path, default=Path('/srv/ai/apps/asr-eval-20261012/qwen-native-driver'))
    p.add_argument('--qwen-model', type=Path, default=Path('/srv/ai/models/qwen-asr/Qwen3-ASR-1.7B'))
    args = p.parse_args()
    repo = Path(__file__).resolve().parents[3]
    if not args.root.is_absolute() or args.root.resolve() == repo or repo in args.root.resolve().parents:
        p.error('Results must be outside the source repository')
    import soundfile as sf
    import numpy as np
    import pyopenjtalk
    cases = json.loads(args.corpus.read_text())
    if args.baseline:
        directory = args.root / 'voicevox-cpu'
        if directory.exists():
            p.error('Baseline already exists')
        (directory / 'audio').mkdir(parents=True)
        with urllib.request.urlopen('http://127.0.0.1:8084/health', timeout=10) as res:
            health = json.load(res)
        (directory / 'environment.json').write_text(json.dumps({'health': health,
            'credit': 'VOICEVOX:春日部つむぎ', 'measurement': 'loopback HTTP, includes WAV serialization and transfer',
            'corpus_sha256': hashlib.sha256(args.corpus.read_bytes()).hexdigest()}, ensure_ascii=False, indent=2))
        rows = []
        for warmup, case, iteration in [(True, cases[0], -1)] + [
            (False, c, i) for c in cases for i in range(3)
        ]:
            request = urllib.request.Request('http://127.0.0.1:8084/v1/audio/speech',
                json.dumps({'model': 'voicevox-core', 'input': case['text'], 'language': 'Japanese',
                    'voice': 'Kasukabe_Tsumugi', 'response_format': 'wav', 'speed': 1.0}).encode(),
                {'Content-Type': 'application/json'})
            start = time.perf_counter()
            with urllib.request.urlopen(request, timeout=120) as res:
                wav = res.read()
            elapsed = time.perf_counter() - start
            audio, sr = sf.read(io.BytesIO(wav))
            name = f"{case['id']}-{'warmup' if warmup else iteration}.wav"
            (directory / 'audio' / name).write_bytes(wav)
            duration = len(audio) / sr
            row = {'case': case['id'], 'text': case['text'], 'iteration': iteration,
                'warmup': warmup, 'success': True, 'seconds': elapsed, 'audio_seconds': duration,
                'rtf': elapsed / duration, 'audio': 'audio/' + name, 'sample_rate': sr}
            with (directory / 'runs.jsonl').open('a') as f:
                f.write(json.dumps(row, ensure_ascii=False) + '\n')
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
        measured = [r for r in rows if not r['warmup']]
        summary = {'successes': len(measured), 'rtf_median': statistics.median(r['rtf'] for r in measured), 'cases': {}}
        for case in cases:
            group = [r for r in measured if r['case'] == case['id']]
            summary['cases'][case['id']] = {'seconds_median': statistics.median(r['seconds'] for r in group),
                'rtf_median': statistics.median(r['rtf'] for r in group),
                'audio_seconds_median': statistics.median(r['audio_seconds'] for r in group)}
        (directory / 'completed.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    if not args.transcribe:
        return
    output = args.root / 'readings.jsonl'
    done = {(r['configuration'], r['case'], r['iteration'], r['recognizer']) for r in
            map(json.loads, output.read_text().splitlines()) if r.get('success')} if output.exists() else set()
    with (args.root / 'qwen-asr.log').open('a') as log:
        worker = subprocess.Popen([str(args.qwen_driver), str(args.qwen_model), '16'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            ready = json.loads(worker.stdout.readline())
            if not ready.get('ready'):
                raise RuntimeError(f'Qwen ASR initialization failed: {ready}')
            metadata = {'qwen': {'driver': str(args.qwen_driver), 'model': str(args.qwen_model), **ready},
                'whisper': {'url': 'http://127.0.0.1:8085', 'model': 'large-v3-turbo-q5_0'},
                'interpretation': 'ASR agreement and diagnostic character errors; not human pronunciation accuracy or MOS',
                'kana_normalizer': 'pyopenjtalk.g2p(kana=True); dictionary errors remain possible'}
            (args.root / 'asr-metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
            for directory in sorted(args.root.iterdir()):
                if not directory.is_dir() or not (directory / 'completed.json').exists():
                    continue
                rows = [json.loads(line) for line in (directory / 'runs.jsonl').read_text().splitlines()]
                for row in rows:
                    if row.get('warmup') or not row.get('success'):
                        continue
                    source = directory / row['audio']
                    converted = directory / 'asr16k' / source.name
                    converted.parent.mkdir(exist_ok=True)
                    if not converted.exists():
                        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-ar', '16000', '-ac', '1',
                            '-c:a', 'pcm_s16le', str(converted)], check=True)
                    for recognizer in ['qwen-native', 'whisper-turbo']:
                        key = (directory.name, row['case'], row['iteration'], recognizer)
                        if key in done:
                            continue
                        record = dict(zip(['configuration', 'case', 'iteration', 'recognizer'], key))
                        record.update(expected=row['text'], audio=str(source), audio_sha256=hashlib.sha256(source.read_bytes()).hexdigest())
                        try:
                            start = time.perf_counter()
                            if recognizer == 'qwen-native':
                                worker.stdin.write(str(converted) + '\n')
                                worker.stdin.flush()
                                response = json.loads(worker.stdout.readline())
                                text = response['text']
                            else:
                                boundary = 'larm-ming3-audio-only'
                                body = b''
                                for k, v in {'model': 'whisper-1', 'language': 'ja', 'response_format': 'json', 'temperature': '0'}.items():
                                    body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
                                body += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
                                body += converted.read_bytes() + f'\r\n--{boundary}--\r\n'.encode()
                                request = urllib.request.Request('http://127.0.0.1:8085/v1/audio/transcriptions', body,
                                    {'Content-Type': 'multipart/form-data; boundary=' + boundary})
                                with urllib.request.urlopen(request, timeout=180) as res:
                                    response = json.load(res)
                                text = response['text']
                            ref, hyp = normalized(row['text']), normalized(text)
                            ref_kana = normalized(pyopenjtalk.g2p(row['text'], kana=True))
                            hyp_kana = normalized(pyopenjtalk.g2p(text, kana=True))
                            record.update(success=True, text=text, seconds=time.perf_counter() - start,
                                edits=distance(ref, hyp), reference_characters=len(ref), cer=distance(ref, hyp) / max(1, len(ref)),
                                reference_kana=ref_kana, recognized_kana=hyp_kana,
                                kana_edits=distance(ref_kana, hyp_kana), kana_reference_characters=len(ref_kana),
                                kana_cer=distance(ref_kana, hyp_kana) / max(1, len(ref_kana)))
                        except Exception as exc:
                            record.update(success=False, error=repr(exc))
                        with output.open('a') as f:
                            f.write(json.dumps(record, ensure_ascii=False) + '\n')
                        print(json.dumps(record, ensure_ascii=False), flush=True)
        finally:
            worker.stdin.close()
            try:
                worker.wait(timeout=15)
            except subprocess.TimeoutExpired:
                worker.terminate()
                worker.wait(timeout=15)


if __name__ == '__main__':
    main()
