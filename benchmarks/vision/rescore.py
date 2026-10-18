"""Apply stricter report checks to immutable recorded outputs without re-inference."""
import argparse
import hashlib
import json
from pathlib import Path

from integration import assess, adoption_checks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('reports must stay outside Git')
    if args.output.exists():
        raise ValueError('report already exists')
    original = json.loads((args.run/'summary.json').read_text())
    if hashlib.sha256(args.corpus.read_bytes()).hexdigest() != original['corpus_sha256']:
        raise ValueError('corpus does not match recorded run')
    cases = {c['id']: c for c in json.loads(args.corpus.read_text())['cases']}
    scores = []
    for prior in original['cases']:
        case = cases[prior['id']]
        result_path = Path(prior['result_path'])
        result = json.loads(result_path.read_text())
        if result['input_sha256'] != case['sha256']:
            raise ValueError('recorded input does not match answer key')
        score = assess(case, result)
        score['result_path'] = str(result_path)
        scores.append(score)
    report = {**original, 'cases': scores, 'adoption_checks': adoption_checks(scores),
              'scoring_version': 2, 'rescoring_only': True,
              'original_summary_sha256': hashlib.sha256((args.run/'summary.json').read_bytes()).hexdigest()}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(report['adoption_checks'], ensure_ascii=False))


if __name__ == '__main__':
    main()
