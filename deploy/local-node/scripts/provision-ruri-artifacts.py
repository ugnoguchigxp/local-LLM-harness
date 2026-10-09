"""Copy only the pinned, independently evaluated artifacts into external model roots."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

source_root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(source_root / 'apps/ruri-system-one'))
from attitude import PUBLIC_MODEL


def install_snapshot(target, entries):
    if target.is_symlink():
        raise ValueError('refusing symlink model target')
    if target.exists():
        for source, name, size, sha in entries:
            file = target / name
            if file.is_symlink() or not file.is_file() or file.stat().st_size != size or digest(file) != sha:
                raise ValueError('existing artifact target differs; use a new revision directory')
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.ruri-staging-', dir=target.parent) as staging:
        stage = Path(staging) / 'snapshot'
        stage.mkdir()
        for source, name, size, sha in entries:
            destination = stage / name
            shutil.copyfile(source, destination)
            if destination.stat().st_size != size or digest(destination) != sha:
                raise ValueError('copied artifact checksum mismatch')
        stage.rename(target)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--benchmark-root', type=Path, default=Path('/srv/ai/benchmarks/avatar-attitude'))
    args = parser.parse_args()
    benchmark = args.benchmark_root.resolve()
    if benchmark == source_root or source_root in benchmark.parents:
        raise ValueError('benchmark artifacts must be outside the source repository')
    assets = json.loads((source_root / 'apps/ruri-system-one/assets.json').read_text())
    mappings = {'head.json': 'heads/ruri30-selected.json', 'model.onnx': 'onnx/ruri30-int8.onnx',
                'tokenizer.json': 'artifacts/ruri30/tokenizer.json',
                'calibration.json': 'heads/ruri30-A-calibration.json'}
    derived = []
    for entry in assets['files']:
        source = benchmark / mappings[entry['path']]
        if source.stat().st_size != entry['bytes'] or digest(source) != entry['sha256']:
            raise ValueError('source artifact is not the pinned evaluated revision')
        derived.append((source, entry['path'], entry['bytes'], entry['sha256']))
    # Base weights are managed by LARM's ordinary HF snapshot manifest; derived
    # ONNX/head files are pinned separately and must never be fetched as HF files.
    import yaml
    model = yaml.safe_load((source_root / 'deploy/local-node/models.yaml').read_text())['models']['ruri-v3-30m']
    base = [(benchmark / 'artifacts/ruri30' / e['path'], e['path'], e['bytes'], e['sha256']) for e in model['files']]
    install_snapshot(Path(model['path']), base)
    install_snapshot(Path('/srv/ai/models/ruri-speaking-attitude-v1'), derived)
    print(json.dumps({'model': PUBLIC_MODEL, 'head_revision': assets['head_revision'], 'installed': True}))


if __name__ == '__main__':
    main()
