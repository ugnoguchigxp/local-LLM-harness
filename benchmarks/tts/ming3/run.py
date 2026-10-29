#!/usr/bin/env python3
"""Benchmark external Ming releases; keep weights, environment and audio outside git."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import random
import resource
import signal
import statistics
import subprocess
import sys
import time
import traceback


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--model', type=Path, required=True)
    p.add_argument('--variant', choices=['05b', 'tiny'], required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--corpus', type=Path, default=Path(__file__).with_name('corpus.json'))
    p.add_argument('--cases')
    p.add_argument('--iterations', type=int, default=3)
    p.add_argument('--timeout', type=int, default=600)
    p.add_argument('--raw-text', action='store_true')
    p.add_argument('--reference', type=Path)
    p.add_argument('--reference-text')
    args = p.parse_args()
    repo = Path(__file__).resolve().parents[3]
    for path in (args.output, args.source, args.model):
        if not path.is_absolute() or path.resolve() == repo or repo in path.resolve().parents:
            p.error('Model, source and output must be absolute paths outside the repository')
    if args.iterations < 1 or args.timeout < 1:
        p.error('Iterations and timeout must be positive')
    if (args.output / 'runs.jsonl').exists():
        p.error('Use a fresh output directory')
    cases = json.loads(args.corpus.read_text())
    if args.cases:
        cases = [c for c in cases if c['id'] in args.cases.split(',')]
    if not cases:
        p.error('No selected cases')
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'audio').mkdir(exist_ok=True)
    sys.path.insert(0, str(args.source))
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio

    # TorchAudio >=2.9 removed its soundfile backend. Restore the explicitly
    # requested reference reader, preserving float32, channels and sample rate.
    native_load = torchaudio.load
    def soundfile_load(path, *a, backend=None, **kw):
        if backend != 'soundfile' or a or kw:
            return native_load(path, *a, backend=backend, **kw)
        audio, sr = sf.read(path, dtype='float32', always_2d=True)
        return torch.from_numpy(audio.T.copy()), sr
    torchaudio.load = soundfile_load
    torch.set_num_threads(16)
    torch.set_float32_matmul_precision('high')
    reference = args.reference or args.source / 'data/voice_presets/voice_audio/lingguang.wav'
    reference_text = args.reference_text or '诶，你今天有空吗？我们能不能聊聊这件事啊？'

    def save(name, obj):
        (args.output / name).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')
    def append(row):
        with (args.output / 'runs.jsonl').open('a') as f:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
        print(json.dumps(row, ensure_ascii=False), flush=True)
    def observe():
        return {'meminfo': Path('/proc/meminfo').read_text(),
                'gpu_allocated_bytes': torch.cuda.memory_allocated(),
                'gpu_reserved_bytes': torch.cuda.memory_reserved(),
                'processes': subprocess.check_output(['ps', '-eo', 'pid,comm,rss', '--sort=-rss'], text=True).splitlines()[:20]}
    def seed(value):
        random.seed(value)
        np.random.seed(value)
        torch.manual_seed(value)
        torch.cuda.manual_seed_all(value)
    def deadline(_signum, _frame):
        raise TimeoutError('Request exceeded synthesis timeout')
    signal.signal(signal.SIGALRM, deadline)
    save('environment.json', {
        'date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'arguments': {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
        'source_revision': subprocess.check_output(['git', '-C', str(args.source), 'rev-parse', 'HEAD'], text=True).strip(),
        'source_dirty': subprocess.check_output(['git', '-C', str(args.source), 'status', '--short'], text=True),
        'platform': platform.platform(), 'python': sys.version, 'torch': torch.__version__,
        'hip': torch.version.hip, 'device': torch.cuda.get_device_name(), 'dtype': 'bfloat16',
        'threads': torch.get_num_threads(), 'co_resident': True,
        'reference': str(reference), 'reference_sha256': hashlib.sha256(reference.read_bytes()).hexdigest(),
        'reference_text': reference_text,
        'corpus_sha256': hashlib.sha256(args.corpus.read_bytes()).hexdigest(), 'corpus': cases,
        'torchaudio_soundfile_compatibility_reader': True,
        'runtime_environment': {k: os.getenv(k) for k in ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'MIOPEN_FIND_MODE', 'TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL']},
        'packages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions()},
        'before': observe(),
    })
    seed(42)
    start = time.perf_counter()
    if args.variant == '05b':
        from ming_tts import MingTTS
        model = MingTTS(str(args.model), text_normalization=False)
    else:
        from ming_tiny import MingTinyTTS
        model = MingTinyTTS.from_pretrained(str(args.model), moe_backend='loop')
    torch.cuda.synchronize()
    save('load.json', {'seconds': time.perf_counter() - start, **observe()})
    if args.variant == '05b':
        start = time.perf_counter()
        model.prepare_prompt(str(reference), True)
        torch.cuda.synchronize()
        save('prompt-prepare.json', {'seconds': time.perf_counter() - start, 'cached_for_measurement': True})
    else:
        save('prompt-prepare.json', {'cached_for_measurement': False, 'note': 'Public tiny API encodes reference on each call; included in timing'})

    rows = []
    for warmup, case, iteration in [(True, cases[0], -1)] + [
        (False, case, iteration) for case in cases for iteration in range(args.iterations)
    ]:
        seed(42 if warmup else 42 + iteration)
        row = {'case': case['id'], 'text': case['text'], 'iteration': iteration,
               'seed': 42 if warmup else 42 + iteration, 'warmup': warmup}
        if args.variant == '05b':
            row['fragments'] = [case['text']] if args.raw_text else model.prepare_text(case['text'], 'TTS', 'Japanese', 24)
        try:
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()
            signal.alarm(args.timeout)
            start = time.perf_counter()
            if args.variant == '05b':
                wave = model.synthesize(task='TTS', text=case['text'], language_id='Japanese',
                    prompt_wav_path=str(reference), prompt_text=reference_text,
                    use_spk_emb=True, raw_text=args.raw_text)
            else:
                generated = model.generate(task='multilingual', text=case['text'],
                    target_language='Japanese', prompt_wav=str(reference),
                    prompt_text=reference_text, seed=row['seed'])
                wave = generated.waveform
                row['decode_steps'] = len(generated.stop_probabilities)
                row['stopped'] = generated.stopped
                row['prompt_token_count'] = generated.prompt_token_count
            torch.cuda.synchronize()
            elapsed = time.perf_counter() - start
            signal.alarm(0)
            audio = wave.detach().float().cpu().numpy().reshape(-1)
            if not np.isfinite(audio).all() or not audio.size or not np.any(audio):
                raise ValueError('Empty, non-finite or silent waveform')
            duration = audio.size / model.sample_rate
            name = f"{case['id']}-{'warmup' if warmup else iteration}.wav"
            sf.write(args.output / 'audio' / name, audio, model.sample_rate, subtype='PCM_16')
            row.update(success=True, seconds=elapsed, audio_seconds=duration, rtf=elapsed / duration,
                sample_rate=model.sample_rate, audio='audio/' + name,
                peak=float(np.abs(audio).max()), rms=float(np.sqrt(np.mean(audio ** 2))),
                clipping_fraction=float(np.mean(np.abs(audio) >= 1)),
                gpu_peak_allocated_bytes=torch.cuda.max_memory_allocated(),
                gpu_peak_reserved_bytes=torch.cuda.max_memory_reserved(),
                host_peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
        except Exception as exc:
            signal.alarm(0)
            row.update(success=False, error=repr(exc), traceback=traceback.format_exc())
        rows.append(row)
        append(row)
        if not row['success']:
            raise RuntimeError('Synthesis failed; inspect runs.jsonl before continuing')
    measured = [r for r in rows if r['success'] and not r['warmup']]
    summary = {'successes': len(measured), 'warmup': rows[0], 'after': observe(), 'cases': {}}
    for case in cases:
        group = [r for r in measured if r['case'] == case['id']]
        summary['cases'][case['id']] = {'seconds_median': statistics.median(r['seconds'] for r in group),
            'rtf_median': statistics.median(r['rtf'] for r in group),
            'audio_seconds_median': statistics.median(r['audio_seconds'] for r in group)}
    summary['rtf_median'] = statistics.median(r['rtf'] for r in measured)
    summary['aggregate_rtf'] = sum(r['seconds'] for r in measured) / sum(r['audio_seconds'] for r in measured)
    save('completed.json', summary)


if __name__ == '__main__':
    main()
