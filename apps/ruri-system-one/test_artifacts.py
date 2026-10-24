import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from artifacts import load_artifacts

ROOT = Path(__file__).resolve().parents[2]


def fixture(root, contract):
    head = dict(revision='fixture-encoder', labels=contract['labels'], contract=contract,
                encoder_frozen=True, train_only=True, train_ids=['train'], calibration_ids=['cal'], eval_ids=['eval'],
                data_sha256='fixture-data', modes={'A': dict(weights=[[0.]*256 for _ in contract['labels']], bias=[0.]*len(contract['labels']))})
    (root/'head.json').write_text(json.dumps(head))
    head_sha = hashlib.sha256((root/'head.json').read_bytes()).hexdigest()
    calibration = dict(revision=head['revision'], head_sha256=head_sha, contract=contract, labels=contract['labels'],
                       inference_encoder_sha256=hashlib.sha256(b'fixture-graph-not-for-inference').hexdigest(),
                       tokenizer_sha256=hashlib.sha256(b'{}').hexdigest(),
                       input_mode='A', evaluation_labels_used=False, calibration_ids=['cal'], data_sha256='fixture-data', temperature=.8)
    (root/'calibration.json').write_text(json.dumps(calibration))
    (root/'model.onnx').write_bytes(b'fixture-graph-not-for-inference')
    (root/'tokenizer.json').write_text('{}')
    manifest = dict(model='cl-nagoya/ruri-v3-30m', revision=head['revision'], input_mode='A', contract=contract,
                    files=[dict(path=name, bytes=(root/name).stat().st_size, sha256=hashlib.sha256((root/name).read_bytes()).hexdigest())
                           for name in ('head.json','calibration.json','model.onnx','tokenizer.json')])
    hashes = {e['path']: e['sha256'] for e in manifest['files']}
    manifest.update(head_revision='sha256:'+hashes['head.json'], calibration_revision='sha256:'+hashes['calibration.json'])
    (root/'assets.json').write_text(json.dumps(manifest))
    return manifest


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.contract = json.loads((Path(__file__).with_name('contracts')/'expanded-v2-candidate.json').read_text())

    def test_label_order_tamper_and_manifest_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = fixture(root, self.contract)
            self.assertEqual(load_artifacts(root, root/'assets.json')[3], self.contract['labels'])
            manifest['contract']['labels'][1:3] = reversed(manifest['contract']['labels'][1:3])
            (root/'assets.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'provenance'):
                load_artifacts(root, root/'assets.json')
            manifest = fixture(root, self.contract)
            manifest['files'][0]['path'] = '../head.json'
            (root/'assets.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError): load_artifacts(root, root/'assets.json')

    def test_wrong_calibration_and_weights_fail_even_with_recomputed_hashes(self):
        for mutate in ('head', 'overlap', 'shape', 'nan'):
            with self.subTest(mutate=mutate), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                manifest = fixture(root, self.contract)
                file = root/('calibration.json' if mutate=='head' else 'head.json')
                value = json.loads(file.read_text())
                if mutate == 'head': value['head_sha256'] = 'wrong'
                if mutate == 'overlap': value['eval_ids'] = ['train']
                if mutate == 'shape': value['modes']['A']['weights'][0].pop()
                if mutate == 'nan': value['modes']['A']['weights'][0][0] = float('nan')
                file.write_text(json.dumps(value))
                if mutate != 'head':
                    cal = json.loads((root/'calibration.json').read_text())
                    cal['head_sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
                    (root/'calibration.json').write_text(json.dumps(cal))
                for entry in manifest['files']:
                    p = root/entry['path']
                    entry.update(bytes=p.stat().st_size, sha256=hashlib.sha256(p.read_bytes()).hexdigest())
                hashes = {e['path']:e['sha256'] for e in manifest['files']}
                manifest.update(head_revision='sha256:'+hashes['head.json'], calibration_revision='sha256:'+hashes['calibration.json'])
                (root/'assets.json').write_text(json.dumps(manifest))
                with self.assertRaises(ValueError): load_artifacts(root, root/'assets.json')

    def test_package_install_no_activation_or_overwrite(self):
        def module(name, file):
            spec = importlib.util.spec_from_file_location(name, ROOT/'deploy/local-node/scripts'/file)
            value = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(value)
            return value
        packager = module('ruri_packager', 'package-ruri-artifacts.py')
        provisioner = module('ruri_provisioner', 'provision-ruri-artifacts.py')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root/'source'
            source.mkdir()
            fixture(source, self.contract)
            bundle = root/'bundle'
            manifest = packager.package(source/'head.json', source/'calibration.json', source, source/'assets.json', bundle)
            entries = [(bundle/e['path'],e['path'],e['bytes'],e['sha256']) for e in manifest['files']]
            entries.append((bundle/'assets.json','assets.json',(bundle/'assets.json').stat().st_size,provisioner.digest(bundle/'assets.json')))
            target = root/'installed'
            provisioner.install_snapshot(target, entries)
            self.assertEqual(load_artifacts(target, target/'assets.json')[4], self.contract['public_model'])
            with self.assertRaises(ValueError):
                packager.package(source/'head.json', source/'calibration.json', source, source/'assets.json', bundle)
            (target/'head.json').write_text('{}')
            with self.assertRaises(ValueError): provisioner.install_snapshot(target, entries)

    def test_calibration_is_bound_to_the_graph_and_tokenizer(self):
        for name in ('model.onnx', 'tokenizer.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                manifest = fixture(root, self.contract)
                (root/name).write_bytes(b'a different encoder or tokenizer')
                entry = next(e for e in manifest['files'] if e['path']==name)
                entry.update(bytes=(root/name).stat().st_size, sha256=hashlib.sha256((root/name).read_bytes()).hexdigest())
                (root/'assets.json').write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, 'contract/order or artifact revision'):
                    load_artifacts(root, root/'assets.json')


if __name__ == '__main__':
    unittest.main()
