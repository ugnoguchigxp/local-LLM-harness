"""Report exact spoken-language spans from saved pilot results (no inference)."""
import argparse
import hashlib
import json
from pathlib import Path
from corpus import corpus


def spans(labels):
    result = set()
    start = 0
    for end in range(1, len(labels) + 1):
        if end == len(labels) or labels[end] != labels[start]:
            result.add((start, end, labels[start]))
            start = end
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--result-dir', type=Path, required=True)
    args = parser.parse_args()
    root = args.result_dir.resolve()
    source_root = Path(__file__).resolve().parents[2]
    if root == source_root or source_root in root.parents:
        raise ValueError('results must remain external')
    report = json.loads((root / 'report.json').read_text())
    corpus_hash = hashlib.sha256(Path(__file__).with_name('corpus.py').read_bytes()).hexdigest()
    if corpus_hash != report['corpus_sha256']:
        raise ValueError('corpus version differs from recorded evaluation')
    errors = json.loads((root / 'evaluation-errors.json').read_text())
    predicted = {(e['id'], e['text'], e['eos']): e['predicted_language'] for e in errors}
    tp = fp = fn = observations = 0
    for row in corpus():
        if row['split'] != 'evaluation':
            continue
        labels = [0 if language == 'ja' else 1 for text, language, _ in row['spans'] for _ in text]
        variants = [(row['text'], True), (row['text'], False)] + [(prefix, False) for prefix, _ in row['partials']]
        for prefix, eos in variants:
            gold = labels[:len(prefix)]
            # evaluate() saves every non-perfect language OR boundary result.
            # Omitted observations are exact language matches by construction.
            actual = predicted.get((row['id'], prefix, eos), gold)
            expected_spans, actual_spans = spans(gold), spans(actual)
            tp += len(expected_spans & actual_spans)
            fp += len(actual_spans - expected_spans)
            fn += len(expected_spans - actual_spans)
            observations += 1
    assert observations == report['evaluation']['observations']
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    result = dict(observations=observations, tp=tp, fp=fp, fn=fn,
                  exact_language_span_precision=precision, exact_language_span_recall=recall,
                  exact_language_span_f1=2 * precision * recall / (precision + recall),
                  definition='Exact start/end/spoken language; ignores synthesis boundaries and pauses; includes explicit user overrides',
                  source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), corpus_sha256=corpus_hash)
    (root / 'language-intervals.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
