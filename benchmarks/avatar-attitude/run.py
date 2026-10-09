"""Independent CPU experiment: each repetition is a fresh process, sequential models."""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time
from common import ROOT, CRITERIA, INSTRUCTION, LABELS, format_input, load_examples, require_external, sha256, write_json


def memory():
    values = {}
    for filename in ['smaps_rollup', 'status']:
        for line in Path('/proc/self/' + filename).read_text().splitlines():
            parts = line.split()
            if parts and parts[0].rstrip(':') in ['Rss', 'Pss', 'Swap', 'SwapPss', 'VmRSS', 'VmHWM', 'VmSwap', 'Threads']:
                values[parts[0].rstrip(':')] = int(parts[1])
    return values


def system_snapshot():
    return {'loadavg': Path('/proc/loadavg').read_text().strip(),
            'meminfo': Path('/proc/meminfo').read_text(), 'pressure_cpu': Path('/proc/pressure/cpu').read_text(),
            'pressure_memory': Path('/proc/pressure/memory').read_text()}


def worker(args):
    if args.onnx:
        from onnx_runtime import AttitudeModel
    else:
        import torch
        from runtime import AttitudeModel
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        torch.manual_seed(1729)
    sandbox = require_external(args.sandbox)
    run = require_external(args.output)
    run.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((sandbox / 'artifacts' / (args.model + '-manifest.json')).read_text())
    # Validation is outside the model-load measurement.
    for name, info in manifest['files'].items():
        file = Path(manifest['path']) / name
        if sha256(file) != info['sha256']:
            raise ValueError('artifact changed: ' + name)
    all_rows = load_examples(args.data)
    rows = [r for r in all_rows if r['split'] in args.splits]
    if args.method == 'head':
        if not args.head:
            raise ValueError('a separately trained head is required')
        head = json.loads(Path(args.head).read_text())
        allowed_ids = {r['id'] for r in all_rows if r['split'] == 'train'}
        allowed_calibration = {r['id'] for r in all_rows if r['split'] == 'calibration'}
        if (not head['train_only'] or not set(head['train_ids']) <= allowed_ids
                or not set(head.get('calibration_ids', [])) <= allowed_calibration
                or head['data_sha256'] != sha256(args.data)):
            raise ValueError('head training provenance or data split mismatch')
    baseline = memory()
    host_before = system_snapshot()
    started = time.perf_counter()
    classifier = AttitudeModel(args.model, manifest, args.method,
                               Path(args.head) if args.head else None, Path(args.onnx) if args.onnx else None)
    load_ms = (time.perf_counter() - started) * 1000
    loaded = memory()
    peak = dict(loaded)
    name = f'{args.model}-{args.method}' + ('-' + args.tag if args.tag else '') + '-' + ('int8' if args.onnx else 'fp32')
    out = run / f'{name}-rep{args.rep}.jsonl'
    if out.exists():
        raise ValueError('output exists; use a new run directory')
    used_packages = ['onnxruntime', 'tokenizers', 'numpy'] if args.onnx else ['torch', 'transformers', 'tokenizers', 'numpy']
    if args.model == 'laya': used_packages.append('laya')
    packages = {n: importlib.metadata.version(n) for n in used_packages}
    metadata = dict(model=args.model, method=args.method, repetition=args.rep, revision=manifest['revision'],
                    repository=manifest['repo'], variant_tag=args.tag, parameter_count=classifier.parameter_count,
                    runtime=packages, imported_frameworks={k: k in sys.modules for k in ['torch','transformers','onnxruntime']}, precision='ONNX dynamic INT8 weights / FP32 pooling and head' if args.onnx else 'FP32',
                    device='cpu', execution_providers=['CPUExecutionProvider'] if args.onnx else None,
                    artifact_manifest=manifest, batch=1, threads=4, interop_threads=1, max_tokens=512,
                    warmup_per_mode=10, modes=['A','B','C'], input_embedding_cache=False,
                    candidate_cache='six in-process embeddings computed at load' if classifier.candidates is not None else 'none',
                    candidate_cache_ms=classifier.cached_candidates_ms, labels=LABELS, criteria=CRITERIA,
                    instruction=INSTRUCTION, score_kind=classifier.score_kind,
                    score_probability_claim=False, tokenizer_truncation='left for embeddings; Laya over-budget inputs rejected',
                    laya_head_max_len=384 if args.model=='laya' else None,
                    data_sha256=sha256(args.data), protocol_sha256=sha256(ROOT/'common.py'),
                    source_sha256={p.name: sha256(p) for p in [ROOT/'run.py',ROOT/('onnx_runtime.py' if args.onnx else 'runtime.py'),ROOT/'models.json']},
                    head_sha256=sha256(args.head) if args.head else None, onnx_sha256=sha256(args.onnx) if args.onnx else None,
                    cpu=next(l.split(':',1)[1].strip() for l in Path('/proc/cpuinfo').read_text().splitlines() if l.startswith('model name')),
                    affinity=sorted(os.sched_getaffinity(0)), platform=platform.platform(),
                    timestamp_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
                    load_ms=load_ms, memory_baseline_kib=baseline, memory_loaded_kib=loaded,
                    host_before=host_before, tts_start_delay_ms=None,
                    timing_scope='tokenization + encoder + pooling + six scores; excludes HTTP, TTS and playback; Laya includes typed request formatting',
                    load_scope='adapter initialization, local tokenizer/model and fixed candidates; excludes framework imports and download; warm filesystem pages after hash verification')
    total_wall = total_cpu = 0
    with out.open('w') as f:
        for mode in ['A','B','C']:
            warm = [format_input(r, mode) for r in rows[:10]]
            for text in warm:
                classifier.validate_input(text)
                classifier.predict(text, mode)
            for row in rows:
                text = format_input(row, mode)
                classifier.validate_input(text)
                cpu_start, start = time.process_time(), time.perf_counter()
                raw, decision, probabilities = classifier.predict(text, mode)
                elapsed = (time.perf_counter() - start) * 1000
                cpu_ms = (time.process_time() - cpu_start) * 1000
                total_wall += elapsed
                total_cpu += cpu_ms
                mem = memory()
                for key, value in mem.items():
                    peak[key] = max(peak.get(key,0),value)
                record = dict((k,v) for k,v in row.items() if not k.startswith('_'))
                record.update(model=args.model, method=args.method, variant=name, revision=manifest['revision'],
                              mode=mode, repetition=args.rep, score_kind=classifier.score_kind,
                              raw_scores=dict(zip(LABELS, raw)), decision_scores=dict(zip(LABELS,decision)),
                              sdk_probabilities=probabilities, inference_ms=elapsed, cpu_ms=cpu_ms,
                              cpu_core_equivalents=cpu_ms/elapsed, memory_kib=mem, token_count=classifier.token_count,
                              truncated=classifier.truncated, input_sha256=__import__('hashlib').sha256(text.encode()).hexdigest())
                f.write(json.dumps(record,ensure_ascii=False)+'\n')
            f.flush()
            print(name, 'rep', args.rep, mode, len(rows), 'complete',flush=True)
    metadata.update(memory_peak_observed_kib=peak, cpu_ms=total_cpu, inference_ms=total_wall,
                    cpu_core_equivalents=total_cpu/total_wall, host_after=system_snapshot())
    write_json(out.with_suffix('.meta.json'),metadata)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--sandbox',required=True)
    p.add_argument('--output',required=True)
    p.add_argument('--data',default=str(ROOT/'examples.jsonl'))
    p.add_argument('--models',nargs='+',default=['laya','verdict','ruri30'])
    p.add_argument('--method',choices=['similarity','head'],default='similarity')
    p.add_argument('--head')
    p.add_argument('--tag',default='',help='distinct name for a head/runtime condition')
    p.add_argument('--onnx')
    p.add_argument('--splits',nargs='+',default=['calibration','eval'])
    p.add_argument('--worker',action='store_true',help=argparse.SUPPRESS)
    p.add_argument('--model',help=argparse.SUPPRESS)
    p.add_argument('--rep',type=int,default=0,help=argparse.SUPPRESS)
    args=p.parse_args()
    require_external(args.output)
    if args.tag and not __import__('re').fullmatch('[a-z0-9][a-z0-9-]*',args.tag):
        raise ValueError('tag must use lowercase letters, digits and hyphens')
    if args.worker:
        worker(args)
    else:
        env=dict(os.environ, OMP_NUM_THREADS='4', MKL_NUM_THREADS='4', OPENBLAS_NUM_THREADS='4',
                 NUMEXPR_NUM_THREADS='4', TOKENIZERS_PARALLELISM='false', PYTHONDONTWRITEBYTECODE='1',
                 HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
        if list(Path(args.output).glob('*-rep*.jsonl')):
            raise ValueError('run directory already contains measurements; choose a new output directory')
        from shutil import copy2
        source_directory = require_external(args.output) / 'source'
        source_directory.mkdir(parents=True, exist_ok=True)
        for source in [*ROOT.glob('*.py'), ROOT/'models.json', Path(args.data)]:
            copy2(source, source_directory / source.name)
        for model in args.models:
            for rep in range(3):
                cmd=[sys.executable,str(Path(__file__).resolve()),'--worker','--model',model,'--rep',str(rep),
                     '--sandbox',args.sandbox,'--output',args.output,'--data',args.data,'--method',args.method,
                     '--tag',args.tag,'--splits',*args.splits]
                if args.head: cmd+=['--head',args.head]
                if args.onnx: cmd+=['--onnx',args.onnx]
                subprocess.run(cmd,env=env,check=True)
