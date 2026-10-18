"""Run explicit CPU probes sequentially; no service deployment is performed."""
import argparse
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--runtime-root', type=Path, default=Path('/srv/ai/apps/vision-recognition-eval'))
    parser.add_argument('--baseline-python', type=Path,
        default=Path('/srv/ai/apps/vision-ocr-build/runtimes/4ae2add0fa9d4732dd06-7c6b567f98c1/bin/python'))
    parser.add_argument('--d1-python', type=Path, default=Path('/srv/ai/apps/d1-system-one/.venv/bin/python'))
    parser.add_argument('--stages', nargs='+', choices=['baseline', 'florence', 'table', 'docling', 'd1'], required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--warm-repeats', type=int, default=20)
    parser.add_argument('--cold-restarts', type=int, default=2)
    parser.add_argument('--smoke-only', action='store_true')
    args = parser.parse_args()
    args.evidence.mkdir(parents=True, exist_ok=True)
    script = Path(__file__).with_name('evaluate.py')
    failures = []
    for stage in args.stages:
        executable = args.runtime_root / '.venv' / 'bin' / 'python'
        if stage == 'baseline':
            executable = args.baseline_python
        elif stage == 'd1':
            executable = args.d1_python
        elif stage == 'florence':
            executable = args.runtime_root / 'florence-legacy' / 'bin' / 'python'
        for index in range(args.cold_restarts + 1):
            run_id = args.run_id if index == 0 else args.run_id + '-cold' + str(index)
            command = [str(executable), str(script), '--stage', stage, '--run-id', run_id,
                       '--evidence', str(args.evidence), '--warm-repeats', str(args.warm_repeats if index == 0 else 0)]
            if index or args.smoke_only:
                command.append('--smoke-only')
            baseline = args.evidence / ('baseline-' + args.run_id + '.json')
            if baseline.exists():
                command.extend(['--baseline-result', baseline.name])
            print('Starting ' + stage + ' ' + run_id, flush=True)
            with (args.evidence / (stage + '-' + run_id + '.log')).open('x') as stream:
                process = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT)
            if process.returncode:
                failures.append(stage + ':' + run_id)
                print('Failed; see evidence for ' + stage + ' ' + run_id, flush=True)
                break
            print('Completed ' + stage + ' ' + run_id, flush=True)
    if failures:
        raise SystemExit('Failed runs: ' + ', '.join(failures))


if __name__ == '__main__':
    main()
