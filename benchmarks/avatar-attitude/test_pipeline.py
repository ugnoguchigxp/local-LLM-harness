"""Opt-in CLI integration using installed CPU encoder and test-only random text."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from common import ROOT, load_contract
from dataset import prepare
from test_dataset import CONTRACT, fixture


@unittest.skipUnless(os.environ.get('RURI_RUN_PIPELINE') == '1', 'opt in with RURI_RUN_PIPELINE=1 in pinned benchmark environment')
class PipelineTests(unittest.TestCase):
    def test_fixture_import_train_score_calibrate_report_package(self):
        sandbox = Path(os.environ.get('RURI_BENCHMARK_ROOT', '/srv/ai/benchmarks/avatar-attitude'))
        repo = ROOT.parents[1]
        labels = load_contract(CONTRACT)['labels']
        with tempfile.TemporaryDirectory(prefix='ruri-fixture-pipeline-') as tmp:
            root = Path(tmp)
            source = root/'fixture.jsonl'
            source.write_text(''.join(json.dumps(r)+'\n' for r in fixture(labels)))
            prepare(source, CONTRACT, root/'data')
            data = root/'data/examples.jsonl'
            head = root/'head.json'
            onnx = sandbox/'onnx/ruri30-int8.onnx'
            def run(file, *args):
                result = subprocess.run([sys.executable, str(file), *map(str,args)], capture_output=True, text=True,
                                        env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1', HF_HUB_OFFLINE='1',
                                                 TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false',
                                                 OMP_NUM_THREADS='4', OPENBLAS_NUM_THREADS='1'), timeout=180)
                self.assertEqual(result.returncode, 0, result.stdout+'\n'+result.stderr)
                return result
            run(ROOT/'train_head.py', '--sandbox', sandbox, '--model', 'ruri30', '--data', data,
                '--contract', CONTRACT, '--onnx', onnx, '--select-c', '--output', head)
            run(ROOT/'run.py', '--sandbox', sandbox, '--models', 'ruri30', '--data', data,
                '--contract', CONTRACT, '--onnx', onnx, '--method', 'head', '--head', head, '--output', root/'run')
            score = sorted((root/'run').glob('*rep0.jsonl'))[0]
            run(ROOT/'calibrate_head.py', '--scores', score, '--head', head, '--output', root/'calibration.json')
            run(ROOT/'report.py', '--runs', root/'run', '--output', root/'report')
            summary = json.loads((root/'report/summary.json').read_text())[0]
            self.assertEqual(summary['quality']['n'], 30)
            self.assertEqual(len(summary['quality']['per_class']), 15)
            scripts = repo/'deploy/local-node/scripts'
            run(scripts/'package-ruri-artifacts.py', '--head', head, '--calibration', root/'calibration.json', '--output', root/'bundle')
            run(scripts/'provision-ruri-artifacts.py', '--bundle', root/'bundle', '--target', root/'installed')
            manifest = json.loads((root/'installed/assets.json').read_text())
            self.assertEqual(manifest['contract']['labels'], labels)
            # Load the packaged real graph and exercise inference, without a service or release change.
            program = "\n".join([
                'import json, sys',
                f'sys.path.insert(0, {str(repo / "apps/ruri-system-one")!r})',
                'from engine import Engine',
                f'engine = Engine({str(root / "installed")!r}, {str(root / "installed/assets.json")!r})',
                f'labels = {labels!r}',
                "request = dict(model=engine.public_model, state=dict(current_chunk='設定を開きます。'), questions=dict(emotion=dict(type='choice', instructions='発話態度', criteria={label:label for label in labels})))",
                'result = engine.predict(request)',
                "assert list(result['answers']['emotion']['logits']) == labels",
                "assert engine.health()['labels'] == labels",
                "request['model'] = 'ruri-v3-30m-speaking-attitude'",
                'try: engine.predict(request)',
                'except ValueError: pass',
                "else: raise AssertionError('legacy model must not select versioned head')",
            ])
            result = subprocess.run([sys.executable, '-c', program], capture_output=True, text=True, timeout=60,
                                    env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
            self.assertEqual(result.returncode, 0, result.stdout+result.stderr)


if __name__ == '__main__':
    unittest.main()
