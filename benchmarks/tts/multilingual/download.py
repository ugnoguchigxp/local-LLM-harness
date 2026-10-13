#!/usr/bin/env python3
"""Download pinned official checkpoints into an external model directory."""
import argparse
import hashlib
import json
from pathlib import Path

REVISIONS = {
    'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice': '85e237c12c027371202489a0ec509ded67b5e4b5',
    'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice': '0c0e3051f131929182e2c023b9537f8b1c68adfe',
    'Qwen/Qwen3-TTS-12Hz-0.6B-Base': '5d83992436eae1d760afd27aff78a71d676296fc',
    'Qwen/Qwen3-TTS-12Hz-1.7B-Base': 'fd4b254389122332181a7c3db7f27e918eec64e3',
    'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign': '5ecdb67327fd37bb2e042aab12ff7391903235d3',
    'hexgrad/Kokoro-82M': 'f3ff3571791e39611d31c381e3a41a3af07b4987',
    'fishaudio/s2-pro': '1de9996b6be38b745688de084d87a5633f714e4e',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', required=True, type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--verify', action='store_true', help='Hash files and check LFS hashes')
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    for dest in [args.models, args.manifest]:
        if not dest.is_absolute() or dest.resolve() == repository or repository in dest.resolve().parents:
            parser.error('Models and manifest must use absolute paths outside the source repository')
    from huggingface_hub import HfApi, snapshot_download
    manifest = []
    for repo, revision in REVISIONS.items():
        if revision == 'PREPARE':
            raise RuntimeError('Unpinned checkpoint')
        info = HfApi().model_info(repo, revision=revision, files_metadata=True)
        directory = args.models / repo.split('/')[-1]
        print('Downloading', repo, revision, flush=True)
        snapshot_download(repo, revision=revision, local_dir=directory,
            ignore_patterns=['*.png', '*.jpeg', 'samples/*', 'eval/*'], max_workers=4)
        files = []
        for sibling in info.siblings:
            file = directory / sibling.rfilename
            if not file.is_file():
                continue
            if file.stat().st_size != sibling.size:
                raise RuntimeError(f'File size differs: {file}')
            expected = sibling.lfs.sha256 if sibling.lfs else None
            actual = None
            if args.verify:
                with file.open('rb') as handle:
                    actual = hashlib.file_digest(handle, 'sha256').hexdigest()
                if expected and actual != expected:
                    raise RuntimeError(f'LFS hash differs: {file}')
            files.append(dict(path=sibling.rfilename, bytes=sibling.size, expected_sha256=expected, sha256=actual))
        manifest.append(dict(repo=repo, revision=revision, directory=str(directory), files=files))
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        temp = args.manifest.with_suffix('.tmp')
        temp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        temp.replace(args.manifest)


if __name__ == '__main__':
    main()
