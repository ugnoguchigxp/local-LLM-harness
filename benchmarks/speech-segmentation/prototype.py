"""Offline token-head feasibility study. Never activates a LARM Provider.

All graphs, heads, logs and reports are written outside the source repository.
Only observed prefixes go to the encoder; held-out labels never train a head.
"""
import argparse
from collections import Counter
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import subprocess
import threading
import time
import urllib.request

import numpy as np
import onnxruntime as ort
from scipy.optimize import minimize_scalar
from sklearn.linear_model import LogisticRegression
from tokenizers import Tokenizer
import torch
from transformers import AutoConfig, AutoModel
from corpus import corpus

ROOT = Path(__file__).resolve().parents[2]
PAUSES = ['continue', 'none', 'short', 'sentence']
MODEL = 'ruri-v3-30m-speech-segmentation-prototype'


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def validate_rows(rows):
    for field in ['id', 'conversation_id', 'template_group', 'text']:
        ownership = {}
        for row in rows:
            if row[field] in ownership and ownership[row[field]] != row['split']:
                raise ValueError('cross-partition leakage: ' + field)
            ownership[row[field]] = row['split']
    for row in rows:
        assert ''.join(s[0] for s in row['spans']) == row['text']
        assert all(text and language in ['ja', 'en'] and pause in PAUSES[1:]
                   for text, language, pause in row['spans'])


def observations(rows):
    result = []
    for row in rows:
        full = row['text']
        lengths = [len(s[0]) for s in row['spans']]
        # EOS, non-EOS full prefix, and explicitly annotated incomplete prefixes.
        variants = [(full, True, len(full)), (full, False, sum(lengths[:-1]))]
        variants += [(prefix, False, commit) for prefix, commit in row['partials']]
        for prefix, eos, commit in variants:
            languages = []
            boundaries = []
            for text, language, pause in row['spans']:
                languages.extend([0 if language == 'ja' else 1] * len(text))
                boundaries.extend([0] * (len(text) - 1) + [PAUSES.index(pause)])
            boundaries = np.array(boundaries[:len(prefix)])
            boundaries[commit:] = 0
            result.append(dict(id=row['id'], split=row['split'], text=prefix,
                               end_of_input=eos, context=row['context'],
                               overrides=[o for o in row['overrides'] if o[1] <= len(prefix)],
                               safe_commit=commit, language=np.array(languages[:len(prefix)]),
                               boundary=boundaries))
    return result


class TokenEncoder(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask):
        return self.model(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state


def export_graph(base, output):
    cfg = AutoConfig.from_pretrained(base, local_files_only=True)
    cfg.reference_compile = False
    model = AutoModel.from_pretrained(base, config=cfg, local_files_only=True,
                                     dtype=torch.float32, attn_implementation='sdpa').eval().cpu()
    tokenizer = Tokenizer.from_file(str(base / 'tokenizer.json'))
    encoded = tokenizer.encode('設定を確認します。')
    ids = torch.tensor([encoded.ids], dtype=torch.int64)
    mask = torch.ones_like(ids)
    wrapper = TokenEncoder(model).eval()
    fp32 = output / 'token-fp32.onnx'
    with torch.inference_mode():
        torch.onnx.export(wrapper, (ids, mask), str(fp32),
                          input_names=['input_ids', 'attention_mask'], output_names=['token_states'],
                          dynamic_axes={'input_ids': {0: 'batch', 1: 'sequence'},
                                        'attention_mask': {0: 'batch', 1: 'sequence'},
                                        'token_states': {0: 'batch', 1: 'sequence'}},
                          opset_version=18, dynamo=False)
    from onnxruntime.quantization import quantize_dynamic, QuantType
    quantize_dynamic(str(fp32), str(output / 'token-int8.onnx'), weight_type=QuantType.QInt8,
                     per_channel=True, op_types_to_quantize=['MatMul', 'Gemm'])
    return wrapper


class Features:
    def __init__(self, base, graph):
        self.tokenizer = Tokenizer.from_file(str(base / 'tokenizer.json'))
        self.tokenizer.no_truncation()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(graph), options, providers=['CPUExecutionProvider'])
        self.session.disable_fallback()
        self.lock = threading.Lock()

    def encode(self, observation):
        text = observation['text']
        prefix = '直前文脈: ' + observation['context'] + '\n本文: '
        encoding = self.tokenizer.encode(prefix + text)
        if len(encoding.ids) > 512:
            raise ValueError('input_limit: no silent truncation')
        with self.lock:
            hidden = self.session.run(None, {'input_ids': np.asarray([encoding.ids], dtype=np.int64),
                                             'attention_mask': np.asarray([encoding.attention_mask], dtype=np.int64)})[0][0]
        features = []
        for i in range(len(text)):
            point = len(prefix) + i
            indices = [j for j, (start, end) in enumerate(encoding.offsets) if start <= point < end]
            if not indices:
                raise ValueError('unmapped source code point')
            # Byte fallback may have multiple tokens at the same source position.
            vector = hidden[indices].mean(axis=0)
            first, last = min(encoding.offsets[j][0] for j in indices), max(encoding.offsets[j][1] for j in indices)
            structural = [float(point == first), float(point + 1 == last),
                          (point - first + 1) / (last - first),
                          float(observation['end_of_input']), float(i + 1 == len(text))]
            features.append(np.concatenate([vector, np.array(structural, dtype=np.float32)]))
        return np.array(features, dtype=np.float32), len(encoding.ids)


