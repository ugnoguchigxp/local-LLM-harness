#!/usr/bin/env python3
"""Build a pinned ROCmFPX engine with the reviewed private retention extension."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


REVISION = '120141f1f9da0a82bb109135c82cd173107fac25'


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_patch(source, patch, payloads):
    actual = subprocess.check_output(['git', '-C', str(source), 'diff', 'HEAD', '--binary'])
    if actual != patch.read_bytes():
        raise ValueError('engine changes must exactly match the reviewed retention patch')
    others = subprocess.check_output(['git', '-C', str(source), 'ls-files', '--others', '--exclude-standard'], text=True).splitlines()
    if set(others) != {str(Path('tools/server') / name) for name in payloads}:
        raise ValueError('unexpected untracked engine source files')
    for name, path in payloads.items():
        if digest(source / 'tools/server' / name) != digest(path):
            raise ValueError('engine retention payload differs from reviewed source')


def main(*, source_default='/srv/ai/apps/qwen38-rocmfp4-retention-source-120141f',
         output_default='/srv/ai/apps/larm-qwen38-retention-120141f-v2',
         patch_name='llama-prompt-retention-rocmfpx-120141f-v1.patch',
         test_name='larm-prompt-retention-test-modern.cpp', mtp=False):
    repo = Path(__file__).resolve().parents[3]
    source = Path(os.environ.get('LARM_QWEN38_RETENTION_SOURCE', source_default)).resolve()
    output = Path(os.environ.get('LARM_QWEN38_RETENTION_ROOT', output_default)).resolve()
    if any(path == Path('/') or path == repo or repo in path.parents for path in [source, output]):
        raise ValueError('engine source and runtime must be outside the repository')
    if output.exists():
        raise ValueError('preserve existing runtime; choose a new output directory')
    patch = repo / 'deploy/local-node/patches' / patch_name
    payloads = {
        'larm-prompt-retention.h': repo / 'deploy/local-node/patches/larm-prompt-retention.h',
        'larm-prompt-retention-test.cpp': repo / 'deploy/local-node/patches' / test_name,
    }
    if not (source / '.git').is_dir():
        subprocess.run(['git', 'clone', 'https://github.com/ROCmFPX/ROCmFPX.git', str(source)], check=True)
        subprocess.run(['git', '-C', str(source), 'checkout', '--detach', REVISION], check=True)
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != REVISION:
        raise ValueError('engine source revision mismatch')
    if not subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain']).strip():
        subprocess.run(['git', '-C', str(source), 'apply', '--check', str(patch)], check=True)
        subprocess.run(['git', '-C', str(source), 'apply', str(patch)], check=True)
        for name, path in payloads.items():
            shutil.copy2(path, source / 'tools/server' / name)
    validate_patch(source, patch, payloads)
    reviewed = {str(path): digest(path) for path in [patch, *payloads.values()]}
    build = source / 'build-larm-vulkan'
    subprocess.run(['cmake', '-S', str(source), '-B', str(build), '-DGGML_VULKAN=ON', '-DCMAKE_BUILD_TYPE=Release',
                    '-DLLAMA_CURL=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_WEBUI=OFF'], check=True)
    subprocess.run(['cmake', '--build', str(build), '--target', 'llama-server', 'larm-retention-test',
                    '-j', os.environ.get('LARM_QWEN38_BUILD_JOBS', '8')], check=True)
    subprocess.run([str(build / 'bin/larm-retention-test')], check=True)
    validate_patch(source, patch, payloads)
    if any(digest(path) != expected for path, expected in reviewed.items()):
        raise ValueError('reviewed sources changed while building')
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=output.name + '.preparing.', dir=output.parent))
    try:
        shutil.copy2(build / 'bin/llama-server', stage / 'llama-server.bin')
        for path in (build / 'bin').glob('lib*.so*'):
            if path.is_symlink():
                (stage / path.name).symlink_to(path.readlink())
            else:
                shutil.copy2(path, stage / path.name)
        shutil.copy2(repo / 'deploy/local-node/scripts/launch-prompt-retention.py', stage / 'launch-prompt-retention.py')
        launcher = stage / 'llama-server'
        launcher.write_text('#!/usr/bin/env bash\nset -euo pipefail\n'
                            'runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n'
                            'export LD_LIBRARY_PATH="${runtime_dir}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"\n'
                            'exec "${runtime_dir}/llama-server.bin" "$@"\n')
        launcher.chmod(0o755)
        version = subprocess.check_output([str(launcher), '--version'], stderr=subprocess.STDOUT, text=True)
        if REVISION[:8] not in version:
            raise ValueError('engine binary revision mismatch')
        (stage / 'SOURCE_REVISION').write_text(REVISION + '\n')
        manifest = {'protocol': 'larm-prompt-cache.v1', 'upstreamRevision': REVISION, 'nativeTestsPassed': True,
                    'patchSha256': digest(patch), 'headerSha256': digest(payloads['larm-prompt-retention.h']),
                    'executableSha256': digest(stage / 'llama-server.bin'), 'speculative': mtp,
                    'mtpBoundaryState': mtp,
                    'speculativeSourceSha256': digest(source / 'common/speculative.cpp'),
                    'sourceSha256': {str(path.relative_to(source)): digest(path) for path in (source / 'tools/server').iterdir()
                                     if path.suffix in ['.cpp', '.h']}, 'reviewedInputs': reviewed}
        (stage / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (stage / 'SHA256SUMS').write_text(''.join(f'{digest(path)}  {path.name}\n'
                                               for path in sorted(stage.iterdir()) if path.is_file()))
        stage.rename(output)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    print(json.dumps({'prepared': str(output), 'protocol': manifest['protocol'], 'nativeTestsPassed': True}))


if __name__ == '__main__':
    main()
