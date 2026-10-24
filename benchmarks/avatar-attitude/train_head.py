"""Frozen encoder + N-class logistic head; C selection uses train groups only."""
import argparse
import importlib.metadata
import json
from pathlib import Path
import time
from common import ROOT, LABELS, format_input, load_contract, load_examples, require_external, sha256, write_json


def fit_classifier(x, y, groups, labels, select_c=False, seed=1729):
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import f1_score
    from sklearn.model_selection import StratifiedGroupKFold
    count = len(labels)
    if sorted(set(y)) != list(range(count)):
        raise ValueError('all contract classes need training examples')
    folds = []
    if select_c:
        n = min(3, min(len(set(groups[y == i])) for i in range(count)))
        if n < 2:
            raise ValueError('C selection requires at least two training groups per class')
        folds = list(StratifiedGroupKFold(n_splits=n, shuffle=True, random_state=seed).split(x, y, groups))
        if any(set(y[train]) != set(range(count)) or set(y[test]) != set(range(count))
               or set(groups[train]) & set(groups[test]) for train, test in folds):
            raise ValueError('training group folds do not cover every class independently')
    trials = []
    for c in ([1., 10., 100., 1000.] if select_c else [10.]):
        scores = []
        for train, test in folds:
            fitted = LogisticRegression(C=c, max_iter=2000, solver='lbfgs', random_state=seed).fit(x[train], y[train])
            scores.append(float(f1_score(y[test], fitted.predict(x[test]), labels=list(range(count)), average='macro', zero_division=0)))
        trials.append(dict(C=c, macro_f1=float(np.mean(scores)) if scores else None, fold_scores=scores))
    chosen = max(trials, key=lambda t: (t['macro_f1'] if t['macro_f1'] is not None else 0, -t['C']))['C']
    classifier = LogisticRegression(C=chosen, max_iter=2000, solver='lbfgs', random_state=seed).fit(x, y)
    if classifier.classes_.tolist() != list(range(count)):
        raise ValueError('head label order mismatch')
    return classifier, trials


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sandbox', required=True)
    p.add_argument('--model', choices=['ruri30', 'ruri70', 'modernbert30'], required=True)
    p.add_argument('--data', default=str(ROOT/'examples.jsonl'))
    p.add_argument('--contract')
    p.add_argument('--output', required=True)
    p.add_argument('--onnx', help='train against the deployment INT8 encoder instead of PyTorch FP32')
    p.add_argument('--modes', nargs='+', choices=['A', 'B', 'C'])
    p.add_argument('--select-c', action='store_true', help='select C using train-only stratified group folds')
    a = p.parse_args()
    a.modes = a.modes or (['A'] if a.contract else ['A', 'B', 'C'])
    output = require_external(a.output)
    if output.exists():
        raise ValueError('head output exists; use a new revision')
    contract = load_contract(a.contract)
    labels = contract['labels'] if contract else LABELS
    if contract and (a.model != 'ruri30' or a.modes != ['A']):
        raise ValueError('versioned Provider contracts currently support ruri30 input A only')
    import numpy as np
    import torch
    from runtime import Encoder
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    torch.manual_seed(1729)
    manifest = json.loads((Path(a.sandbox)/'artifacts'/(a.model+'-manifest.json')).read_text())
    for name, info in manifest['files'].items():
        if sha256(Path(manifest['path'])/name) != info['sha256']:
            raise ValueError('encoder artifact changed: ' + name)
    if a.onnx:
        export = json.loads((Path(a.onnx).parent/(a.model+'-export.json')).read_text())
        if export['revision'] != manifest['revision'] or export['int8_sha256'] != sha256(a.onnx):
            raise ValueError('INT8 encoder/export identity mismatch')
    rows = load_examples(a.data, labels)
    train = [r for r in rows if r['split']=='train']
    calibration = [r for r in rows if r['split']=='calibration']
    if set(r['primary_label'] for r in calibration) != set(labels):
        raise ValueError('all contract classes need independent calibration examples')
    from dataset import group_rows
    groups, _, _ = group_rows(train)
    group_ids = {r['id']: r['template_group'] for group in groups for r in group}
    encoder = Encoder(manifest, manifest['path'], a.onnx)
    if encoder.model is not None:
        for parameter in encoder.model.parameters():
            parameter.requires_grad_(False)
    head = dict(model=a.model, revision=manifest['revision'], labels=labels, encoder_frozen=True,
                data_sha256=sha256(a.data), train_ids=[r['id'] for r in train],
                train_conversations=sorted({r['conversation_id'] for r in train}),
                train_template_groups=sorted(set(group_ids.values())), train_only=True,
                hyperparameters={'default_C':10., 'max_iter':2000, 'solver':'lbfgs', 'seed':1729},
                artifact_manifest=manifest, runtime={n:importlib.metadata.version(n) for n in ['torch','transformers','scikit-learn']},
                source_sha256=sha256(__file__), preliminary=True, modes={},
                regularization_selection='train-only stratified group CV Macro F1; ties favor smaller C' if a.select_c else 'fixed C=10',
                calibration_ids=[r['id'] for r in calibration], eval_ids=[r['id'] for r in rows if r['split']=='eval'],
                inference_encoder_sha256=sha256(a.onnx) if a.onnx else None,
                training_precision='int8-encoder-fp32-head' if a.onnx else 'fp32',
                label_status='synthetic-provisional')
    if contract:
        head['contract'] = contract
    start = time.perf_counter()
    for mode in a.modes:
        x = np.stack([encoder.encode(manifest['input_prefix']+format_input(r, mode)) for r in train])
        y = np.array([labels.index(r['primary_label']) for r in train])
        classifier, trials = fit_classifier(x, y, np.array([group_ids[r['id']] for r in train]), labels, a.select_c)
        head['modes'][mode] = dict(weights=classifier.coef_.tolist(), bias=classifier.intercept_.tolist(),
                                   train_agreement=float(classifier.score(x,y)), C=classifier.C, train_cv_trials=trials)
        print(a.model, mode, 'train n=', len(train), flush=True)
    head['training_ms'] = (time.perf_counter()-start)*1000
    write_json(output, head)


if __name__ == '__main__':
    main()
