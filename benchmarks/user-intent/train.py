"""Train only on the supplied train partition; reserve its fifth for calibration."""
import argparse
from collections import Counter, defaultdict
from difflib import SequenceMatcher
import importlib.metadata
import json
from pathlib import Path
import shutil
import time

from intent import Encoder, LABELS, PUBLIC_MODEL, external, normalized, probabilities, sha256, surface_features, write_json


def load_rows(path, schema):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    ids = set()
    for row in rows:
        if set(row) != set(schema['required']):
            raise ValueError('unexpected dataset fields')
        if not isinstance(row['id'], str) or row['id'] in ids:
            raise ValueError('duplicate or invalid sample ID')
        ids.add(row['id'])
        if (row['source'] not in ('past', 'synthetic') or row['label'] not in LABELS
                or not isinstance(row['text'], str) or not row['text'].strip()
                or (row['previous_agent'] is not None and not isinstance(row['previous_agent'], str))
                or row['toolchain'] not in schema['properties']['toolchain']['enum']
                or (row['label'] != 'request' and row['toolchain'] is not None)):
            raise ValueError('invalid sample: ' + row['id'])
    if set(r['label'] for r in rows) != set(LABELS):
        raise ValueError('all five labels required')
    return rows


def groups_for(rows):
    """Group normalized target duplicates and >=0.90 similar long targets.

    Conversation IDs are absent in the supplied data. These lexical groups do
    not claim conversation/template independence.
    """
    parent = list(range(len(rows)))
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    targets = [normalized(r['text']) for r in rows]
    near_pairs = []
    for i, a in enumerate(targets):
        for j in range(i):
            b = targets[j]
            same = a == b
            near = (min(len(a), len(b)) >= 12 and min(len(a), len(b)) / max(len(a), len(b)) >= .82
                    and SequenceMatcher(None, a, b, autojunk=False).ratio() >= .90)
            if same or near:
                parent[root(i)] = root(j)
                if near and not same:
                    near_pairs.append([rows[j]['id'], rows[i]['id']])
    return [str(root(i)) for i in range(len(rows))], near_pairs


def partition(rows, groups, seed=1729):
    import numpy as np
    from sklearn.model_selection import StratifiedGroupKFold
    y = np.array([LABELS.index(r['label']) for r in rows])
    # Keep supplied real/synthetic proportions where group constraints permit.
    strata = [r['source'] + ':' + r['label'] for r in rows]
    fit, calibration = next(StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=seed)
                            .split(np.zeros(len(rows)), strata, groups))
    if set(y[fit]) != set(range(5)) or set(y[calibration]) != set(range(5)):
        raise ValueError('calibration split must contain every class')
    if set(groups[i] for i in fit) & set(groups[i] for i in calibration):
        raise ValueError('fit/calibration group overlap')
    return fit, calibration


