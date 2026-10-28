"""Download or verify the selected, pinned decision snapshots outside the source repository."""
import argparse
import hashlib
import json
from pathlib import Path
import yaml

SOURCE = Path(__file__).resolve().parents[3]


def verify(path, entry):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != entry['bytes']:
        return False
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() == entry['sha256']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', nargs='+', choices=['d1-2b', 'd1-3b', 'h2o-lightning-4b'], default=['d1-2b'])
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    manifest = yaml.safe_load((SOURCE / 'deploy/local-node/models.yaml').read_text())['models']
    results = []
    for name in args.models:
        model = manifest[name]
        root = Path(model['path'])
        if root.is_symlink() or root.resolve() == SOURCE or SOURCE in root.resolve().parents:
            raise ValueError('artifacts must use a real directory outside the source repository')
        if not args.verify_only:
            from huggingface_hub import hf_hub_download
            root.mkdir(parents=True, exist_ok=True)
            for entry in model['files']:
                target = root / entry['path']
                if target.exists():
                    if not verify(target, entry):
                        raise ValueError('existing artifact differs from the pinned revision: ' + str(target))
                    continue
                hf_hub_download(repo_id=model['source'].removeprefix('https://huggingface.co/'),
                    revision=model['revision'], filename=entry.get('sourcePath', entry['path']), local_dir=root)
        for entry in model['files']:
            if not verify(root / entry['path'], entry):
                raise ValueError('missing or invalid artifact: ' + entry['path'])
        results.append({'model': name, 'revision': model['revision'], 'path': str(root),
                        'bytes': model['totalBytes'], 'files': len(model['files']), 'verified': True})
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
