"""Train exactly 200 Japanese + 200 English sentences; evaluate held-out data."""
import argparse
import difflib
import importlib.metadata
import json
from pathlib import Path
import platform
import shutil
import time
import numpy as np
from scipy.optimize import minimize_scalar
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, precision_recall_fscore_support
from corpus import PROBES, rows, validate
from model import PUBLIC_MODEL, REVISION, LABELS, PREFIX, SentenceEncoder, SentenceLanguageModel, predict_vectors, sha256

SOURCE = Path(__file__).resolve().parent
REPO = SOURCE.parents[1]


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def metrics(expected, actual):
    p, r, f, support = precision_recall_fscore_support(expected, actual, labels=[0, 1], zero_division=0)
    return dict(count=len(expected), correct=int((expected == actual).sum()),
                accuracy=float(accuracy_score(expected, actual)), macro_f1=float(f1_score(expected, actual, average='macro')),
                confusion_matrix=confusion_matrix(expected, actual, labels=[0, 1]).tolist(),
                per_language={label: dict(precision=float(p[i]), recall=float(r[i]), f1=float(f[i]), support=int(support[i])) for i, label in enumerate(LABELS)})


def leakage_audit(data):
    worst = {'similarity': 0.0}
    by_language = {l: [r for r in data if r['language'] == l] for l in LABELS}
    for values in by_language.values():
        for i, left in enumerate(values):
            for right in values[i + 1:]:
                if left['split'] == right['split']:
                    continue
                # quick upper bounds avoid costly comparisons for dissimilar sentences
                matcher = difflib.SequenceMatcher(None, left['text'], right['text'], autojunk=False)
                if matcher.real_quick_ratio() < 0.9 or matcher.quick_ratio() < 0.9:
                    continue
                ratio = matcher.ratio()
                if ratio > worst['similarity']:
                    worst = dict(similarity=ratio, left_id=left['id'], right_id=right['id'])
                if ratio >= 0.9:
                    raise ValueError('near-duplicate sentences across partitions: ' + left['id'] + ', ' + right['id'])
    return dict(cross_partition_exact_duplicates=0, shared_conversations=0, shared_template_groups=0,
                near_duplicate_threshold=0.9, near_duplicates=0,
                highest_compared_similarity=worst)


def measure(model, data, repeats):
    result = []
    trials = []
    for language in LABELS:
        values = [r for r in data if r['language'] == language]
        elapsed = []
        failures = 0
        for i in range(repeats):
            row = values[i % len(values)]
            started = time.perf_counter()
            error = None
            try:
                model.predict(row['text'])
            except Exception as failure:
                error = type(failure).__name__
                failures += 1
            milliseconds = (time.perf_counter() - started) * 1000
            elapsed.append(milliseconds)
            trials.append(dict(language=language, trial=i, id=row['id'], elapsed_ms=milliseconds, error=error))
        result.append(dict(language=language, trials=repeats, failures=failures,
                           p50_ms=float(np.percentile(elapsed, 50)), p95_ms=float(np.percentile(elapsed, 95)),
                           measured='warm local tokenizer + ONNX encoder + binary head; no HTTP or LARM'))
    return result, trials


