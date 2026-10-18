"""Combine evidence with explicit, digest-checked replacement of repeated requests."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

from integration import adoption_checks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reports', type=Path, nargs='+', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('reports must stay outside Git')
    if args.output.exists():
        raise ValueError('report already exists')
    cases, inputs, sources = {}, {}, []
    policy_digest = None
    for path in args.reports:
        report = json.loads(path.read_text())
        if not report['complete']:
            raise ValueError('cannot combine unfinished evidence')
        if policy_digest is not None and policy_digest != report['policy_sha256']:
            raise ValueError('policy changed between runs')
        policy_digest = report['policy_sha256']
        sources.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        for case in report['cases']:
            result = json.loads(Path(case['result_path']).read_text())
            identity = (result['input_sha256'], result['objective'], result.get('input_kind', 'auto'))
            if case['id'] in inputs and inputs[case['id']] != identity:
                raise ValueError('replacement request does not match original input and objective')
            inputs[case['id']] = identity
            cases[case['id']] = case
    selected = list(cases.values())
    result = {'sources': sources, 'policy_sha256': policy_digest, 'cases': selected,
              'count': len(selected), 'statuses': dict(Counter(c['status'] for c in selected)),
              'checks_passed': sum(c['checks_passed'] for c in selected),
              'adoption_checks': adoption_checks(selected)}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({key: value for key, value in result.items() if key not in ['cases', 'sources']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