def probabilities(head, features, temperature):
    logits = features @ head.coef_.T + head.intercept_
    if len(head.classes_) == 2:
        logits = np.concatenate([np.zeros_like(logits), logits], axis=1)
    logits = logits / temperature
    exp = np.exp(logits - logits.max(axis=1, keepdims=True))
    return exp / exp.sum(axis=1, keepdims=True)


def fit_temperature(head, x, y):
    def loss(temperature):
        p = probabilities(head, x, temperature)
        return -np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1)).mean()
    return float(minimize_scalar(loss, bounds=(0.1, 10), method='bounded').x)


def boundary_scores(expected, predicted):
    true = expected > 0
    positive = predicted > 0
    tp = int(np.logical_and(true, positive).sum())
    fp = int(np.logical_and(~true, positive).sum())
    fn = int(np.logical_and(true, ~positive).sum())
    precision = tp / (tp + fp) if tp + fp else 0
    recall = tp / (tp + fn) if tp + fn else 0
    return dict(tp=tp, fp=fp, fn=fn, precision=precision, recall=recall,
                f1=2 * precision * recall / (precision + recall) if precision + recall else 0)


class Pilot:
    def __init__(self, features, language, boundary, temperatures, threshold):
        self.features, self.language, self.boundary = features, language, boundary
        self.temperatures, self.threshold = temperatures, threshold

    def predict(self, observation):
        started = time.perf_counter()
        x, tokens = self.features.encode(observation)
        lp = probabilities(self.language, x, self.temperatures[0])
        bp = probabilities(self.boundary, x, self.temperatures[1])
        language = lp.argmax(axis=1)
        # Explicit user language instructions take priority, not a word dictionary.
        for start, end, spoken in observation['overrides']:
            language[start:end] = 0 if spoken == 'ja' else 1
            lp[start:end] = np.eye(2)[language[start:end]]
        boundary = bp.argmax(axis=1)
        boundary[bp.max(axis=1) < self.threshold] = 0
        segments = []
        start = 0
        # No punctuation/word regex or per-word semantic branching.
        for end in range(1, len(language) + 1):
            if boundary[end - 1] == 0 and not (observation['end_of_input'] and end == len(language)):
                continue
            if lp[start:end].max(axis=1).min() < 0.8:
                break
            # A predicted reading change partitions synthesis independently of pause.
            run_start = start
            for i in range(start + 1, end + 1):
                if i == end or language[i] != language[run_start]:
                    segments.append(dict(start=run_start, end=i, text=observation['text'][run_start:i],
                                         language='ja' if language[run_start] == 0 else 'en',
                                         pause=PAUSES[boundary[end - 1]] if i == end and boundary[end - 1] else 'none'))
                    run_start = i
            start = end
        status = ('completed' if start == len(language) else 'unresolved') if observation['end_of_input'] else ('progress' if start else 'waiting')
        return dict(segments=segments, committed=start, status=status,
                    language=language.tolist(), boundary=boundary.tolist(), tokens=tokens,
                    inference_ms=(time.perf_counter() - started) * 1000)


