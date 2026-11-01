#!/usr/bin/env python3
"""Add the five-minute auxiliary idle clock to a verified on-demand KV engine."""
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def flags(path):
    result = []
    text = path.read_text()
    for name in ['CXX_DEFINES', 'CXX_INCLUDES', 'CXX_FLAGS']:
        match = re.search(rf'^{name} = (.*)$', text, re.MULTILINE)
        if not match:
            raise ValueError('unsupported compiler flags')
        result.extend(shlex.split(match[1]))
    return result


def link_command(recipe, archive, main, core, target):
    expected = ['-o', 'libserver-context.a', 'CMakeFiles/llama-server.dir/server.cpp.o', '../../src/libllama.a']
    if any(recipe.count(item) != 1 for item in expected):
        raise ValueError('unsupported pinned link recipe')
    replacements = {'libserver-context.a': str(archive), expected[2]: str(main), expected[3]: str(core)}
    result = [replacements.get(arg, arg) for arg in recipe if not arg.startswith('-Wl,--dependency-file=')]
    result[result.index('-o') + 1] = str(target)
    return result


def main():
    if len(sys.argv) != 4:
        raise SystemExit('usage: prepare-aux-kv-idle-engine.py VERIFIED_CANDIDATE ACCEPTANCE_JSON NEW_OUTPUT')
    baseline, acceptance, output = [Path(arg).resolve() for arg in sys.argv[1:]]
    deployment = Path(__file__).resolve().parents[1]
    if output.exists() or deployment == output or deployment in output.parents:
        raise ValueError('output must be new and outside source')
    manifest = json.loads((baseline / 'build-manifest.json').read_text())
    evidence = json.loads(acceptance.read_text())
    if manifest.get('protocol') != 'larm-on-demand-kv.v1' or not manifest.get('nativePolicyTestsPassed'):
        raise ValueError('verified on-demand engine required')
    if not evidence.get('ok') or not evidence.get('candidateStopped') or evidence.get('executableSha256') != manifest['executableSha256']:
        raise ValueError('successful native baseline acceptance required')
    if digest(baseline / 'llama-server') != manifest['executableSha256']:
        raise ValueError('baseline executable changed')
    links = [Path(p) for p in manifest['inputSha256'] if p.endswith('/CMakeFiles/llama-server.dir/link.txt')]
    if len(links) != 1:
        raise ValueError('pinned native link input missing')
    link = links[0]
    if digest(link) != manifest['inputSha256'][str(link)]:
        raise ValueError('pinned native link input changed')
    server_build = link.parents[2]
    mains = [Path(p) for p in manifest['inputSha256'] if p.endswith('/server.cpp.o')]
    if len(mains) != 1 or digest(mains[0]) != manifest['inputSha256'][str(mains[0])]:
        raise ValueError('pinned server entry object changed')
    main_object = mains[0]
    recipe = shlex.split(link.read_text())
    patch = deployment / 'patches/llama-aux-kv-idle-server-v1.patch'
    header = deployment / 'patches/larm-aux-kv-idle.h'
    test_source = deployment / 'patches/larm-aux-kv-idle-test.cpp'
    source = baseline / 'tools/server/server-context.cpp'
    compile_flags = server_build / 'CMakeFiles/server-context.dir/flags.make'
    main_flags = server_build / 'CMakeFiles/llama-server.dir/flags.make'
    inputs = [baseline / name for name in ['llama-server', 'libllama.a', 'libserver-context.a']]
    inputs.append(main_object)
    inputs += [link, compile_flags, main_flags, patch, header, test_source, acceptance]
    inputs += sorted(p for p in (baseline / 'tools/server').iterdir() if p.suffix in ('.h', '.hpp', '.cpp'))
    hashes = {str(path): digest(path) for path in inputs}
    output.mkdir(parents=True, mode=0o700)
    reproduced = output / 'baseline-llama-server'
    subprocess.run(link_command(recipe, baseline / 'libserver-context.a', main_object,
                               baseline / 'libllama.a', reproduced), cwd=server_build, check=True)
    if digest(reproduced) != manifest['executableSha256']:
        raise ValueError('baseline native link could not be reproduced')
    staged = output / 'tools/server'
    shutil.copytree(baseline / 'tools/server', staged)
    shutil.copy2(header, staged / header.name)
    subprocess.run(['git', 'apply', '--check', str(patch)], cwd=output, check=True)
    subprocess.run(['git', 'apply', str(patch)], cwd=output, check=True)
    test = output / 'larm-aux-kv-idle-test'
    subprocess.run(['c++', '-std=c++17', '-UNDEBUG', '-I' + str(staged), str(test_source), '-o', str(test)], check=True)
    subprocess.run([str(test)], check=True)
    archive = output / 'libserver-context.a'
    shutil.copy2(baseline / 'libserver-context.a', archive)
    # The private probe flag changes server_task's layout. Rebuild every server
    # object and the entry point; reusing objects with the old layout is unsafe.
    members = subprocess.check_output(['ar', 't', str(archive)], text=True).splitlines()
    for member in members:
        if not re.fullmatch(r'[a-zA-Z0-9_-]+\.cpp\.o', member) or not (staged / member[:-2]).is_file():
            raise ValueError('unsupported server archive member')
        obj = output / member
        subprocess.run(['/usr/bin/c++', '-I' + str(staged), *flags(compile_flags), '-o', str(obj), '-c', str(staged / member[:-2])], check=True)
        subprocess.run(['ar', 'r', str(archive), str(obj)], check=True)
    entry = output / 'server.cpp.o'
    subprocess.run(['/usr/bin/c++', '-I' + str(staged), *flags(main_flags), '-o', str(entry), '-c', str(staged / 'server.cpp')], check=True)
    subprocess.run(link_command(recipe, archive, entry, baseline / 'libllama.a', output / 'llama-server'),
                   cwd=server_build, check=True)
    for path, expected in hashes.items():
        if digest(path) != expected:
            raise ValueError('native build input changed during build')
    result = {'protocol': 'larm-aux-kv-idle.v1', 'baselineReproduced': True,
              'baselineExecutableSha256': manifest['executableSha256'], 'executableSha256': digest(output / 'llama-server'),
              'idleReleaseMs': 300000, 'nativePolicyTestsPassed': True, 'liveInferenceValidated': False,
              'providerStarted': False, 'baselineCandidate': str(baseline), 'inputSha256': hashes}
    (output / 'build-manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key != 'inputSha256'}))


if __name__ == '__main__':
    main()
