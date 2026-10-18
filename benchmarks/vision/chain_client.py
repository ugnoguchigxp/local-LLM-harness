"""Bounded local worker lifecycle for the evaluation CLI."""
import json
import os
from pathlib import Path
import selectors
import subprocess


class LocalBackend:
    def __init__(self, model_manifest, logs):
        self.manifest = Path(model_manifest)
        self.logs = Path(logs)
        self.logs.mkdir(parents=True, exist_ok=True)
        self.workers = {}

    def _read(self, process, timeout=120):
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            if not selector.select(timeout):
                raise TimeoutError('inference worker deadline exceeded')
            line = process.stdout.readline()
        if not line:
            raise RuntimeError('inference worker exited unexpectedly')
        return json.loads(line)

    def call(self, operation, path):
        if operation in ['ocr', 'objects', 'layout']:
            kind = 'ocr'
            executable = '/srv/ai/apps/vision-ocr-build/runtimes/4ae2add0fa9d4732dd06-7c6b567f98c1/bin/python'
        elif operation == 'caption':
            kind = 'florence'
            executable = '/srv/ai/apps/vision-recognition-eval/florence-legacy/bin/python'
        elif operation == 'judge':
            kind = 'd1'
            executable = '/srv/ai/apps/d1-system-one/.venv/bin/python'
        else:
            kind = 'native'
            executable = '/srv/ai/apps/vision-recognition-eval/.venv/bin/python'
        if kind not in self.workers:
            log = (self.logs / (kind+'.log')).open('a')
            environment = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'OMP_NUM_THREADS': '4', 'OPENBLAS_NUM_THREADS': '4'}
            process = subprocess.Popen([executable, str(Path(__file__).with_name('chain_worker.py')), str(self.manifest)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1, env=environment)
            self.workers[kind] = process, log
            if not self._read(process).get('ready'):
                raise RuntimeError('worker not ready')
        process, _ = self.workers[kind]
        try:
            process.stdin.write(json.dumps({'operation': operation, 'path': str(path)})+'\n')
            process.stdin.flush()
            response = self._read(process)
        except Exception:
            self._stop(kind)
            raise
        if not response['ok']:
            _, log = self.workers[kind]
            log.write(response.get('traceback', response['error'])+'\n')
            log.flush()
            raise RuntimeError(response['error'])
        return response['result']

    def _stop(self, kind):
        process, log = self.workers.pop(kind)
        if process.poll() is None:
            try:
                process.stdin.write('{"operation":"stop"}\n')
                process.stdin.flush()
                process.stdin.close()
                process.wait(timeout=10)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        for stream in [process.stdin, process.stdout]:
            if stream and not stream.closed:
                stream.close()
        log.close()

    def close(self):
        for kind in list(self.workers):
            self._stop(kind)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