def evaluate(pilot, data):
    errors = []
    expected_boundary, predicted_boundary = [], []
    language_right = chars = premature = withheld = fragmented = spans_right = spans_total = 0
    pause_right = pause_total = completed = unresolved = 0
    for observation in data:
        p = pilot.predict(observation)
        language_right += int((np.array(p['language']) == observation['language']).sum())
        chars += len(p['language'])
        expected_boundary.extend(observation['boundary'])
        predicted_boundary.extend(p['boundary'])
        premature += int(p['committed'] > observation['safe_commit'])
        withheld += int(p['committed'] < observation['safe_commit'])
        completed += int(p['status'] == 'completed')
        unresolved += int(p['status'] == 'unresolved')
        gold_spans = set()
        start = 0
        for i, label in enumerate(observation['boundary']):
            if label:
                gold_spans.add((start, i + 1, int(observation['language'][start])))
                start = i + 1
                pause_total += 1
                pause_right += int(p['boundary'][i] == label)
        spans_total += len(gold_spans)
        spans_right += sum((s['start'], s['end'], 0 if s['language'] == 'ja' else 1) in gold_spans for s in p['segments'])
        fragmented += max(0, len(p['segments']) - len(gold_spans))
        if p['language'] != observation['language'].tolist() or p['boundary'] != observation['boundary'].tolist():
            errors.append(dict(id=observation['id'], text=observation['text'], eos=observation['end_of_input'],
                               expected_language=observation['language'].tolist(), predicted_language=p['language'],
                               expected_boundary=observation['boundary'].tolist(), predicted_boundary=p['boundary'],
                               safe_commit=observation['safe_commit'], predicted_commit=p['committed'],
                               segments=p['segments']))
    return dict(observations=len(data), code_points=chars, language_character_accuracy=language_right / chars,
                boundary=boundary_scores(np.array(expected_boundary), np.array(predicted_boundary)),
                pause_accuracy_at_gold_boundaries=pause_right / pause_total,
                exact_synthesis_span_recall=spans_right / spans_total,
                premature_commits=premature, excessive_withholding=withheld,
                extra_fragments=fragmented, completed=completed, unresolved=unresolved,
                errors=errors)


