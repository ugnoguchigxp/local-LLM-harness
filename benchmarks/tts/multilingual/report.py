#!/usr/bin/env python3
"""Summarize completed runs; keep failures and incomplete configurations visible."""
import argparse
import csv
import json
from pathlib import Path
import statistics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    if not args.input.is_absolute() or args.input.resolve() == repository or repository in args.input.resolve().parents:
        parser.error('Results must use an absolute path outside the source repository')
    summary = []
    statuses = []
    suite_file = args.input / 'suite-status.json'
    suite = {r['name']: r for r in json.loads(suite_file.read_text())} if suite_file.exists() else {}
    for directory in sorted(args.input.iterdir()):
        if not directory.is_dir() or not (directory / 'environment.json').exists() or directory.name.startswith('initial-'):
            continue
        runs_file = directory / 'runs.jsonl'
        rows = [json.loads(line) for line in runs_file.read_text().splitlines() if line] if runs_file.exists() else []
        measured = [r for r in rows if r['phase'] == 'measured']
        successful = [r for r in measured if r['success']]
        completed = (directory / 'completed.json').exists()
        exit_code = suite.get(directory.name, {}).get('exit_code')
        statuses.append(dict(configuration=directory.name,
            status='complete' if completed else 'failed' if exit_code not in [None, 0] or any(not r['success'] for r in measured) else 'incomplete',
            exit_code=exit_code, successful_requests=len(successful), failed_requests=sum(not r['success'] for r in measured)))
        groups = {'all': successful}
        for prefix in ['ja', 'en', 'mixed']:
            groups[prefix] = [r for r in successful if r['case'].startswith(prefix + '-')]
        for case in sorted({r['case'] for r in successful}):
            groups[case] = [r for r in successful if r['case'] == case]
        for group, runs in groups.items():
            if not runs:
                continue
            total = sum(r['total_s'] for r in runs)
            audio = sum(r['audio_s'] for r in runs)
            first = [r['first_audio_s'] for r in runs if r['first_audio_s'] is not None]
            peaks = [r['peak_allocated_gib'] for r in runs if r['peak_allocated_gib'] is not None]
            native_rss = [r['max_rss_gib'] for r in runs if not r['backend'].endswith('-http')]
            summary.append(dict(configuration=directory.name, group=group, n=len(runs),
                completed=(directory / 'completed.json').exists(), failures=sum(not r['success'] for r in measured),
                median_generation_s=statistics.median(r['total_s'] for r in runs),
                median_audio_s=statistics.median(r['audio_s'] for r in runs),
                median_rtf=statistics.median(r['rtf'] for r in runs),
                aggregate_rtf=total / audio, realtime_speed=audio / total,
                median_first_audio_s=statistics.median(first) if first else None,
                max_peak_allocated_gib=max(peaks) if peaks else None,
                max_rss_gib=max(native_rss) if native_rss else None))
    (args.input / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    (args.input / 'configuration-status.json').write_text(json.dumps(statuses, ensure_ascii=False, indent=2) + '\n')
    if summary:
        with (args.input / 'summary.csv').open('w') as f:
            writer = csv.DictWriter(f, fieldnames=list(summary[0]))
            writer.writeheader()
            writer.writerows(summary)
    print('| Configuration | Status | JA median RTF | EN median RTF | Mixed median RTF | JA short (s) | EN short (s) |')
    print('|---|---|---:|---:|---:|---:|---:|')
    for status in statuses:
        name = status['configuration']
        groups = {r['group']: r for r in summary if r['configuration'] == name}
        def metric(group, key):
            value = groups.get(group, {}).get(key)
            return f'{value:.3f}' if value is not None else '—'
        print(f"| {name} | {status['status']} | {metric('ja', 'median_rtf')} | {metric('en', 'median_rtf')} | {metric('mixed', 'median_rtf')} | {metric('ja-short', 'median_generation_s')} | {metric('en-short', 'median_generation_s')} |")


if __name__ == '__main__':
    main()
