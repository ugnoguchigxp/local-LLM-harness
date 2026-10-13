#!/usr/bin/env python3
"""Record PCM arrival times and estimate playback buffer needs after full-text input."""
import argparse
import json
from pathlib import Path
import time
import urllib.request
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--corpus', type=Path, default=Path(__file__).with_name('corpus.json'))
    parser.add_argument('--cases', default='ja-short,ja-medium,en-medium')
    parser.add_argument('--iterations', type=int, default=2)
    parser.add_argument('--url', default='http://127.0.0.1:8082')
    parser.add_argument('--model', default='qwen3-tts-expressive')
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    if not args.output.is_absolute() or args.output.resolve() == repository or repository in args.output.resolve().parents:
        parser.error('Output must be outside the source repository')
    if args.iterations < 1 or args.output.exists():
        parser.error('Use positive iterations and a new output directory')
    corpus = [c for c in json.loads(args.corpus.read_text()) if c['id'] in args.cases.split(',')]
    if not corpus:
        parser.error('No selected cases')
    args.output.mkdir(parents=True)
    with urllib.request.urlopen(args.url + '/health', timeout=10) as response:
        health = json.load(response)
    (args.output / 'environment.json').write_text(json.dumps(dict(provider_health=health,
        corpus=corpus, sample_rate=24000, bytes_per_second=48000, text_input='complete JSON string',
        transport='loopback HTTP; read1 events are client reads, not codec frame boundaries'), ensure_ascii=False, indent=2))
    for iteration in range(args.iterations):
        for case in corpus:
            payload = dict(model=args.model, input=case['text'], language=case['language'],
                voice='Ono_Anna' if case['language'] == 'Japanese' else 'Ryan', response_format='pcm', stream=True)
            request = urllib.request.Request(args.url + '/v1/audio/speech', json.dumps(payload).encode(), {'Content-Type': 'application/json'})
            start = time.perf_counter()
            chunks, events = [], []
            with urllib.request.urlopen(request, timeout=600) as response:
                while chunk := response.read1(65536):
                    events.append(dict(arrival_s=time.perf_counter()-start, bytes=len(chunk)))
                    chunks.append(chunk)
            total = time.perf_counter()-start
            audio = b''.join(chunks)
            if not events or len(audio) % 2:
                raise RuntimeError('Missing or incomplete PCM')
            first = events[0]['arrival_s']
            duration_before = 0.0
            minimum_start = first
            playback_end = first + 0.15
            gaps = 0.0
            for event in events:
                minimum_start = max(minimum_start, event['arrival_s']-duration_before)
                gaps += max(0.0, event['arrival_s']-playback_end)
                playback_end = max(playback_end, event['arrival_s']) + event['bytes']/48000
                duration_before += event['bytes']/48000
            row = dict(case=case['id'], iteration=iteration, first_audio_s=first, total_s=total,
                audio_s=len(audio)/48000, rtf=total/(len(audio)/48000), client_read_events=len(events),
                minimum_no_gap_playback_start_s=minimum_start,
                extra_buffer_after_first_s=minimum_start-first,
                simulated_gaps_with_150ms_buffer_s=gaps, events=events)
            with wave.open(str(args.output / f"{case['id']}-{iteration}.wav"), 'wb') as handle:
                handle.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
                handle.writeframes(audio)
            with (args.output / 'arrival-timing.jsonl').open('a') as handle:
                handle.write(json.dumps(row) + '\n')
            print(json.dumps({k:v for k,v in row.items() if k != 'events'}), flush=True)
    (args.output / 'completed.json').write_text(json.dumps({'measured_requests': len(corpus)*args.iterations}))


if __name__ == '__main__':
    main()
