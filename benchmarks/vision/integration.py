"""Execute frozen image-only requests, then score using a separate answer key."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import time

from chain import ImageChains, POLICY
from chain_client import LocalBackend


def canonical_latex(text):
    text = re.sub(r'\s+', '', text or '')
    for _ in range(3):
        text = re.sub(r'\{([A-Za-z0-9])\}', r'\1', text)
    return text


def assess(case, result):
    expected = case['expected']
    checks = {}
    if 'status' in expected:
        checks['status'] = result['status'] == expected['status']
    if expected.get('not_ready'):
        checks['not_ready'] = result['status'] != 'ready'
    if expected.get('not_empty'):
        checks['not_empty'] = result['status'] not in ('empty', 'failed')
    if expected.get('no_scene_caption'):
        checks['no_scene_caption'] = result.get('description_kind') != 'model_caption'
    if 'model_calls' in expected:
        checks['model_calls'] = result['model_calls'] == expected['model_calls']
    if 'keyword' in expected:
        checks['keyword'] = expected['keyword'].lower() in result.get('description', '').lower()
    if 'keywords_any' in expected:
        checks['keyword'] = any(word.lower() in result.get('description', '').lower() for word in expected['keywords_any'])
    table_exact = None
    if 'tables' in expected:
        actual = [t['exports']['reread'] for t in result.get('tables', [])]
        normalize = lambda tables: [[[v or '' for v in row] for row in table] for table in tables]
        table_exact = normalize(actual) == normalize(expected['tables'])
        if result['status'] == 'ready':
            checks['ready_table_exact'] = table_exact
    for question in ['table', 'formula']:
        if question in expected:
            answer = result.get('judgment', {}).get('answers', {}).get(question, {}).get('noul')
            checks[question] = answer is not None and (answer >= .5) == expected[question]
    return {'id': case['id'], 'objective': case['objective'], 'split': case['split'],
            'input_kind': case.get('input_kind', 'auto'),
            'status': result['status'], 'checks': checks, 'checks_passed': all(checks.values()),
            'table_exact': table_exact, 'supported': expected.get('supported', False),
            'false_ready': result['status'] == 'ready' and (table_exact is False or expected.get('not_ready', False)),
            'expected_status': expected.get('status'),
            'missed_known_table': bool(expected.get('tables')) and result['status'] == 'not_detected',
            'first_use': any(step.get('operation_first_use') for step in result.get('steps', [])),
            'formula_literal_match': canonical_latex(result.get('formula', {}).get('latex')) == canonical_latex(expected['latex']) if expected.get('latex') else None,
            'elapsed_ms': result['elapsed_ms'], 'issues': result.get('issues', []),
            'table_issues': [t['validation']['issues'] for t in result.get('tables', [])],
            'result_path': None}


def adoption_checks(cases):
    supported = [c for c in cases if c['supported'] and c['split'] != 'calibration']
    ready = [c for c in supported if c['status'] == 'ready' and c['table_exact']]
    warm_tables = [c for c in supported if not c['first_use'] and c['status'] == 'ready']
    warm_photos = [c for c in cases if 'keyword' in c['checks'] and not c['first_use'] and c['status'] == 'ready']
    return {
        'no_false_ready_tables': not any(c['false_ready'] for c in cases),
        'no_unexpected_execution_failure': all(c['status'] != 'failed' or c['expected_status'] == 'failed' for c in cases),
        'supported_table_ready_fraction': len(ready)/len(supported) if supported else None,
        'supported_table_coverage': len(ready)/len(supported) >= POLICY['evaluation']['minimum_ready_supported_table_fraction'] if supported else None,
        'no_false_scene_caption_on_nonphoto': all(c['checks'].get('no_scene_caption', True) for c in cases),
        'photo_keywords': all(c['checks'].get('keyword', True) for c in cases),
        'warm_tables_within_budget': all(c['elapsed_ms'] <= POLICY['evaluation']['warm_table_budget_seconds']*1000 for c in warm_tables) if warm_tables else None,
        'warm_photos_within_budget': all(c['elapsed_ms'] <= POLICY['evaluation']['warm_caption_budget_seconds']*1000 for c in warm_photos) if warm_photos else None,
        'missed_known_tables': [c['id'] for c in cases if c['missed_known_table']]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--models', type=Path, default=Path('/srv/ai/evidence/visual-recognition-20261018/models.json'))
    parser.add_argument('--split', nargs='+', default=['calibration', 'evaluation', 'regression', 'stress'])
    parser.add_argument('--ids', nargs='+')
    args = parser.parse_args()
    if args.output.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('evidence must stay outside Git')
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads(args.corpus.read_text())
    cases = [case for case in manifest['cases'] if case['split'] in args.split and (not args.ids or case['id'] in args.ids)]
    if not cases:
        raise ValueError('no selected cases')
    report = {'policy': POLICY, 'policy_sha256': hashlib.sha256(Path(__file__).with_name('integration-policy.json').read_bytes()).hexdigest(),
              'started_utc': datetime.now(timezone.utc).isoformat(),
              'corpus_sha256': hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
              'scope': manifest['scope'], 'runtime_receives_answer_key': False,
              'cases': [], 'complete': False}

    def save():
        (args.output/'summary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')

    source = args.output/'source'
    source.mkdir()
    for item in Path(__file__).parent.iterdir():
        if item.is_file():
            shutil.copy2(item, source/item.name)
    save()
    with LocalBackend(args.models, args.output/'logs') as backend:
        chain = ImageChains(backend, args.output/'requests')
        for case in cases:
            if hashlib.sha256(Path(case['path']).read_bytes()).hexdigest() != case['sha256']:
                raise ValueError('fixture digest mismatch')
            # Only request fields cross into the runtime API; expected outputs remain in this scorer.
            result = chain.run(case['path'], case['objective'], case['id'], case.get('input_kind', 'auto'))
            score = assess(case, result)
            score['result_path'] = str(args.output/'requests'/case['id']/'result.json')
            report['cases'].append(score)
            save()
            print(json.dumps({'id': case['id'], 'status': result['status'], 'checks_passed': score['checks_passed'],
                              'table_exact': score['table_exact'], 'elapsed_ms': round(score['elapsed_ms'], 2)}, ensure_ascii=False), flush=True)
    report['adoption_checks'] = adoption_checks(report['cases'])
    report['complete'] = True
    report['finished_utc'] = datetime.now(timezone.utc).isoformat()
    save()


if __name__ == '__main__':
    main()
