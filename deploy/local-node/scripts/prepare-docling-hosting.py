#!/usr/bin/env python3
"""Build Docling as an ordinary user; seal artifacts for a separate root install."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DEFAULT_PYTHON = '/opt/larm-local-services/runtimes/python-7e97dbc683e120e5dbcea7382749bf4f5c4cfd2575f496f6db304baff4695811/bin/python3.12'
DEFAULT_BUN = '/opt/larm-local-services/runtimes/bun-33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b/bun'


def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def without_torch(text):
    # The upstream general lock also lists PyPI torch wheels. Preserve the CPU
    # lock's packages; all remaining versions and hashes stay unchanged.
    return ''.join(block for block in re.split(r'(?=^[a-zA-Z][\w.-]*==)', text, flags=re.M)
                   if not re.match(r'(torch|torchvision)==', block))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('/opt/docling-desk'))
    parser.add_argument('--stage', type=Path, default=Path('/srv/ai/local-services-prepared/docling-desk'))
    parser.add_argument('--python', default=DEFAULT_PYTHON)
    parser.add_argument('--bun', default=DEFAULT_BUN)
    parser.add_argument('--node-bin', type=Path)
    parser.add_argument('--pnpm', type=Path)
    parser.add_argument('--seal-only', action='store_true', help='Validate and seal an already built stage')
    args = parser.parse_args()
    if os.geteuid() == 0:
        raise RuntimeError('prepare_as_an_ordinary_user')
    stage = args.stage.resolve()
    if stage == REPO or REPO in stage.parents:
        raise RuntimeError('build_output_must_be_outside_repository')
    source, release = stage / 'source', stage / 'release'
    stage.mkdir(parents=True, exist_ok=True)
    revision = subprocess.check_output(['git', '-c', f'safe.directory={args.source}', '-C', str(args.source), 'rev-parse', 'HEAD'], text=True).strip()
    if not source.exists():
        subprocess.run(['git', 'clone', '--no-checkout', 'https://github.com/ugnoguchigxp/docling-desk.git', str(source)], check=True)
        subprocess.run(['git', '-C', str(source), 'checkout', '--detach', revision], check=True)
    if subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() != revision:
        raise RuntimeError('staged_source_revision_changed')
    if subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True).strip():
        raise RuntimeError('staged_source_must_be_clean')
    env = {**os.environ, 'PYTHONPATH': str(release / 'site-packages'),
           'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1', 'DOCLING_ENV_FILE': '/dev/null',
           'DOCLING_MODELS_DIR': str(release / 'models'), 'DOCLING_DATA_DIR': str(stage / 'validation/data'),
           'DOCLING_STATE_DIR': str(stage / 'validation/state'), 'DOCLING_CACHE_DIR': str(stage / 'validation/cache')}
    for name in list(env):
        if name.startswith(('LARM_', 'AZURE_', 'OPENAI_')):
            env.pop(name)
    env['DOCLING_AUTH_MODE'] = 'none'

    def run(command, **kwargs):
        subprocess.run([str(x) for x in command], check=True, env=env, **kwargs)

    if not args.seal_only:
        subprocess.run(['git', '-C', str(source), 'submodule', 'update', '--init', '--recursive'], check=True)
        node_bin = args.node_bin or stage / 'tools/node-v24.22.1-linux-x64/bin'
        pnpm = args.pnpm or stage / 'tools/pnpm/node_modules/.bin/pnpm'
        expected_node = (source / '.node-version').read_text().strip()
        if subprocess.check_output([str(node_bin / 'node'), '--version'], text=True).strip() != f'v{expected_node}':
            raise RuntimeError('use_the_upstream_pinned_node_version')
        env['PATH'] = f'{node_bin}:{pnpm.parent}:{env["PATH"]}'
        if subprocess.check_output([str(pnpm), '--version'], env=env, text=True).strip() != '10.24.0':
            raise RuntimeError('pnpm_version_mismatch')
        release.mkdir(parents=True, exist_ok=True)
        target = release / 'site-packages'
        for lock in ['requirements-bootstrap.txt', 'requirements-torch.txt', 'requirements-lock.txt']:
            lock_path = source / lock
            if lock == 'requirements-lock.txt':
                lock_path = stage / 'requirements-without-torch.txt'
                lock_path.write_text(without_torch((source / lock).read_text()))
            run([args.python, '-m', 'pip', '--isolated', 'install', '--upgrade', '--target', target,
                 '--no-deps', '--require-hashes', '-r', lock_path])
        run([pnpm, '--dir', source / 'frontend', 'install', '--frozen-lockfile'])
        run([pnpm, '--dir', source / 'frontend', 'build'])
        run([pnpm, '--dir', source / 'frontend', 'export:static'])
        run([args.python, '-m', 'pip', '--isolated', 'install', '--upgrade', '--target', target,
             '--no-deps', source / 'docling', source / 'packages/docling-azure-ocr'])
        run([args.python, '-m', 'pip', '--isolated', 'install', '--upgrade', '--target', target,
             '--no-deps', '--no-build-isolation', source])
        run([args.python, '-m', 'docling_desk.operations.download_models'])
    for folder in ['data', 'state', 'cache']:
        (stage / 'validation' / folder).mkdir(parents=True, exist_ok=True)
    run([args.python, '-m', 'pip', 'check'])
    run([args.python, '-m', 'docling_desk.operations.models'])
    run([args.python, '-c', 'from docling_desk.app import create_app; create_app(); import torch, torchvision; assert torch.version.cuda is None and torch.version.hip is None'])
    if not (release / 'site-packages/docling_desk/resources/static/frontend/index.html').is_file():
        raise RuntimeError('frontend_missing')
    shutil.copyfile(REPO / 'deploy/local-node/local-services/docling_lifecycle.py', release / 'docling_lifecycle.py')
    run(['bun', 'build', REPO / 'deploy/local-node/scripts/docling-gateway.ts', '--target=bun', '--outfile', release / 'gateway.js'], cwd=REPO)
    for name in ['process-controller.py', 'process-member.service.in']:
        shutil.copyfile(REPO / 'deploy/local-node/local-services' / name, stage / name)
    # Bytecode is disposable, and must not be part of the sealed deployment.
    for folder in release.rglob('__pycache__'):
        shutil.rmtree(folder)
    files = {}
    for path in sorted(release.rglob('*')):
        if path.is_symlink():
            raise RuntimeError(f'symlink_in_release:{path.relative_to(release)}')
        if path.is_file():
            files[path.relative_to(stage).as_posix()] = {'sha256': checksum(path), 'executable': bool(path.stat().st_mode & 0o111)}
    for name in ['process-controller.py', 'process-member.service.in']:
        files[name] = {'sha256': checksum(stage / name), 'executable': False}
    value = {'version': 1, 'sourceRevision': revision, 'files': files, 'python': args.python, 'bun': args.bun,
             'externalAssets': {p: checksum(Path(p)) for p in [args.python, args.bun]}}
    value['digest'] = hashlib.sha256(canonical(value)).hexdigest()
    (stage / 'prepared.json').write_bytes(canonical(value))
    print(json.dumps({'stage': str(stage), 'digest': value['digest'], 'files': len(files), 'sourceRevision': revision}, indent=2))


if __name__ == '__main__':
    main()
