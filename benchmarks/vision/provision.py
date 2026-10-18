"""Explicitly provision pinned snapshots outside the source repository."""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    from huggingface_hub import HfApi, snapshot_download
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[2]
    for path in (args.root, args.evidence):
        if path.resolve().is_relative_to(source):
            raise ValueError('artifacts must stay outside the source repository')
        path.mkdir(parents=True, exist_ok=True)
    models = json.loads(Path(__file__).with_name('models.json').read_text())
    record = {}
    for name, spec in models.items():
        info = HfApi().model_info(spec['repo'], revision=spec['revision'], files_metadata=True)
        if info.sha != spec['revision']:
            raise ValueError('unexpected snapshot revision')
        target = args.root / name / spec['revision']
        snapshot_download(spec['repo'], revision=spec['revision'], local_dir=target,
                          allow_patterns=['*.json', '*.safetensors', '*.txt', '*.jinja', '*.py',
                                          'README.md', 'LICENSE', 'assets/*.png'])
        files = []
        for entry in info.siblings:
            path = target / entry.rfilename
            if not path.is_file():
                continue
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            if entry.size is not None and path.stat().st_size != entry.size:
                raise ValueError('download size mismatch: ' + entry.rfilename)
            expected = entry.lfs.sha256 if entry.lfs else None
            if expected and digest != expected:
                raise ValueError('upstream SHA256 mismatch: ' + entry.rfilename)
            files.append({'path': entry.rfilename, 'bytes': path.stat().st_size,
                          'sha256': digest, 'upstream_lfs_sha256': expected})
        if not any(item['path'] == 'model.safetensors' for item in files):
            raise ValueError('missing model weights')
        record[name] = {**spec, 'directory': str(target), 'files': files}
        (args.evidence / 'models.json').write_text(json.dumps(record, indent=2) + '\n')
        print(json.dumps({'model': name, 'revision': info.sha, 'files': len(files),
                          'bytes': sum(item['bytes'] for item in files)}), flush=True)


if __name__ == '__main__':
    main()
