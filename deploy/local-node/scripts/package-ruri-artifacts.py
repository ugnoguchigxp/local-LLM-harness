"""Package a versioned Ruri head with a verified encoder; never activate it."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

SOURCE_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(SOURCE_ROOT/'apps/ruri-system-one'))
from artifacts import load_artifacts
from attitude import validate_contract


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def package(head_path, calibration_path, encoder_root, encoder_manifest, output):
    output = Path(output)
    if output.is_symlink() or output.exists():
        raise ValueError('output exists; use a new immutable revision directory')
    if output.resolve() == SOURCE_ROOT or SOURCE_ROOT in output.resolve().parents:
        raise ValueError('model output must be outside the repository')
    head_path, calibration_path, encoder_root = Path(head_path), Path(calibration_path), Path(encoder_root)
    head = json.loads(head_path.read_text())
    contract = validate_contract(head.get('contract'))
    encoder = json.loads(Path(encoder_manifest).read_text())
    if encoder['revision'] != head['revision'] or encoder.get('model') != 'cl-nagoya/ruri-v3-30m':
        raise ValueError('encoder revision/model differs from the trained head')
    expected = {e['path']: e for e in encoder['files']}
    for name in ('model.onnx', 'tokenizer.json'):
        path = encoder_root/name
        if path.is_symlink() or path.stat().st_size != expected[name]['bytes'] or digest(path) != expected[name]['sha256']:
            raise ValueError('encoder file differs from the pinned manifest: ' + name)
    if head.get('inference_encoder_sha256') and head['inference_encoder_sha256'] != expected['model.onnx']['sha256']:
        raise ValueError('training and packaged INT8 encoders differ')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.ruri-package-', dir=output.parent) as tmp:
        stage = Path(tmp)/'snapshot'
        stage.mkdir()
        for source, name in [(head_path, 'head.json'), (calibration_path, 'calibration.json'),
                             (encoder_root/'model.onnx', 'model.onnx'), (encoder_root/'tokenizer.json', 'tokenizer.json')]:
            shutil.copyfile(source, stage/name)
        files = [dict(path=name, bytes=(stage/name).stat().st_size, sha256=digest(stage/name))
                 for name in ('calibration.json', 'head.json', 'model.onnx', 'tokenizer.json')]
        hashes = {e['path']: e['sha256'] for e in files}
        manifest = dict(model=encoder['model'], revision=encoder['revision'], contract=contract,
                        head_revision='sha256:'+hashes['head.json'], calibration_revision='sha256:'+hashes['calibration.json'],
                        input_mode='A', preliminary=True, files=files)
        manifest_path = stage/'assets.json'
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
        load_artifacts(stage, manifest_path)
        stage.rename(output)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--head', required=True)
    parser.add_argument('--calibration', required=True)
    parser.add_argument('--encoder-root', default='/srv/ai/models/ruri-speaking-attitude-v1')
    parser.add_argument('--encoder-manifest', default=str(SOURCE_ROOT/'apps/ruri-system-one/assets.json'))
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    manifest = package(args.head, args.calibration, args.encoder_root, args.encoder_manifest, args.output)
    print(json.dumps({'output': args.output, 'public_model': manifest['contract']['public_model'],
                      'contract_version': manifest['contract']['version'], 'activated': False}))


if __name__ == '__main__':
    main()