def metrics(rows, logits, temperature):
    import numpy as np
    from sklearn.metrics import classification_report, confusion_matrix, log_loss, f1_score
    y = np.array([LABELS.index(r['label']) for r in rows])
    scores = probabilities(logits, temperature)
    pred = scores.argmax(axis=1)
    request = LABELS.index('request')
    ece = 0.
    confidence = scores.max(axis=1)
    for low in np.arange(0, 1, .1):
        mask = (confidence >= low) & (confidence < low + .1 if low < .9 else confidence <= 1)
        if mask.any():
            ece += mask.mean() * abs(confidence[mask].mean() - (pred[mask] == y[mask]).mean())
    result = dict(count=len(rows), correct=int((pred == y).sum()), accuracy=float((pred == y).mean()),
                  macro_f1=float(f1_score(y, pred, labels=list(range(5)), average='macro', zero_division=0)),
                  classification_report=classification_report(y, pred, labels=list(range(5)), target_names=LABELS,
                                                             output_dict=True, zero_division=0),
                  confusion_matrix=confusion_matrix(y, pred, labels=list(range(5))).tolist(),
                  nll=float(log_loss(y, scores, labels=list(range(5)))), ece_10_bins=float(ece),
                  request_missed=int(((y == request) & (pred != request)).sum()),
                  nonrequest_as_request=int(((y != request) & (pred == request)).sum()),
                  valid_as_noise=int((np.isin(y, [0, 1, 2]) & (pred == 3)).sum()),
                  valid_as_incomplete=int((np.isin(y, [0, 1, 2]) & (pred == 4)).sum()))
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data', required=True)
    p.add_argument('--encoder-root', required=True)
    p.add_argument('--encoder-manifest', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--select-features', action='store_true', help='train-only CV over context, current and concatenated Ruri features')
    p.add_argument('--surface-features', action='store_true', help='also compare fixed character-hash features; requires --select-features')
    a = p.parse_args()
    if a.surface_features and not a.select_features:
        raise ValueError('--surface-features requires --select-features')
    data, output = external(a.data), external(a.output)
    if output.exists():
        raise ValueError('output exists; use a new revision')
    schema = json.loads((data / 'schema.json').read_text())
    train, test = [load_rows(data / name, schema) for name in ['train.jsonl', 'eval.jsonl']]
    if set(r['id'] for r in train) & set(r['id'] for r in test):
        raise ValueError('train/eval ID overlap')
    if set(normalized(r['text']) for r in train) & set(normalized(r['text']) for r in test):
        raise ValueError('train/eval normalized target overlap')
    source = load_rows(data / 'past.jsonl', schema) + load_rows(data / 'synthetic.jsonl', schema)
    if len({r['id'] for r in source}) != len(source) or sorted(train + test, key=lambda r:r['id']) != sorted(source, key=lambda r:r['id']):
        raise ValueError('supplied source files and partitions differ')
    groups, near_pairs = groups_for(train)
    fit, calibration = partition(train, groups)
    combined_groups, cross_near = groups_for(train + test)
    overlap_groups = set(combined_groups[:len(train)]) & set(combined_groups[len(train):])
    output.mkdir(parents=True)
    (output / 'source').mkdir()
    for name in ['intent.py', 'train.py']:
        shutil.copy2(Path(__file__).with_name(name), output / 'source' / name)
    shutil.copy2(a.encoder_manifest, output / 'encoder-manifest.json')
    import numpy as np
    from scipy.optimize import minimize_scalar
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import f1_score, log_loss
    from sklearn.model_selection import StratifiedGroupKFold
    start = time.perf_counter()
    encoder = Encoder(a.encoder_root, a.encoder_manifest)
    for _ in range(10):
        encoder.encode(train[0])
    load_ms = (time.perf_counter() - start) * 1000
    vectors, timings, usage = [], [], []
    for i, row in enumerate(train + test):
        start = time.perf_counter()
        vector, counts = encoder.encode(row, 'current-plus-context' if a.select_features else 'context-only')
        vectors.append(vector)
        timings.append((time.perf_counter() - start) * 1000)
        usage.append(counts)
        if (i + 1) % 200 == 0:
            print('encoded', i + 1, '/', len(train) + len(test), flush=True)
    all_features = np.stack(vectors)
    variants = {'context-only': all_features}
    if a.select_features:
        variants = {'context-only': all_features[:,:256], 'current-only':all_features[:,256:],
                    'current-plus-context':all_features}
    if a.surface_features:
        variants['current-plus-context-charhash'] = np.concatenate([
            all_features, np.stack([surface_features(r['text']) for r in train + test])], axis=1)
    x = all_features
    y = np.array([LABELS.index(r['label']) for r in train])
    fit_groups = np.array(groups)[fit]
    folds = list(StratifiedGroupKFold(n_splits=3, shuffle=True, random_state=1729)
                 .split(x[fit], y[fit], fit_groups))
    trials = []
    for mode, features in variants.items():
        for c in [1., 10., 100., 1000.]:
            scores = []
            for subtrain, validation in folds:
                if set(y[fit][subtrain]) != set(range(5)) or set(fit_groups[subtrain]) & set(fit_groups[validation]):
                    raise ValueError('invalid training fold')
                model = LogisticRegression(C=c, max_iter=2000, solver='lbfgs', random_state=1729).fit(features[fit][subtrain], y[fit][subtrain])
                scores.append(float(f1_score(y[fit][validation], model.predict(features[fit][validation]), labels=list(range(5)), average='macro', zero_division=0)))
            trials.append(dict(feature_mode=mode, C=c, macro_f1=float(np.mean(scores)), folds=scores))
            print('train-only CV', trials[-1], flush=True)
    best = max(trials, key=lambda t:(t['macro_f1'], -variants[t['feature_mode']].shape[1], -t['C']))
    chosen, feature_mode = best['C'], best['feature_mode']
    x = variants[feature_mode]
    model = LogisticRegression(C=chosen, max_iter=2000, solver='lbfgs', random_state=1729).fit(x[fit], y[fit])
    if model.classes_.tolist() != list(range(5)):
        raise ValueError('unexpected classifier class order')
    weights, bias = model.coef_.astype(np.float32), model.intercept_.astype(np.float32)
    logits = x @ weights.T + bias
    calibration_logits = logits[calibration]
    objective = lambda log_t:log_loss(y[calibration], probabilities(calibration_logits, float(np.exp(log_t))), labels=list(range(5)))
    optimized = minimize_scalar(objective, bounds=(float(np.log(.05)), float(np.log(20.))), method='bounded')
    if not optimized.success:
        raise ValueError('temperature fit failed')
    temperature = float(np.exp(optimized.x))
    # Protect against a worse scalar fit; this decision uses calibration only.
    if objective(0.) < objective(optimized.x):
        temperature = 1.
    np.savez(output / 'embeddings.npz', embeddings=x, logits=logits)
    split = {r['id']: 'eval' for r in test}
    split.update({train[i]['id']: 'fit' for i in fit})
    split.update({train[i]['id']: 'calibration' for i in calibration})
    conflicts = defaultdict(list)
    for r in train + test:
        conflicts[normalized(r['text'])].append(r)
    conflicting_ids = [[r['id'] for r in rows] for rows in conflicts.values() if len({r['label'] for r in rows}) > 1]
    manifest = dict(schema_version=1, labels=LABELS, split_by_id=split, seed=1729,
                    file_hashes={p.name:sha256(p) for p in data.iterdir() if p.is_file()},
                    original_train_count=len(train), original_eval_count=len(test),
                    fit_count=len(fit), calibration_count=len(calibration),
                    counts={name:dict(Counter(r['source'] + ':' + r['label'] for r in train + test if split[r['id']] == name)) for name in ['fit','calibration','eval']},
                    train_lexical_groups=len(set(groups)), train_near_pairs=near_pairs,
                    train_eval_normalized_overlap=0, train_eval_near_groups=len(overlap_groups),
                    cross_split_near_pairs=[pair for pair in cross_near if split[pair[0]] != split[pair[1]]],
                    conflicting_normalized_target_ids=conflicting_ids,
                    grouping='NFKC target minus whitespace/punctuation, plus >=0.90 SequenceMatcher for >=12 characters',
                    limitations=['No conversation IDs or template family IDs supplied; conversation/family independence is unverified.',
                                 'Supplied eval is preserved; lexical near groups may cross original train/eval.',
                                 'Labels supplied as model-labeled; ambiguous review records retained, no human review asserted.'])
    write_json(output / 'dataset-manifest.json', manifest)
    head = dict(schema_version=1, model=PUBLIC_MODEL, labels=LABELS, revision=encoder.manifest['revision'],
                encoder_frozen=True, encoder_hashes=encoder.encoder_hashes,
                weights=weights.tolist(), bias=bias.tolist(), train_only=True,
                train_ids=[train[i]['id'] for i in fit], calibration_ids=[train[i]['id'] for i in calibration],
                C=chosen, feature_mode=feature_mode, train_cv=trials, train_agreement=float(model.score(x[fit], y[fit])),
                input_contract=dict(version='previous-agent-first160-user-latest-v1', max_tokens=512,
                                    history_first_tokens=160, truncation='right', fields=['previous_agent','text'],
                                    surface_features='signed BLAKE2b character 1..4-grams, 4096 buckets, log1p, L2' if feature_mode.endswith('charhash') else None,
                                    formatter_sha256=sha256(Path(__file__).with_name('intent.py'))),
                label_status='user-supplied-model-labeled-provisional',
                dataset_manifest_sha256=sha256(output / 'dataset-manifest.json'))
    write_json(output / 'head.json', head)
    write_json(output / 'calibration.json', dict(temperature=temperature, head_sha256=sha256(output / 'head.json'),
               calibration_ids=head['calibration_ids'], fit='scalar NLL; held out from supplied train; no eval tuning',
               nll_before=float(objective(0.)), nll_after=float(log_loss(y[calibration], probabilities(calibration_logits, temperature), labels=list(range(5)))),
               label_status=head['label_status']))
    assets = ['head.json', 'calibration.json', 'encoder-manifest.json', 'dataset-manifest.json']
    write_json(output / 'assets.json', dict(model=PUBLIC_MODEL, files=[dict(path=n, sha256=sha256(output / n), bytes=(output / n).stat().st_size) for n in assets]))
    evaluation_logits = logits[len(train):]
    evaluation_scores = probabilities(evaluation_logits, temperature)
    test_metrics = metrics(test, evaluation_logits, temperature)
    audit_review = {json.loads(line)['id'] for line in (data / 'review.jsonl').read_text().splitlines() if line.strip()}
    subsets = {}
    for name, indices in {
        'past':[i for i,r in enumerate(test) if r['source']=='past'],
        'synthetic':[i for i,r in enumerate(test) if r['source']=='synthetic'],
        'with_previous_agent':[i for i,r in enumerate(test) if r['previous_agent']],
        'without_previous_agent':[i for i,r in enumerate(test) if not r['previous_agent']],
        'review_flagged':[i for i,r in enumerate(test) if r['id'] in audit_review],
        'outside_train_near_groups':[i for i in range(len(test)) if combined_groups[len(train)+i] not in overlap_groups],
    }.items():
        if indices:
            subsets[name] = metrics([test[i] for i in indices], evaluation_logits[indices], temperature)
    records = []
    for i, row in enumerate(test):
        pred = LABELS[int(evaluation_scores[i].argmax())]
        records.append(dict(**row, prediction=pred, correct=pred==row['label'], probabilities=dict(zip(LABELS,evaluation_scores[i].tolist())),
                            logits=dict(zip(LABELS,evaluation_logits[i].tolist())), usage=usage[len(train)+i], inference_ms=timings[len(train)+i]))
    (output / 'eval-predictions.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False,allow_nan=False)+'\n' for r in records))
    runtime = {n:importlib.metadata.version(n) for n in ['numpy','scipy','scikit-learn','onnxruntime','tokenizers']}
    report = dict(model=PUBLIC_MODEL, labels=LABELS, fit_count=len(fit), calibration_count=len(calibration), eval=test_metrics,
                  eval_uncalibrated=metrics(test, evaluation_logits, 1.), subsets=subsets, C=chosen, feature_mode=feature_mode, temperature=temperature,
                  train_agreement=head['train_agreement'], runtime=runtime, load_and_warmup_ms=load_ms,
                  threads=4, providers=encoder.session.get_providers(), head_coefficients_bytes=int(weights.nbytes+bias.nbytes),
                  inference_ms=dict(p50=float(np.percentile(timings[len(train):],50)),p95=float(np.percentile(timings[len(train):],95)),
                                    scope='feature extraction during training; includes all candidate encoder features, excludes HTTP; selected adapter measured separately at verification'),
                  truncated_input_count=sum(u['input_tokens_dropped']>0 for u in usage),
                  truncated_history_count=sum(u['history_tokens_dropped']>0 for u in usage),
                  source_hashes={n:sha256(output/'source'/n) for n in ['intent.py','train.py']},
                  artifacts={n:sha256(output/n) for n in assets}, limitations=manifest['limitations'],
                  deployed=False, abstention_threshold=None)
    write_json(output / 'report.json', report)
    print(json.dumps({k:report[k] for k in ['model','fit_count','calibration_count','C','temperature','inference_ms']},ensure_ascii=False),flush=True)
    print('eval', json.dumps(test_metrics,ensure_ascii=False),flush=True)


if __name__ == '__main__':
    main()
