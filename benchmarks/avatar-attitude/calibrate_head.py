"""Fit scalar temperature on calibration-only saved logits, never evaluation labels."""
import argparse
import json
from pathlib import Path
import numpy as np
from scipy.optimize import minimize_scalar
from common import LABELS, require_external, sha256


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scores', type=Path, required=True)
    parser.add_argument('--head', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.scores.read_text().splitlines()]
    rows = [r for r in rows if r['split'] == 'calibration' and r['mode'] == 'A' and r['repetition'] == 0]
    head = json.loads(args.head.read_text())
    labels_order = head['labels']
    if len(set(labels_order)) != len(labels_order) or labels_order[0] != 'none':
        raise ValueError('invalid head labels')
    if not rows or len({r['id'] for r in rows}) != len(rows):
        raise ValueError('invalid calibration sample set')
    if set(r['id'] for r in rows) != set(head['calibration_ids']) or set(head['train_ids']) & set(head['calibration_ids']):
        raise ValueError('head/calibration identity mismatch or training leakage')
    if any(r['revision'] != head['revision'] or r['score_kind'] != 'trained_linear_logits' for r in rows):
        raise ValueError('saved scores do not match head revision/method')
    if any(set(r['raw_scores']) != set(labels_order) for r in rows):
        raise ValueError('calibration score labels differ from head')
    if 'contract' in head and any(r.get('head_sha256') != sha256(args.head)
                                or r.get('data_sha256') != head['data_sha256']
                                or r.get('contract') != head['contract'] for r in rows):
        raise ValueError('versioned calibration scores have different head/data/contract identity')
    if 'contract' in head:
        import re
        for field in ('inference_encoder_sha256', 'tokenizer_sha256'):
            values = {r.get(field) for r in rows}
            if len(values) != 1 or not isinstance(next(iter(values)), str) or not re.fullmatch('[a-f0-9]{64}', next(iter(values))):
                raise ValueError('versioned calibration requires one fixed INT8 encoder and tokenizer')
        if head.get('inference_encoder_sha256') and head['inference_encoder_sha256'] != rows[0]['inference_encoder_sha256']:
            raise ValueError('training and calibration encoders differ')
    scores = np.asarray([[r['raw_scores'][label] for label in labels_order] for r in rows])
    if not np.isfinite(scores).all():
        raise ValueError('non-finite calibration logits')
    labels = np.asarray([labels_order.index(r['primary_label']) for r in rows])
    def nll(log_temperature):
        scaled = scores / np.exp(log_temperature)
        shifted = scaled - scaled.max(axis=1, keepdims=True)
        return float(np.mean(np.log(np.exp(shifted).sum(axis=1)) - shifted[np.arange(len(rows)), labels]))
    fit = minimize_scalar(nll, bounds=(np.log(.05), np.log(5.)), method='bounded')
    if not fit.success:
        raise ValueError('temperature fitting failed')
    calibration = {'revision': head['revision'], 'head_sha256': sha256(args.head), 'input_mode': 'A',
                   'temperature': float(np.exp(fit.x)), 'objective': 'calibration-only negative log likelihood',
                   'nll_before': nll(0), 'nll_after': float(fit.fun), 'calibration_ids': [r['id'] for r in rows],
                   'data_sha256': head['data_sha256'], 'preliminary': True,
                   'label_status': 'synthetic-provisional', 'evaluation_labels_used': False,
                   'source_sha256': sha256(Path(__file__))}
    if 'contract' in head:
        calibration.update(contract=head['contract'], labels=labels_order,
                           inference_encoder_sha256=rows[0]['inference_encoder_sha256'],
                           tokenizer_sha256=rows[0]['tokenizer_sha256'])
    output = require_external(args.output)
    if output.exists():
        raise ValueError('calibration output exists; use a new revision')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(calibration, indent=2) + '\n')
    print(json.dumps({k: calibration[k] for k in ('temperature','nll_before','nll_after','evaluation_labels_used')}))


if __name__ == '__main__':
    main()
