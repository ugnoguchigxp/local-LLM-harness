#!/usr/bin/env python3
"""Build the pinned reasoning + scoped-cache engine outside this source repository."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

REVISION = 'd05706b4f32a545814856e98ca518292585443b9'


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def prepare(source, output):
    repo = Path(__file__).resolve().parents[3]
    for path in (source, output):
        if not path.is_absolute() or path.resolve() == Path('/') or path.resolve().is_relative_to(repo):
            raise ValueError('engine assets must use dedicated absolute paths outside the repository')
    source, output = source.resolve(), output.resolve()
    if output.exists() or output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError('output must be new and disjoint from source')
    patch = repo / 'deploy/local-node/patches/llama-prompt-retention-d05706b-v1.patch'
    assets = {
        'larm-prompt-retention.h': repo / 'deploy/local-node/patches/larm-prompt-retention.h',
        'larm-prompt-retention-test.cpp': repo / 'deploy/local-node/patches/larm-prompt-retention-test-modern.cpp',
    }
    if not source.exists():
        run('git', 'clone', 'https://github.com/ggml-org/llama.cpp.git', str(source))
        run('git', '-C', str(source), 'checkout', '--detach', REVISION)
    head = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if head != REVISION:
        raise ValueError('engine source revision mismatch')
    delta = subprocess.check_output(['git', '-C', str(source), 'diff', '--binary', '--no-ext-diff', 'HEAD'])
    if delta and delta != patch.read_bytes():
        raise ValueError('preserve unrelated engine changes; source does not match the reviewed patch')
    untracked = subprocess.check_output(['git', '-C', str(source), 'ls-files', '--others', '--exclude-standard', '-z']).decode().split('\0')
    if any(p and p not in ['tools/server/' + name for name in assets] for p in untracked):
        raise ValueError('engine source contains unrelated untracked files')
    for name, original in assets.items():
        existing = source / 'tools/server' / name
        if existing.exists() and (existing.is_symlink() or existing.read_bytes() != original.read_bytes()):
            raise ValueError('engine extension source differs from reviewed inputs')
    if not delta:
        run('git', 'apply', '--check', str(patch), cwd=source)
        run('git', 'apply', str(patch), cwd=source)
    for name, original in assets.items():
        shutil.copy2(original, source / 'tools/server' / name)
    inputs = {str(p.relative_to(repo)): digest(p) for p in [patch, *assets.values()]}
    build = source / 'build-larm-vulkan'
    run('cmake', '-S', str(source), '-B', str(build), '-DGGML_VULKAN=ON', '-DCMAKE_BUILD_TYPE=Release',
        '-DLLAMA_CURL=OFF', '-DLLAMA_BUILD_UI=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF')
    run('cmake', '--build', str(build), '--target', 'llama-server', 'larm-retention-test', '-j', os.getenv('LARM_LFM_BUILD_JOBS', '6'))
    run(str(build / 'bin/larm-retention-test'))
    if any(digest(repo / p) != sha for p, sha in inputs.items()):
        raise ValueError('reviewed inputs changed while building')
    if subprocess.check_output(['git', '-C', str(source), 'diff', '--binary', '--no-ext-diff', 'HEAD']) != patch.read_bytes():
        raise ValueError('engine source changed while building')
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=output.name + '.preparing.', dir=output.parent))
    try:
        shutil.copy2(build / 'bin/llama-server', stage / 'llama-server.bin')
        for library in (build / 'bin').glob('lib*.so*'):
            shutil.copy2(library, stage / library.name, follow_symlinks=False)
        wrapper = stage / 'llama-server'
        wrapper.write_text('''#!/usr/bin/env bash
set -euo pipefail
runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="${runtime_dir}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
exec "${runtime_dir}/llama-server.bin" "$@"
''')
        wrapper.chmod(0o755)
        shutil.copy2(repo / 'deploy/local-node/scripts/launch-prompt-retention.py', stage / 'launch-prompt-retention.py')
        version = subprocess.check_output([str(wrapper), '--version'], stderr=subprocess.STDOUT, text=True)
        if REVISION[:7] not in version:
            raise ValueError('engine binary revision mismatch')
        manifest = {'protocol': 'larm-prompt-cache.v1', 'baseRevision': REVISION,
                    'nativeTestsPassed': True, 'providerStarted': False, 'inputSha256': inputs,
                    'executableSha256': digest(stage / 'llama-server.bin'), 'version': version.strip()}
        (stage / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (stage / 'SOURCE_REVISION').write_text(REVISION + '\n')
        with (stage / 'SHA256SUMS').open('w') as sums:
            for path in sorted(stage.iterdir()):
                if path.is_file() and path.name != 'SHA256SUMS':
                    sums.write(digest(path) + '  ' + path.name + '\n')
        # Refuse a concurrent installation rather than replacing its directory.
        if output.exists():
            raise ValueError('output appeared while building')
        stage.rename(output)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    print(json.dumps({'prepared': str(output), 'baseRevision': REVISION, 'nativeTestsPassed': True}))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: prepare-lfm-retention-engine.py SOURCE NEW_RUNTIME_DIRECTORY')
    prepare(Path(sys.argv[1]), Path(sys.argv[2]))
