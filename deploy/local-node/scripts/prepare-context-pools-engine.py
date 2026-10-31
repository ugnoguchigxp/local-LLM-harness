#!/usr/bin/env python3
"""Build an isolated mixed-context candidate from the verified retention engine; never start it."""
import hashlib
import json
from pathlib import Path
import re
import runpy
import shlex
import shutil
import subprocess
import sys


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    if len(sys.argv) != 4:
        raise SystemExit('usage: prepare-context-pools-engine.py VERIFIED_RETENTION_CANDIDATE PINNED_BUILD NEW_OUTPUT')
    baseline, build, output = [Path(value).resolve() for value in sys.argv[1:]]
    repo = Path(__file__).resolve().parents[3]
    if output.exists() or output == repo or repo in output.parents:
        raise SystemExit('output must be new and outside the repository')
    manifest = json.loads((baseline / 'build-manifest.json').read_text())
    if manifest.get('protocol') != 'larm-prompt-cache.v1' or not manifest.get('baselineReproduced') or not manifest.get('nativeTestsPassed'):
        raise SystemExit('verified retention baseline required')
    if digest(baseline / 'llama-server') != manifest['executableSha256']:
        raise SystemExit('baseline executable changed')
    source = baseline / 'tools/server'
    for name, expected in manifest['sourceSha256'].items():
        if digest(source / name) != expected:
            raise SystemExit('baseline source changed: ' + name)
    server_build = build / 'tools/server'
    link = shlex.split((server_build / 'CMakeFiles/llama-server.dir/link.txt').read_text())
    helpers = runpy.run_path(str(Path(__file__).with_name('prepare-prompt-retention-engine.py')))
    redirect = runpy.run_path(str(Path(__file__).with_name('prepare-prompt-cache-engine.py')))['redirected_link']
    old_main = 'CMakeFiles/llama-server.dir/server.cpp.o'
    if link.count(old_main) != 1:
        raise SystemExit('unsupported main object')
    output.mkdir(parents=True, mode=0o700)
    # Relink the exact deployed inputs before accepting cached core/GPU libraries.
    reproduced = output / 'baseline-llama-server'
    command = redirect(link, baseline / 'libserver-context.a', reproduced)
    command[command.index(old_main)] = str(baseline / 'server.cpp.o')
    subprocess.run(command, cwd=server_build, check=True)
    if digest(reproduced) != manifest['executableSha256']:
        raise SystemExit('pinned libraries no longer reproduce the retention baseline')
    staged = output / 'tools/server'
    shutil.copytree(source, staged)
    patch = repo / 'deploy/local-node/patches/llama-context-pools-v1.patch'
    header = repo / 'deploy/local-node/patches/larm-context-pools.h'
    shutil.copy2(header, staged / header.name)
    inputs = {str(path): digest(path) for path in [baseline / 'llama-server', baseline / 'libserver-context.a', baseline / 'server.cpp.o', patch, header]}
    subprocess.run(['git', 'apply', '--check', str(patch)], cwd=output, check=True)
    subprocess.run(['git', 'apply', str(patch)], cwd=output, check=True)
    flags = helpers['flags'](server_build / 'CMakeFiles/server-context.dir/flags.make')
    main_flags = helpers['flags'](server_build / 'CMakeFiles/llama-server.dir/flags.make')
    members = subprocess.check_output(['ar', 't', str(baseline / 'libserver-context.a')], text=True).splitlines()
    if any(not re.fullmatch(r'[a-z-]+\.cpp\.o', member) for member in members):
        raise SystemExit('unsupported archive members')
    objects = []
    # The task layout changed: rebuild every server object, never mix old task ABIs.
    for member in members:
        obj = output / member
        subprocess.run(['/usr/bin/c++', '-I' + str(staged), *flags, '-o', str(obj), '-c', str(staged / member[:-2])], check=True)
        objects.append(obj)
        print('compiled ' + member, flush=True)
    archive = output / 'libserver-context.a'
    subprocess.run(['ar', 'rcs', str(archive), *map(str, objects)], check=True)
    main_object = output / 'server.cpp.o'
    subprocess.run(['/usr/bin/c++', '-I' + str(staged), *main_flags, '-o', str(main_object), '-c', str(staged / 'server.cpp')], check=True)
    command = redirect(link, archive, output / 'llama-server')
    command[command.index(old_main)] = str(main_object)
    subprocess.run(command, cwd=server_build, check=True)
    for name, test_flags in [('larm-context-pools-test', ['-std=c++17']), ('larm-prompt-retention-test', flags)]:
        test_source = repo / ('deploy/local-node/patches/' + name + '.cpp')
        obj = output / (name + '.o')
        subprocess.run(['/usr/bin/c++', '-I' + str(staged), *test_flags, '-UNDEBUG', '-o', str(obj), '-c', str(test_source)], check=True)
        if name == 'larm-context-pools-test':
            subprocess.run(['/usr/bin/c++', str(obj), '-o', str(output / name)], check=True)
        else:
            command = redirect(link, archive, output / name)
            command[command.index(old_main)] = str(obj)
            subprocess.run(command, cwd=server_build, check=True)
        subprocess.run([str(output / name)], check=True)
    if any(digest(path) != value for path, value in inputs.items()):
        raise SystemExit('baseline or reviewed inputs changed during build')
    result = { 'protocol': 'larm-context-pools.v1', 'baselineReproduced': True, 'baselineExecutableSha256': manifest['executableSha256'],
               'executableSha256': digest(output / 'llama-server'), 'nativeTestsPassed': True, 'providerStarted': False,
               'inputSha256': inputs, 'sourceSha256': {p.name: digest(p) for p in staged.iterdir() if p.suffix in ['.cpp', '.h']} }
    (output / 'build-manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key not in ['inputSha256', 'sourceSha256']}))


if __name__ == '__main__':
    main()