def http_benchmark(pilot, output, repeats):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                result = pilot.predict(body)
                code = 200
            except Exception as error:
                result, code = {'error': str(error)}, 422
            payload = json.dumps(result).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = 'http://127.0.0.1:' + str(server.server_port)
    cases = [('ja', '設定画面を開いてください。'),
             ('en', 'Please check your network connection.'),
             ('mixed', '設定画面で Keep me signed in を選んでください。'),
             ('partial', '設定画面で Keep me sig'),
             ('long', '設定を確認してから操作を進めてください。' * 12)]
    results = []
    raw = []
    def run_cases(load):
        for name, text in cases:
            observation = dict(text=text, context='', end_of_input=False, overrides=[])
            payload = json.dumps(observation).encode()
            samples = []
            for iteration in range(repeats):
                started = time.perf_counter()
                failure = None
                infer = None
                try:
                    request = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(request, timeout=1) as response:
                        value = json.load(response)
                        infer = value['inference_ms']
                except Exception as error:
                    failure = type(error).__name__
                elapsed = (time.perf_counter() - started) * 1000
                samples.append((elapsed, failure))
                raw.append(dict(condition=name, load=load, trial=iteration, elapsed_ms=elapsed, inference_ms=infer, failure=failure))
            times = np.array([s[0] for s in samples])
            results.append(dict(condition=name, load=load, trials=repeats,
                                p50_ms=float(np.percentile(times, 50)), p95_ms=float(np.percentile(times, 95)),
                                failures=sum(s[1] is not None for s in samples),
                                timeouts=sum(s[1] in ['TimeoutError', 'URLError'] for s in samples)))
    try:
        run_cases('warm-isolated')
        # Separate process: shared CPU contention with the unchanged attitude engine.
        competitor_code = "import sys; sys.path.insert(0, sys.argv[1]); from engine import Engine; e=Engine('/srv/ai/models/ruri-speaking-attitude-v1'); print('ready',flush=True);\nwhile True: e.infer('設定画面を確認してから、必要な項目を選んでください。')"
        process = subprocess.Popen(['/srv/ai/apps/ruri-system-one/.venv/bin/python', '-u', '-c', competitor_code,
                                    str(ROOT / 'apps/ruri-system-one')], stdout=subprocess.PIPE, text=True,
                                   env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'OPENBLAS_NUM_THREADS': '1'})
        try:
            if process.stdout.readline().strip() != 'ready':
                raise RuntimeError('attitude competitor did not become ready')
            run_cases('warm-with-attitude-cpu-load')
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    finally:
        server.shutdown()
        server.server_close()
    (output / 'http-trials.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in raw))
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--base', type=Path, default=Path('/srv/ai/benchmarks/avatar-attitude/artifacts/ruri30'))
    parser.add_argument('--repeats', type=int, default=200)
    parser.add_argument('--precision', choices=['fp32', 'int8'], default='int8')
    args = parser.parse_args()
    output = args.output.resolve()
    if output == ROOT or ROOT in output.parents or output.exists():
        raise ValueError('use a NEW external result directory')
    if args.repeats < 200:
        raise ValueError('at least 200 trials per representative condition')
    output.mkdir(parents=True)
    (output / 'prototype-source.py').write_text(Path(__file__).read_text())
    (output / 'corpus-source.py').write_text(Path(__file__).with_name('corpus.py').read_text())
    rows = corpus()
    validate_rows(rows)
    manifest = json.loads((args.base.parent / 'ruri30-manifest.json').read_text())
    for filename, entry in manifest['files'].items():
        if digest(args.base / filename) != entry['sha256']:
            raise ValueError('encoder provenance mismatch')
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    torch.manual_seed(1729)
    source = export_graph(args.base, output)
    started = time.perf_counter()
    features = Features(args.base, output / ('token-' + args.precision + '.onnx'))
    session_load_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    features.encode(dict(text='起動後の最初の入力です。', context='', end_of_input=False))
    first_feature_ms = (time.perf_counter() - started) * 1000
    checks = []
    fp32 = Features(args.base, output / 'token-fp32.onnx')
    for text in ['短い文。', 'English and 日本語。', '👩🏽‍💻とe\u0301。', '確認。' * 70]:
        encoded = features.tokenizer.encode('直前文脈: \n本文: ' + text)
        feed = {'input_ids': np.asarray([encoded.ids], dtype=np.int64), 'attention_mask': np.asarray([encoded.attention_mask], dtype=np.int64)}
        with torch.inference_mode():
            reference = source(torch.from_numpy(feed['input_ids']), torch.from_numpy(feed['attention_mask'])).numpy()
        f = fp32.session.run(None, feed)[0]
        q = features.session.run(None, feed)[0]
        if not np.allclose(reference, f, rtol=1e-3, atol=5e-4):
            raise ValueError('FP32 ONNX parity failed')
        checks.append(dict(tokens=len(encoded.ids), fp32_max_abs_diff=float(np.abs(reference - f).max()),
                           int8_max_abs_diff=float(np.abs(reference - q).max()), shape=list(q.shape)))
    del source, fp32
    data = observations(rows)
    arrays = {split: [o for o in data if o['split'] == split] for split in ['train', 'calibration', 'evaluation']}
    # Precompute only during fitting; HTTP measurements recompute every feature.
    xs = {split: np.concatenate([features.encode(o)[0] for o in values]) for split, values in arrays.items()}
    heads, temperatures = [], []
    for task in ['language', 'boundary']:
        y = {split: np.concatenate([o[task] for o in values]) for split, values in arrays.items()}
        classifier = LogisticRegression(C=1, max_iter=2000, class_weight='balanced', random_state=1729).fit(xs['train'], y['train'])
        if classifier.classes_.tolist() != list(range(2 if task == 'language' else 4)):
            raise ValueError('missing head class')
        temperature = fit_temperature(classifier, xs['calibration'], y['calibration'])
        save(output / (task + '-head.json'), dict(weights=classifier.coef_.tolist(), bias=classifier.intercept_.tolist(),
                                                classes=classifier.classes_.tolist(), temperature=temperature,
                                                train_ids=[r['id'] for r in rows if r['split'] == 'train'],
                                                calibration_ids=[r['id'] for r in rows if r['split'] == 'calibration'],
                                                evaluation_labels_used=False, synthetic=True, C=1))
        heads.append(classifier)
        temperatures.append(temperature)
    bp = probabilities(heads[1], xs['calibration'], temperatures[1])
    by = np.concatenate([o['boundary'] for o in arrays['calibration']])
    trials = []
    for threshold in [0.5, 0.7, 0.8, 0.9, 0.95, 0.99]:
        predicted = bp.argmax(axis=1)
        predicted[bp.max(axis=1) < threshold] = 0
        trials.append(dict(threshold=threshold, **boundary_scores(by, predicted)))
    candidates = [t for t in trials if t['precision'] >= 0.9] or trials
    best = max(candidates, key=lambda t: (t['f1'], t['precision'], t['threshold']))
    pilot = Pilot(features, *heads, temperatures, best['threshold'])
    started = time.perf_counter()
    pilot.predict(dict(text='起動後の最初の判定です。', context='', end_of_input=False, overrides=[]))
    first = (time.perf_counter() - started) * 1000
    for _ in range(10):
        pilot.predict(dict(text='準備します。', context='', end_of_input=False, overrides=[]))
    evaluation = evaluate(pilot, arrays['evaluation'])
    save(output / 'evaluation-errors.json', evaluation.pop('errors'))
    save(output / 'pilot-evaluation.json', evaluation)
    print(json.dumps(evaluation), flush=True)
    timings = http_benchmark(pilot, output, args.repeats)
    report = dict(model=MODEL, synthetic=True, production_connected=False,
                  encoder_revision=manifest['revision'], token_onnx_sha256=digest(output / 'token-int8.onnx'),
                  selected_precision=args.precision, selected_graph_sha256=digest(output / ('token-' + args.precision + '.onnx')),
                  fresh_session_load_ms=session_load_ms, first_feature_inference_ms=first_feature_ms,
                  corpus_sha256=digest(Path(__file__).with_name('corpus.py')), source_sha256=digest(__file__),
                  language_head_sha256=digest(output / 'language-head.json'), boundary_head_sha256=digest(output / 'boundary-head.json'),
                  calibration='scalar temperature on synthetic calibration only', temperatures=temperatures,
                  boundary_threshold=best['threshold'], threshold_selection=trials,
                  first_after_feature_fit_ms=first, export_checks=checks, evaluation=evaluation,
                  partition_counts=dict(Counter(r['split'] for r in rows)),
                  partial_observation_counts={s: len(v) for s, v in arrays.items()},
                  timings=timings, cpu_threads=4, batch=1, max_tokens=512, platform=platform.platform(),
                  runtime={name: importlib.metadata.version(name) for name in ['torch', 'transformers', 'onnx', 'onnxruntime', 'scikit-learn', 'tokenizers', 'numpy']},
                  limits='No text truncation; >512 tokens fails. No TTS, playback, admission queue or microphone measured.',
                  note='first_after_feature_fit_ms is not cold startup; loopback prototype HTTP is not the authenticated LARM gateway')
    save(output / 'report.json', report)
    print(json.dumps(timings), flush=True)


if __name__ == '__main__':
    main()
