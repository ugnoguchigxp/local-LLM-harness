#!/usr/bin/env python3
"""Generate Japanese expressive samples and optionally test packed Tiny experts."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import random
import resource
import signal
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
    p.add_argument('--packed-experts', action='store_true')
    p.add_argument('--compact-dense', action='store_true')
    p.add_argument('--kana-input', action='store_true', help='Use the explicit Japanese reading control from the corpus')
    p.add_argument('--corpus', type=Path, default=Path(__file__).with_name('expressive-corpus.json'))
    p.add_argument('--verification', action='store_true', help='Also regenerate prior plain short/numeric samples with seed 42')
    p.add_argument('--skip-expressive', action='store_true')
    args = p.parse_args()
    repo = Path(__file__).resolve().parents[3]
    for path in [args.source, args.model, args.output]:
        if not path.is_absolute() or path.resolve() == repo or repo in path.resolve().parents:
            p.error('Source, model and outputs must be outside the repository')
    if args.packed_experts and args.variant != 'tiny':
        p.error('Expert packing is for tiny only')
    if args.compact_dense and not args.packed_experts:
        p.error('Dense INT8 is an additional experiment on top of packed experts')
    if args.output.exists():
        p.error('Use a new output directory')
    (args.output / 'audio').mkdir(parents=True)
    sys.path.insert(0, str(args.source))
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio
    native_load = torchaudio.load
    def load(path, *a, backend=None, **kw):
        if backend != 'soundfile' or a or kw:
            return native_load(path, *a, backend=backend, **kw)
        wave, sr = sf.read(path, dtype='float32', always_2d=True)
        return torch.from_numpy(wave.T.copy()), sr
    torchaudio.load = load
    torch.set_num_threads(16)
    torch.set_float32_matmul_precision('high')
    def seed():
        random.seed(42); np.random.seed(42); torch.manual_seed(42); torch.cuda.manual_seed_all(42)
    def save(name, value):
        (args.output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    def timeout(_signum, _frame):
        raise TimeoutError('Sample exceeded 600 seconds')
    signal.signal(signal.SIGALRM, timeout)
    reference = args.source / 'data/voice_presets/voice_audio/lingguang.wav'
    reference_text = '诶，你今天有空吗？我们能不能聊聊这件事啊？'
    save('environment.json', {'arguments': {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
        'torch': torch.__version__, 'hip': torch.version.hip, 'device': torch.cuda.get_device_name(),
        'source_revision': subprocess.check_output(['git', '-C', str(args.source), 'rev-parse', 'HEAD'], text=True).strip(),
        'corpus_sha256': hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
        'reference_sha256': hashlib.sha256(reference.read_bytes()).hexdigest(),
        'packages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions()},
        'note': 'Emotion/freeform in Japanese are empirical samples; task does not establish measured emotional accuracy'})
    seed()
    torch.cuda.reset_peak_memory_stats()
    start = time.perf_counter()
    if args.variant == '05b':
        from ming_tts import MingTTS
        model = MingTTS(str(args.model), text_normalization=False)
    else:
        if args.packed_experts:
            from packed_experts import install_cpu_pack_hook
            install_cpu_pack_hook(compact_dense=args.compact_dense)
        from ming_tiny import MingTinyTTS
        model = MingTinyTTS.from_pretrained(str(args.model), moe_backend='loop')
    torch.cuda.synchronize()
    load_row = {'seconds': time.perf_counter() - start,
        'gpu_allocated_bytes': torch.cuda.memory_allocated(),
        'gpu_peak_allocated_bytes': torch.cuda.max_memory_allocated(),
        'gpu_peak_reserved_bytes': torch.cuda.max_memory_reserved(),
        'host_peak_rss_kib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    if args.packed_experts:
        load_row['packed_experts'] = model.engine.model._larm_packed_experts
    save('load.json', load_row)
    rows = []
    cases = [] if args.skip_expressive else json.loads(args.corpus.read_text())
    if args.verification:
        plain = json.loads(Path(__file__).with_name('corpus.json').read_text())
        cases = [dict(c, plain=True, label='量子化前と同一条件の読み確認') for c in plain if c['id'] in ['ja-short','ja-numbers']] + cases
    for case in cases:
        seed()
        row = {'case': case['id'], 'label': case['label'], 'text': case['text'], 'seed': 42,
            'variant': args.variant, 'packed_experts': args.packed_experts,
            'compact_dense': args.compact_dense,
            'emotion': case.get('emotion'), 'instruction': case.get('instruction')}
        spoken_text = case.get('reading', case['text']) if args.kana_input else case['text']
        row['model_input_text'] = spoken_text
        try:
            torch.cuda.reset_peak_memory_stats(); torch.cuda.synchronize()
            start = time.perf_counter(); signal.alarm(600)
            if args.variant == '05b':
                if case.get('plain'):
                    wave = model.synthesize(task='TTS', text=spoken_text, language_id='Japanese',
                        prompt_wav_path=str(reference), prompt_text=reference_text, use_spk_emb=True)
                elif case.get('emotion'):
                    wave = model.synthesize(task='EMOTION', text=spoken_text, language_id='Japanese',
                        controls={'emotion': case['emotion']}, prompt_wav_path=str(reference), use_spk_emb=True)
                else:
                    wave = model.synthesize(task='FREEFORM', text=spoken_text, language_id='Japanese',
                        instruction=case['instruction'], use_zero_spk_emb=True)
            else:
                if case.get('plain'):
                    generated = model.generate(task='multilingual', text=spoken_text, target_language='Japanese',
                        prompt_wav=str(reference), prompt_text=reference_text, seed=42)
                elif case.get('emotion'):
                    generated = model.generate(task='emotion', text=spoken_text, emotion=case['emotion'],
                        prompt_wav=str(reference), seed=42)
                else:
                    generated = model.generate(task='freeform', text=spoken_text, instruction=case['instruction'], seed=42)
                wave = generated.waveform
                row.update(stopped=generated.stopped, decode_steps=len(generated.stop_probabilities))
            torch.cuda.synchronize(); elapsed = time.perf_counter() - start; signal.alarm(0)
            audio = wave.detach().float().cpu().numpy().reshape(-1)
            if not audio.size or not np.isfinite(audio).all() or not np.any(audio):
                raise ValueError('Invalid waveform')
            path = 'audio/' + case['id'] + '.wav'
            sf.write(args.output / path, audio, model.sample_rate, subtype='PCM_16')
            row.update(success=True, seconds=elapsed, audio_seconds=audio.size/model.sample_rate,
                rtf=elapsed/(audio.size/model.sample_rate), audio=path, iteration=0, warmup=False,
                gpu_peak_allocated_bytes=torch.cuda.max_memory_allocated(),
                gpu_peak_reserved_bytes=torch.cuda.max_memory_reserved(), peak=float(np.abs(audio).max()),
                clipping_fraction=float(np.mean(np.abs(audio)>=1)))
        except Exception as exc:
            signal.alarm(0); row.update(success=False, error=repr(exc), traceback=traceback.format_exc())
        rows.append(row)
        with (args.output / 'runs.jsonl').open('a') as f:f.write(json.dumps(row, ensure_ascii=False) + '\n')
        print(json.dumps(row, ensure_ascii=False), flush=True)
        if not row['success']:
            raise RuntimeError('Generation failed; inspect runs.jsonl')
    save('completed.json', {'successes': len(rows), 'load': load_row,
        'note': 'Single illustrative sample per condition; first synthesis includes warmup'})


if __name__ == '__main__':
    main()
