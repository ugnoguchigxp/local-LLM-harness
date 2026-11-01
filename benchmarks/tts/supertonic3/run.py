#!/usr/bin/env python3
"""Generate Japanese Supertonic 3 samples using an external official checkout."""
import argparse
import hashlib
import html
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import time


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--threads', type=int, default=4)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    for path in (args.runtime, args.model, args.output):
        if not path.is_absolute() or path.resolve().is_relative_to(repo):
            parser.error('Runtime, model and output must use absolute paths outside this repository')
    if args.threads < 1:
        parser.error('--threads must be positive')
    args.output.mkdir(parents=True, exist_ok=False)
    # Limit NumPy/OpenMP as well as each ONNX session's worker pool.
    os.environ['OMP_NUM_THREADS'] = str(args.threads)
    os.environ['OPENBLAS_NUM_THREADS'] = str(args.threads)
    sys.path.insert(0, str(args.runtime / 'py'))
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    import helper

    started = time.perf_counter()
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = args.threads
    opts.inter_op_num_threads = 1
    opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    model_path = str(args.model / 'onnx')
    sessions = helper.load_onnx_all(model_path, opts, ['CPUExecutionProvider'])
    engine = helper.TextToSpeech(
        helper.load_cfgs(model_path), helper.load_text_processor(model_path), *sessions
    )
    load_s = time.perf_counter() - started
    peak_after_load_mib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    styles = {voice: helper.load_voice_style([str(args.model / 'voice_styles' / f'{voice}.json')])
              for voice in ('F1', 'F2', 'M1', 'M2')}
    np.random.seed(41)
    started = time.perf_counter()
    engine('音声の準備ができました。', 'ja', styles['F1'], 8, 1.05)
    warmup_s = time.perf_counter() - started
    peak_after_warmup_mib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    corpus_path = Path(__file__).with_name('corpus.json')
    corpus = json.loads(corpus_path.read_text())
    model_files = [dict(path=str(p.relative_to(args.model)), bytes=p.stat().st_size,
                        sha256=sha256_file(p))
                   for p in sorted(args.model.rglob('*'))
                   if p.is_file() and '.cache' not in p.parts]
    result = dict(
        model='supertonic-3', precision='FP32', device='CPUExecutionProvider',
        model_repository='supertone-oss-archive/supertonic-3',
        model_revision='aafc6e32416a594460b32413efc49d7fe4ce6d46',
        runtime_revision=subprocess.check_output(
            ['git', '-C', str(args.runtime), 'rev-parse', 'HEAD'], text=True).strip(),
        larm_revision=subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip(),
        runtime=str(args.runtime), model_dir=str(args.model), threads=args.threads,
        inter_op_threads=1, sample_rate=engine.sample_rate, speed=1.05, seed=42,
        load_s=load_s, warmup_s=warmup_s, python=platform.python_version(),
        peak_after_load_mib=peak_after_load_mib, peak_after_warmup_mib=peak_after_warmup_mib,
        platform=platform.platform(),
        cpu=next((line.split(':', 1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines()
                  if line.startswith('model name')), 'unknown'),
        versions={p: importlib.metadata.version(p) for p in ('onnxruntime', 'numpy', 'soundfile')},
        corpus_sha256=hashlib.sha256(corpus_path.read_bytes()).hexdigest(),
        model_files=model_files, rows=[],
        timing_note='Warm sequential runs with existing host services active; file writing excluded. '
                    'first_chunk_ready_s is a local waveform readiness time, not HTTP/playback latency. '
                    'Each chunk is trimmed before concatenation; chunking follows the official helper. '
                    'RSS is cumulative process peak on Linux, not per-request memory allocation.'
    )
    for case in corpus:
        np.random.seed(42)
        chunks = helper.chunk_text(case['text'], max_len=120)
        parts = []
        started = time.perf_counter()
        first_chunk_ready_s = None
        for chunk in chunks:
            wav, duration = engine(chunk, 'ja', styles[case['voice']], case.get('steps', 8), 1.05)
            # Trim each chunk to its predicted duration before joining, so padded
            # vocoder output cannot accumulate and truncate the final paragraph.
            parts.append(wav[0, :int(engine.sample_rate * float(duration[0]))])
            if first_chunk_ready_s is None:
                first_chunk_ready_s = time.perf_counter() - started
        silence = np.zeros(int(0.3 * engine.sample_rate), dtype=np.float32)
        joined = []
        for index, part in enumerate(parts):
            if index:
                joined.append(silence)
            joined.append(part)
        waveform = np.concatenate(joined)
        elapsed_s = time.perf_counter() - started
        if not np.isfinite(waveform).all() or not len(waveform):
            raise RuntimeError(f'Invalid waveform for {case["id"]}')
        audio = args.output / f'{case["id"]}.wav'
        sf.write(audio, waveform, engine.sample_rate, subtype='PCM_16')
        info = sf.info(audio)
        if info.samplerate != 44100 or info.channels != 1 or info.subtype != 'PCM_16':
            raise RuntimeError(f'Unexpected WAV format: {info}')
        row = dict(case, steps=case.get('steps', 8), chunks=len(chunks),
                   chunk_texts=chunks, elapsed_s=elapsed_s,
                   first_chunk_ready_s=first_chunk_ready_s, audio_s=info.duration,
                   rtf=elapsed_s / info.duration, audio=str(audio),
                   peak=float(np.max(np.abs(waveform))),
                   rms=float(np.sqrt(np.mean(waveform ** 2))),
                   clipping_fraction=float(np.mean(np.abs(waveform) >= 1.0)),
                   sha256=sha256_file(audio),
                   cumulative_peak_rss_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
        result['rows'].append(row)
        (args.output / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(row, ensure_ascii=False), flush=True)

    sections = []
    for row in result['rows']:
        sections.append(
            f'<section><h2>{html.escape(row["label"])}</h2>'
            f'<p>{html.escape(row["text"]).replace(chr(10), "<br>")}</p>'
            f'<audio controls preload="none" src="{Path(row["audio"]).name}"></audio>'
            f'<p>生成 {row["elapsed_s"]:.3f} 秒 / 音声 {row["audio_s"]:.2f} 秒 / '
            f'RTF {row["rtf"]:.3f} / {row["steps"]} ステップ</p></section>'
        )
    (args.output / 'listen.html').write_text(
        '<!doctype html><html lang="ja"><meta charset="utf-8">'
        '<title>Supertonic 3 日本語試聴</title><h1>Supertonic 3 日本語試聴</h1>'
        f'<p>公式プリセットによるAI生成音声。CPU / FP32 / {args.threads}スレッド / 44.1 kHz。</p>'
        + ''.join(sections) + '</html>')
    print(json.dumps(dict(load_s=load_s, warmup_s=warmup_s, samples=len(result['rows']),
                          peak_rss_mib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)), flush=True)


if __name__ == '__main__':
    main()