def run(args):
    data = rows()
    counts = validate(data)
    audit = leakage_audit(data)
    source_data = SOURCE / 'examples.jsonl'
    expected_data = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in data)
    if source_data.read_text() != expected_data:
        raise ValueError('examples.jsonl differs from frozen authored corpus; regenerate explicitly before fitting')
    output = args.output.resolve()
    if output == REPO or REPO in output.parents or output.exists():
        raise ValueError('use a new external result directory')
    if args.repeats < 200:
        raise ValueError('at least 200 timing trials per language')
    benchmark = args.encoder_root.resolve()
    base_manifest = json.loads((benchmark / 'artifacts/ruri30-manifest.json').read_text())
    export = json.loads((benchmark / 'onnx/ruri30-export.json').read_text())
    if base_manifest['revision'] != REVISION or export['revision'] != REVISION or export['pooling'] != 'mean':
        raise ValueError('unexpected sentence encoder revision or pooling')
    for filename, info in base_manifest['files'].items():
        if sha256(Path(base_manifest['path']) / filename) != info['sha256']:
            raise ValueError('source encoder snapshot differs from pinned manifest')
    graph = benchmark / ('onnx/ruri30-' + args.precision + '.onnx')
    graph_hash = export[args.precision + '_sha256']
    tokenizer = Path(base_manifest['path']) / 'tokenizer.json'
    tokenizer_hash = base_manifest['files']['tokenizer.json']['sha256']
    encoder = SentenceEncoder(graph, tokenizer, graph_hash, tokenizer_hash)
    output.mkdir(parents=True)
    for file in ['corpus.py', 'model.py', 'run.py', 'predict.py', 'examples.jsonl']:
        shutil.copyfile(SOURCE / file, output / file)
    x = {}
    y = {}
    splits = {}
    token_counts = {}
    started = time.perf_counter()
    for split in ['train', 'calibration', 'evaluation']:
        splits[split] = [row for row in data if row['split'] == split]
        features = [encoder.encode(row['text']) for row in splits[split]]
        x[split] = np.stack([item[0] for item in features])
        token_counts[split] = [item[1] for item in features]
        y[split] = np.array([LABELS.index(row['language']) for row in splits[split]])
    encode_ms = (time.perf_counter() - started) * 1000
    fitted = []
    selection = []
    for c in [1.0, 10.0, 100.0, 1000.0]:
        classifier = LogisticRegression(C=c, max_iter=2000, solver='lbfgs', random_state=1729).fit(x['train'], y['train'])
        predicted = classifier.predict(x['calibration'])
        score = float(f1_score(y['calibration'], predicted, average='macro'))
        fitted.append((score, -c, classifier))
        selection.append(dict(C=c, calibration_macro_f1=score))
    classifier = max(fitted, key=lambda item: (item[0], item[1]))[2]
    if classifier.classes_.tolist() != [0, 1]:
        raise ValueError('unexpected label order')
    logits = classifier.decision_function(x['calibration'])
    def loss(temperature):
        scaled = logits / temperature
        return float((np.logaddexp(0, scaled) - y['calibration'] * scaled).mean())
    temperature = float(minimize_scalar(loss, bounds=(0.05, 10), method='bounded').x)
    head = dict(model=PUBLIC_MODEL, encoder_revision=REVISION, labels=LABELS,
                weights=classifier.coef_[0].tolist(), bias=float(classifier.intercept_[0]),
                temperature=temperature, C=float(classifier.C), input_prefix=PREFIX,
                encoder_frozen=True, evaluation_labels_used=False, synthetic=True,
                train_ids=[r['id'] for r in splits['train']], calibration_ids=[r['id'] for r in splits['calibration']],
                data_sha256=sha256(source_data), runtime_precision=args.precision)
    head['head_revision'] = 'sentence-language-400-' + args.precision + '-' + sha256(SOURCE / 'corpus.py')[:12]
    save(output / 'head.json', head)
    save(output / 'manifest.json', dict(model=PUBLIC_MODEL, encoder_revision=REVISION,
                                       graph_path=str(graph), graph_sha256=graph_hash,
                                       tokenizer_path=str(tokenizer), tokenizer_sha256=tokenizer_hash,
                                       head_sha256=sha256(output / 'head.json')))
    reports = {}
    predictions = []
    for split in ['train', 'calibration', 'evaluation']:
        predicted, p_en = predict_vectors(head, x[split])
        if not np.array_equal(predicted, classifier.predict(x[split])):
            raise ValueError('saved runtime head differs from fitted classifier')
        reports[split] = metrics(y[split], predicted)
        for row, actual, probability in zip(splits[split], predicted, p_en):
            predictions.append(dict(**row, predicted=LABELS[int(actual)], probability_en=float(probability),
                                    correct=row['language'] == LABELS[int(actual)]))
    save(output / 'predictions.json', predictions)
    save(output / 'evaluation-errors.json', [p for p in predictions if p['split'] == 'evaluation' and not p['correct']])
    model = SentenceLanguageModel(output)
    probes = []
    for name, text, gold in PROBES:
        try:
            prediction = model.predict(text)
            probes.append(dict(name=name, text=text, expected=gold, **prediction,
                               correct=None if gold is None else prediction['language'] == gold))
        except ValueError as error:
            probes.append(dict(name=name, text=text, expected=gold, error=str(error), correct=None if gold is None else False))
    save(output / 'probes.json', probes)
    for _ in range(10):
        model.predict('この文章の言語を判定します。')
    timing, trials = measure(model, splits['evaluation'], args.repeats)
    (output / 'timing-trials.jsonl').write_text(''.join(json.dumps(t) + '\n' for t in trials))
    report = dict(model=PUBLIC_MODEL, encoder_revision=REVISION, precision=args.precision,
                  encoder_frozen=True, actual_training_examples=400, partition_counts=counts,
                  data_sha256=sha256(source_data), corpus_sha256=sha256(SOURCE / 'corpus.py'),
                  source_sha256=sha256(__file__), head_sha256=sha256(output / 'head.json'),
                  graph_sha256=graph_hash, tokenizer_sha256=tokenizer_hash,
                  group_split_audit=audit, input_prefix=PREFIX, max_tokens=512,
                  max_observed_tokens={split: max(values) for split, values in token_counts.items()},
                  load_ms=encoder.load_ms, dataset_feature_extraction_ms=encode_ms,
                  model_selection='calibration Macro F1, ties favor smaller C; no evaluation labels used',
                  selection=selection, selected_C=float(classifier.C), temperature=temperature,
                  calibration='scalar temperature fit on 40 synthetic calibration sentences only',
                  metrics=reports, timings=timing,
                  supplemental_labelled_probes=sum(p['expected'] is not None for p in probes),
                  supplemental_correct=sum(p['correct'] is True for p in probes),
                  runtime={n: importlib.metadata.version(n) for n in ['numpy', 'onnxruntime', 'tokenizers', 'scikit-learn', 'scipy']},
                  platform=platform.platform(), threads=4, batch=1, feature_cache_in_timing=False,
                  limitations='Synthetic text, not real held-out conversation; binary sentence language only, not language spans, boundaries, pronunciation or mixed-text routing',
                  live_provider_changed=False)
    save(output / 'report.json', report)
    print(json.dumps(dict(precision=args.precision, metrics=reports, timings=timing,
                          labelled_probes=report['supplemental_labelled_probes'], correct_probes=report['supplemental_correct']), ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--encoder-root', type=Path, default=Path('/srv/ai/benchmarks/avatar-attitude'))
    parser.add_argument('--precision', choices=['int8', 'fp32'], default='int8')
    parser.add_argument('--repeats', type=int, default=200)
    run(parser.parse_args())
