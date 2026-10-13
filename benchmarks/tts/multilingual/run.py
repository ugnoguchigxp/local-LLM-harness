#!/usr/bin/env python3
"""Measure warm single-request synthesis with external runtimes and artifacts."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import platform
import random
import resource
import signal
import subprocess
import time
import urllib.request


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--backend', choices=['qwen', 'qwen-optimized', 'kokoro', 'fish', 'voicevox-http', 'qwen-http'], required=True)
    p.add_argument('--model', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--source', type=Path)
    p.add_argument('--device', default='cuda:0')
    p.add_argument('--corpus', type=Path, default=Path(__file__).with_name('corpus.json'))
    p.add_argument('--cases', help='Comma-separated case IDs')
    p.add_argument('--iterations', type=int, default=3)
    p.add_argument('--reference-dir', type=Path)
    p.add_argument('--make-reference', action='store_true')
    p.add_argument('--compile', action='store_true')
    p.add_argument('--stream', action='store_true', help='Measure the deployed Qwen PCM streaming endpoint')
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--timeout', type=int, default=600)
    p.add_argument('--observe-ports', default='8080,58001,58004', help='Local LLM ports to observe outside the synthesis timer')
    args = p.parse_args()
    if args.iterations < 1 or args.timeout < 1:
        p.error('Iterations and timeout must be positive')
    # Match the deployed provider's limit: Inductor opens many compilation files.
    soft_files, hard_files = resource.getrlimit(resource.RLIMIT_NOFILE)
    desired_files = 65535 if hard_files == resource.RLIM_INFINITY else min(65535, hard_files)
    if soft_files < desired_files:
        resource.setrlimit(resource.RLIMIT_NOFILE, (desired_files, hard_files))
    repository = Path(__file__).resolve().parents[3]
    if not args.output.is_absolute() or args.output.resolve() == repository or repository in args.output.resolve().parents:
        p.error('Output must be an absolute path outside the source repository')
    if args.stream and args.backend != 'qwen-http':
        p.error('--stream requires qwen-http')
    if (args.output / 'runs.jsonl').exists():
        p.error('Use a new output directory; appending a second run would mix measurements')
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'audio').mkdir(exist_ok=True)
    corpus = json.loads(args.corpus.read_text())
    if args.cases:
        corpus = [c for c in corpus if c['id'] in args.cases.split(',')]
    if args.backend == 'voicevox-http':
        corpus = [c for c in corpus if c['id'].startswith('ja-')]
    if not corpus:
        p.error('No selected cases')
    if args.source:
        import sys
        sys.path.insert(0, str(args.source.resolve()))
    import numpy as np
    import soundfile as sf
    import torch

    # ROCm 7.13 legacy TorchScript fusion emits conflicting BF16 helper types in
    # DAC's scripted Snake activation. Preserve the operators and disable fusion.
    disable_legacy_fusion = args.backend == 'fish' and bool(torch.version.hip)
    if disable_legacy_fusion:
        torch._C._jit_set_texpr_fuser_enabled(False)
        torch._C._jit_override_can_fuse_on_gpu(False)

    torch.set_num_threads(16)
    torch.set_float32_matmul_precision('high')
    gpu = args.device.startswith('cuda') and not args.backend.endswith('-http')
    dtype = torch.bfloat16 if gpu else torch.float32
    def sync():
        if gpu:
            torch.cuda.synchronize()
    def seed(value):
        random.seed(value)
        np.random.seed(value)
        torch.manual_seed(value)
        if gpu:
            torch.cuda.manual_seed_all(value)
    def write_json(name, value):
        (args.output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    def append(value):
        with (args.output / 'runs.jsonl').open('a') as f:
            f.write(json.dumps(value, ensure_ascii=False) + '\n')
        print(json.dumps(value, ensure_ascii=False), flush=True)
    def deadline(signum, frame):
        raise TimeoutError('Synthesis exceeded request timeout')
    def workloads():
        observed = {}
        for port in filter(None, args.observe_ports.split(',')):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{int(port)}/slots', timeout=1) as response:
                    slots = json.load(response)
                observed[port] = sum(bool(slot.get('is_processing')) for slot in slots)
            except (OSError, ValueError):
                observed[port] = None
        return observed
    signal.signal(signal.SIGALRM, deadline)

    environment = {
        'date': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'arguments': vars(args), 'platform': platform.platform(),
        'torch': torch.__version__, 'hip': torch.version.hip,
        'gpu': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        'dtype': ('float32' if args.backend == 'kokoro' else str(dtype)), 'cpu_threads': torch.get_num_threads(),
        'corpus_sha256': hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
        'corpus': corpus, 'co_resident': True,
        'processes_before': subprocess.check_output(['ps', '-eo', 'pid,args', '--sort=-rss'], text=True).splitlines()[:18],
        'memory_before': Path('/proc/meminfo').read_text(),
        'packages': {d.metadata['Name']: d.version for d in importlib.metadata.distributions()},
        'runtime_environment': {k: os.environ.get(k) for k in ['HF_HOME', 'MIOPEN_FIND_MODE',
            'TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL', 'TORCH_BLAS_PREFER_HIPBLASLT',
            'GPU_MAX_HW_QUEUES', 'TORCHINDUCTOR_CACHE_DIR', 'OMP_NUM_THREADS']},
        'file_descriptor_limit': resource.getrlimit(resource.RLIMIT_NOFILE),
        'rocm_legacy_jit_fusion_disabled': disable_legacy_fusion,
    }
    if args.source:
        environment['source_revision'] = subprocess.check_output(['git', '-C', str(args.source), 'rev-parse', 'HEAD'], text=True).strip()
    if args.backend.endswith('-http'):
        provider_url = 'http://127.0.0.1:8084' if args.backend == 'voicevox-http' else 'http://127.0.0.1:8082'
        with urllib.request.urlopen(provider_url + '/health', timeout=10) as response:
            environment['provider_health'] = json.load(response)
        environment['dtype'] = 'provider-managed'
    # Paths in argparse are deliberately serialized as strings.
    environment['arguments'] = {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()}
    write_json('environment.json', environment)
    load_start = time.perf_counter()
    prompts = {}
    prepare = {}
    if args.backend.startswith('qwen') and not args.backend.endswith('-http'):
        # Same workaround as the deployed gfx1151 adapter; retain stochastic sampling.
        if torch.version.hip and '8060' in torch.cuda.get_device_name(0):
            native_multinomial = torch.multinomial
            def cpu_multinomial(probs, num_samples, replacement=False, *, generator=None, out=None):
                if probs.device.type != 'cuda':
                    return native_multinomial(probs, num_samples, replacement, generator=generator, out=out)
                result = native_multinomial(probs.float().cpu(), num_samples, replacement).to(probs.device)
                if out is not None:
                    out.copy_(result)
                    return out
                return result
            torch.multinomial = cpu_multinomial
        from qwen_tts import Qwen3TTSModel
        model = Qwen3TTSModel.from_pretrained(args.model, device_map=args.device, dtype=dtype, attn_implementation='sdpa')
        if args.backend == 'qwen-optimized':
            model.enable_streaming_optimizations(decode_window_frames=72, use_compile=args.compile,
                use_cuda_graphs=args.compile, compile_mode='max-autotune',
                use_fast_codebook=True, compile_codebook_predictor=args.compile)
        kind = Path(args.model).name.rsplit('-', 1)[-1]
        if kind == 'Base':
            if args.reference_dir is None:
                p.error('Base requires generated reference audio via --reference-dir')
            for lang in {c['language'] for c in corpus}:
                ref = json.loads((args.reference_dir / f'{lang}.json').read_text())
                sync()
                start = time.perf_counter()
                prompts[lang] = model.create_voice_clone_prompt(ref_audio=str(args.reference_dir / f'{lang}.wav'), ref_text=ref['text'], x_vector_only_mode=False)
                sync()
                prepare[lang] = time.perf_counter() - start
        generation = dict(do_sample=True, top_k=50, top_p=1.0, temperature=0.8,
            subtalker_dosample=True, subtalker_top_k=50, subtalker_top_p=1.0,
            subtalker_temperature=0.8, max_new_tokens=1024)
        def synth(case):
            kwargs = dict(text=case['text'], language=case['language'], **generation)
            if kind == 'CustomVoice':
                wavs, sr = model.generate_custom_voice(speaker='Ono_Anna' if case['language'] == 'Japanese' else 'Ryan', instruct=case.get('instruct'), **kwargs)
            elif kind == 'VoiceDesign':
                wavs, sr = model.generate_voice_design(instruct='A clear, natural adult voice, speaking calmly at a normal conversational pace.', **kwargs)
            else:
                wavs, sr = model.generate_voice_clone(voice_clone_prompt=prompts[case['language']], **kwargs)
            return np.asarray(wavs[0]), sr, None, {'instruct': case.get('instruct')} if kind == 'CustomVoice' else {}
    elif args.backend == 'kokoro':
        from kokoro import KModel, KPipeline
        directory = Path(args.model)
        model = KModel(repo_id='hexgrad/Kokoro-82M', config=str(directory / 'config.json'), model=str(directory / 'kokoro-v1_0.pth')).to(args.device).eval()
        pipes = {lang: KPipeline(lang_code='j' if lang == 'Japanese' else 'a', model=model, repo_id='hexgrad/Kokoro-82M') for lang in {c['language'] for c in corpus}}
        voices = {lang: torch.load(directory / 'voices' / ('jf_alpha.pt' if lang == 'Japanese' else 'af_heart.pt'), weights_only=True) for lang in pipes}
        def synth(case):
            start = time.perf_counter()
            chunks, phonemes = [], []
            first = None
            for result in pipes[case['language']](case['text'], voice=voices[case['language']], speed=1.0):
                audio = result.audio.detach().cpu().numpy()
                if len(audio) and first is None:
                    sync()
                    first = time.perf_counter() - start
                chunks.append(audio)
                phonemes.append(result.phonemes)
            return np.concatenate(chunks), 24000, first, {'phonemes': phonemes, 'chunk_count': len(chunks)}
    elif args.backend == 'fish':
        from fish_speech.models.text2semantic.inference import init_model, load_codec_model, generate_long
        from loguru import logger
        logger.remove()
        model, decode = init_model(Path(args.model), args.device, dtype, compile=args.compile)
        codec = load_codec_model(Path(args.model) / 'codec.pth', args.device, dtype)
        def synth(case):
            chunks = []
            first = None
            start = time.perf_counter()
            token_count = 0
            for result in generate_long(model=model, device=args.device, decode_one_token=decode,
                text=case['text'], max_new_tokens=1024, top_p=0.7, top_k=30,
                repetition_penalty=1.2, temperature=0.7, compile=args.compile, chunk_length=200):
                if result.action == 'sample':
                    token_count += result.codes.shape[-1]
                    wav = codec.from_indices(result.codes.unsqueeze(0))[0, 0].float().cpu().numpy()
                    sync()
                    if len(wav) and first is None:
                        first = time.perf_counter() - start
                    chunks.append(wav)
            return np.concatenate(chunks), codec.sample_rate, first, {'semantic_frames': token_count, 'chunk_count': len(chunks), 'reference': 'none-random-voice'}
    else:
        url = 'http://127.0.0.1:8084' if args.backend == 'voicevox-http' else 'http://127.0.0.1:8082'
        def synth(case):
            payload = dict(model=args.model, input=case['text'], language=case['language'],
                voice='Kasukabe_Tsumugi' if args.backend == 'voicevox-http' else ('Ono_Anna' if case['language'] == 'Japanese' else 'Ryan'),
                response_format='pcm' if args.stream else 'wav', speed=1.0, stream=args.stream)
            req = urllib.request.Request(url + '/v1/audio/speech', json.dumps(payload).encode(), {'Content-Type': 'application/json'})
            start = time.perf_counter()
            with urllib.request.urlopen(req, timeout=args.timeout) as response:
                first_bytes = response.read(2) if args.stream else b''
                first = time.perf_counter() - start if first_bytes else None
                audio_bytes = first_bytes + response.read()
            elapsed = time.perf_counter() - start
            if args.stream:
                wav, sr = np.frombuffer(audio_bytes, dtype='<i2').astype('float32') / 32768, 24000
            else:
                wav, sr = sf.read(io.BytesIO(audio_bytes), dtype='float32')
            return wav, sr, first if args.stream else elapsed, {'transport': 'loopback-http',
                'streaming': args.stream, 'includes_wav_encoding': not args.stream, 'server_seed_controlled': False}

    sync()
    write_json('startup.json', {'load_and_prepare_s': time.perf_counter() - load_start, 'clone_prompt_prepare_s': prepare,
        'max_rss_gib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**2})
    # One warmup per language. Initial inference/compilation is recorded separately.
    warm = {c['language']: c for c in reversed(corpus) if c['length'] == 'short'}
    for lang, case in sorted(warm.items()):
        seed(args.seed)
        signal.alarm(args.timeout)
        sync()
        start = time.perf_counter()
        with torch.inference_mode():
            audio, sr, first, extra = synth(case)
        sync()
        signal.alarm(0)
        append({'phase': 'warmup', 'case': case['id'], 'total_s': time.perf_counter() - start, 'audio_s': len(audio) / sr})
        if args.make_reference:
            refdir = args.reference_dir or args.output / 'reference'
            refdir.mkdir(parents=True, exist_ok=True)
            sf.write(refdir / f'{lang}.wav', audio, sr)
            (refdir / f'{lang}.json').write_text(json.dumps({'text': case['text'], 'source_model': args.model, 'synthetic': True}, ensure_ascii=False, indent=2))
    for iteration in range(args.iterations):
        for case in corpus:
            other_workloads = workloads()
            seed(args.seed + iteration)
            signal.alarm(args.timeout)
            sync()
            if gpu:
                torch.cuda.reset_peak_memory_stats()
            start = time.perf_counter()
            try:
                with torch.inference_mode():
                    audio, sr, first, extra = synth(case)
                sync()
                elapsed = time.perf_counter() - start
                if not len(audio) or not np.isfinite(audio).all() or not np.any(audio):
                    raise RuntimeError('Empty, non-finite, or silent waveform')
                duration = len(audio) / sr
                name = f"{case['id']}-{iteration}.wav"
                sf.write(args.output / 'audio' / name, audio, sr)
                append({'phase': 'measured', 'backend': args.backend, 'model': args.model, 'case': case['id'],
                    'language': case['language'], 'length': case['length'], 'iteration': iteration,
                    'seed': None if args.backend.endswith('-http') else args.seed + iteration,
                    'success': True, 'total_s': elapsed, 'audio_s': duration, 'rtf': elapsed / duration,
                    'first_audio_s': first, 'sample_rate': sr, 'audio_file': name,
                    'other_llm_active_slots_before': other_workloads,
                    'peak_allocated_gib': torch.cuda.max_memory_allocated() / 1024**3 if gpu else None,
                    'max_rss_gib': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**2, **extra})
            except Exception as exc:
                append({'phase': 'measured', 'backend': args.backend, 'model': args.model, 'case': case['id'],
                    'iteration': iteration, 'success': False, 'error': repr(exc), 'total_s': time.perf_counter() - start})
                raise
            finally:
                signal.alarm(0)
    write_json('completed.json', {'measured_requests': len(corpus) * args.iterations, 'finished': datetime.datetime.now(datetime.timezone.utc).isoformat()})


if __name__ == '__main__':
    main()
