"""Evaluate a frozen head on 50 fresh sentences; no training/calibration here."""
import argparse
import json
from pathlib import Path
import shutil
from corpus import rows as training_rows, PROBES
from evaluation50 import rows, validate
from model import SentenceLanguageModel, sha256

SOURCE = Path(__file__).resolve().parent
REPO = SOURCE.parents[1]


def evaluate(args):
    data = rows()
    validate(data)
    file = SOURCE / 'evaluation50.jsonl'
    saved = [json.loads(line) for line in file.read_text().splitlines()]
    if saved != data:
        raise ValueError('evaluation50.jsonl differs from authored tests')
    output = args.output.resolve()
    if output == REPO or REPO in output.parents or output.exists():
        raise ValueError('use a new external output directory')
    model = SentenceLanguageModel(args.model_dir)
    expected_train = {r['id'] for r in training_rows() if r['split'] == 'train'}
    if len(model.head['train_ids']) != 400 or set(model.head['train_ids']) != expected_train:
        raise ValueError('head was not fitted on ALL 200 Japanese and 200 English training sentences')
    if model.head['data_sha256'] != sha256(SOURCE / 'examples.jsonl'):
        raise ValueError('training corpus version mismatch')
    output.mkdir(parents=True)
    for name in ['evaluation50.py', 'evaluation50.jsonl', 'evaluate50.py']:
        shutil.copyfile(SOURCE / name, output / name)
    predictions = []
    for row in data:
        try:
            result = model.predict(row['text'])
            predictions.append(dict(**row, predicted=result['language'], confidence=result['confidence'],
                                    inference_ms=result['inference_ms'], correct=result['language'] == row['language']))
        except Exception as error:
            predictions.append(dict(**row, predicted=None, error=type(error).__name__, correct=False))
    correct = sum(r['correct'] for r in predictions)
    per_language = {language: dict(total=25, correct=sum(r['correct'] for r in predictions if r['language'] == language)) for language in ['ja', 'en']}
    # User explicitly excluded romanized Japanese after the earlier probe run.
    # Preserve original results and put the new scope in this separate report.
    probes = json.loads((Path(args.model_dir) / 'probes.json').read_text())
    excluded = ['romaji-ja', 'romaji-greeting']
    relevant = [p for p in probes if p['expected'] is not None and p['name'] not in excluded]
    report = dict(model=model.head['model'], head_sha256=sha256(Path(args.model_dir) / 'head.json'),
                  training_count={'ja': 200, 'en': 200}, all_400_training_examples_used=True,
                  frozen_before_new_tests=True, new_tests_used_for_fitting=False,
                  test_count=50, test_count_by_language={'ja': 25, 'en': 25}, correct=correct, accuracy=correct / 50,
                  failures=sum(r['predicted'] is None for r in predictions), per_language=per_language,
                  confusion_matrix=[[sum(r['language'] == truth and r['predicted'] == pred for r in predictions) for pred in ['ja', 'en']] for truth in ['ja', 'en']],
                  data_sha256=sha256(file), source_sha256=sha256(__file__),
                  romanized_japanese_in_current_scope=False,
                  earlier_supplemental_probes=dict(in_scope=len(relevant), correct=sum(p['correct'] is True for p in relevant),
                                                 excluded_by_user=excluded),
                  results='synthetic whole-sentence classification; not speech segmentation or production integration')
    for name, value in [('report.json', report), ('predictions.json', predictions), ('errors.json', [p for p in predictions if not p['correct']])]:
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    evaluate(parser.parse_args())
