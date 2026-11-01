#!/usr/bin/env python3
"""Temporarily start Audio8, compare identical HTTP requests with VOICEVOX, then stop Audio8."""
import argparse
import html
import io
import json
from pathlib import Path
import socket
import subprocess
import time
import urllib.request
import wave


def get(url):
    with urllib.request.urlopen(url, timeout=3) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8097)
    parser.add_argument('--python', default='/srv/ai/apps/audio8-tts-runtime/.venv/bin/python')
    parser.add_argument('--voicevox-url', default='http://127.0.0.1:8084')
    parser.add_argument('--audio8-voices', default='audio8-ja-butler-v1,audio8-ja-02')
    parser.add_argument('--voicevox-voices', default='Kasukabe_Tsumugi,Kurono_Takehiro')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    output = args.output.resolve()
    if output == repo or repo in output.parents:
        parser.error('Use an external results directory')
    if not 1024 <= args.port <= 65535:
        parser.error('Use an unprivileged local port')
    with socket.socket() as check:
        check.bind(('127.0.0.1', args.port))
    voicevox_health = get(args.voicevox_url+'/health')
    if voicevox_health.get('status') not in ('ok', 'healthy'):
        raise RuntimeError('VOICEVOX is not ready')
    output.mkdir(parents=True, exist_ok=True)
    (output/'audio').mkdir(exist_ok=True)
    rows = []
    corpus = json.loads((repo/'benchmarks/tts/audio8/corpus.json').read_text())
    (output/'corpus.json').write_text(json.dumps(corpus, ensure_ascii=False, indent=2))
    url = f'http://127.0.0.1:{args.port}'
    evidence = {'audio8_temporary': True, 'voicevox_before': voicevox_health}
    with (output/'provider.log').open('w') as log:
        child = subprocess.Popen([args.python, '-B', '-m', 'uvicorn', 'audio8_api:app', '--host', '127.0.0.1',
                                  '--port', str(args.port), '--workers', '1', '--no-access-log'],
                                 cwd=repo/'apps/audio8-tts', stdout=log, stderr=log)
        try:
            start = time.monotonic()
            while True:
                if child.poll() is not None:
                    raise RuntimeError('Temporary Audio8 provider failed; inspect provider.log')
                try:
                    if get(url+'/health').get('ready'): break
                except OSError: pass
                if time.monotonic()-start > 90: raise TimeoutError('Audio8 startup timed out')
                time.sleep(.25)
            evidence['startup_seconds'] = time.monotonic()-start
            evidence['audio8_health'] = get(url+'/health')
            evidence['audio8_voices'] = get(url+'/v1/audio/voices')
            configs = [(url, 'audio8-tts-realistic-0.6b', v) for v in args.audio8_voices.split(',')]
            configs += [(args.voicevox_url, 'voicevox-core', v) for v in args.voicevox_voices.split(',')]
            for case in corpus:
                for endpoint, model, voice in configs:
                    body = {'model': model, 'input': case['text'], 'voice': voice, 'response_format': 'wav',
                            'speed': 1, 'pitch_scale': 0, 'intonation_scale': 1, 'stream': False, 'language': 'ja'}
                    req = urllib.request.Request(endpoint+'/v1/audio/speech', json.dumps(body).encode(), {'Content-Type': 'application/json'})
                    t = time.perf_counter()
                    with urllib.request.urlopen(req, timeout=120) as response:
                        content = response.read()
                        media_type = response.headers.get_content_type()
                    elapsed = time.perf_counter()-t
                    if media_type != 'audio/wav': raise RuntimeError('Expected a WAV response')
                    with wave.open(io.BytesIO(content)) as wav:
                        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (24000, 1, 2)
                        duration = wav.getnframes()/24000
                        assert duration > 0
                    name = f'{case["id"]}-{voice}.wav'
                    (output/'audio'/name).write_bytes(content)
                    row = {**case, 'model': model, 'voice': voice, 'path': 'audio/'+name,
                           'http_seconds': elapsed, 'audio_seconds': duration, 'rtf': elapsed/duration}
                    rows.append(row)
                    (output/'comparison.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
                    print(json.dumps(row, ensure_ascii=False), flush=True)
        finally:
            child.terminate()
            try: child.wait(timeout=100)
            except subprocess.TimeoutExpired: child.kill();child.wait()
            evidence['audio8_stopped'] = child.poll() is not None
            evidence['voicevox_after'] = get(args.voicevox_url+'/health')
            (output/'lifecycle.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    e = html.escape
    parts = ['<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Audio8／VOICEVOX比較</title><style>body{font-family:system-ui;max-width:1100px;margin:32px auto;padding:0 20px;line-height:1.8;background:#f5f4ef}article{background:white;padding:20px;border-radius:12px;margin:16px 0}.voices{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}audio{width:100%}small{color:#555}</style><h1>Audio8／VOICEVOX 同文比較</h1><p>両方とも24 kHz・mono・PCM16 WAV、速度1、音高変更なし、抑揚設定1。同じAPIを使用。Audio8は固定参照声を使用し、比較後に停止しました。VOICEVOXの既存設定は継続しています。</p><p>Audio8の話者は独自の声で、VOICEVOXのキャラクターとの対応付けではありません。既定の執事声は1.43倍テンポと胸のEQを含むpresetで、APIのspeed=1はこのpresetをそのまま使う意味です。生成時間は全文完成までのHTTP時間です。音声長や実行deviceも異なるため、声・読み・抑揚と待ち時間を分けて比較してください。</p>']
    for case in corpus:
        parts.append(f'<article><h2>{e(case["label"])}</h2><p>{e(case["text"])}</p><div class="voices">')
        for row in [r for r in rows if r['id'] == case['id']]:
            parts.append(f'<div><strong>{e(row["voice"])}</strong><br><audio controls preload="none" src="{e(row["path"])}"></audio><small>音声{row["audio_seconds"]:.2f}秒／生成{row["http_seconds"]:.2f}秒</small></div>')
        parts.append('</div></article>')
    parts.append('</html>')
    (output/'listening.html').write_text('\n'.join(parts))
    print(output/'listening.html', flush=True)


if __name__ == '__main__': main()
