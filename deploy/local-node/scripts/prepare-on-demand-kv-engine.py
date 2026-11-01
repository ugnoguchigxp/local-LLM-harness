#!/usr/bin/env python3
"""Build an opt-in KV candidate without modifying or starting the deployed engine."""
import hashlib
import json
from pathlib import Path
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
        raise SystemExit('usage: prepare-on-demand-kv-engine.py VERIFIED_MIXED_CANDIDATE PINNED_BUILD NEW_OUTPUT')
    baseline, build, output = [Path(arg).resolve() for arg in sys.argv[1:]]
    repo = Path(__file__).resolve().parents[3]
    if output.exists() or output == repo or repo in output.parents:
        raise SystemExit('output must be new and outside repository')
    manifest = json.loads((baseline / 'build-manifest.json').read_text())
    if manifest.get('protocol') != 'larm-context-pools.v1' or not manifest.get('baselineReproduced') or not manifest.get('nativeTestsPassed'):
        raise SystemExit('verified mixed-context baseline required')
    if digest(baseline / 'llama-server') != manifest['executableSha256']:
        raise SystemExit('baseline executable changed')
    for name, expected in manifest['sourceSha256'].items():
        if digest(baseline / 'tools/server' / name) != expected:
            raise SystemExit('baseline server source changed: ' + name)
    cache = (build / 'CMakeCache.txt').read_text()
    source = Path(next(line.split('=', 1)[1] for line in cache.splitlines() if line.startswith('CMAKE_HOME_DIRECTORY:INTERNAL=')))
    server_build = build / 'tools/server'
    link = shlex.split((server_build / 'CMakeFiles/llama-server.dir/link.txt').read_text())
    helpers = runpy.run_path(str(Path(__file__).with_name('prepare-prompt-retention-engine.py')))
    redirect = runpy.run_path(str(Path(__file__).with_name('prepare-prompt-cache-engine.py')))['redirected_link']
    old_main = 'CMakeFiles/llama-server.dir/server.cpp.o'
    old_core = '../../src/libllama.a'
    if link.count(old_main) != 1 or link.count(old_core) != 1:
        raise SystemExit('unsupported native link recipe')
    patches = [repo / ('deploy/local-node/patches/llama-on-demand-kv-' + part + '-v1.patch') for part in ['core', 'server']]
    headers = [repo / ('deploy/local-node/patches/' + name) for name in ['larm-context-pools.h', 'larm-on-demand-kv.h']]
    inputs = [baseline / 'llama-server', baseline / 'libserver-context.a', baseline / 'server.cpp.o', build / 'src/libllama.a',
              server_build / 'CMakeFiles/llama-server.dir/link.txt', *patches, *headers]
    hashes = {str(path): digest(path) for path in inputs}
    output.mkdir(parents=True, mode=0o700)
    reproduced = output / 'baseline-llama-server'
    command = redirect(link, baseline / 'libserver-context.a', reproduced)
    command[command.index(old_main)] = str(baseline / 'server.cpp.o')
    subprocess.run(command, cwd=server_build, check=True)
    if digest(reproduced) != manifest['executableSha256']:
        raise SystemExit('pinned libraries do not reproduce deployed mixed-context engine')
    staged = output / 'tools/server'
    shutil.copytree(baseline / 'tools/server', staged)
    core = output / 'src'
    shutil.copytree(source / 'src', core, ignore=shutil.ignore_patterns('build*'))
    for header in headers:
        shutil.copy2(header, staged / header.name)
    for patch in patches:
        subprocess.run(['git', 'apply', '--check', str(patch)], cwd=output, check=True)
        subprocess.run(['git', 'apply', str(patch)], cwd=output, check=True)
    flags = helpers['flags'](build / 'src/CMakeFiles/llama.dir/flags.make')
    # These patches add methods and change no class layout. Only the two core
    # implementation objects need replacement; prove their baseline first.
    archive = output / 'libllama.a'
    shutil.copy2(build / 'src/libllama.a', archive)
    for name in ['llama-kv-cache', 'llama-context']:
        original = source / ('src/' + name + '.cpp')
        cached = build / ('src/CMakeFiles/llama.dir/' + name + '.cpp.o')
        baseline_object = output / ('baseline-' + name + '.cpp.o')
        subprocess.run(['/usr/bin/c++', *flags, '-o', str(baseline_object), '-c', str(original)], check=True)
        if digest(baseline_object) != digest(cached):
            raise SystemExit('current core source does not reproduce pinned object: ' + name)
        hashes[str(cached)] = digest(cached)
        obj = output / (name + '.cpp.o')
        subprocess.run(['/usr/bin/c++', '-I' + str(core), *flags, '-o', str(obj), '-c', str(core / (name + '.cpp'))], check=True)
        subprocess.run(['ar', 'r', str(archive), str(obj)], check=True)
        print('compiled ' + name, flush=True)
    server_flags = helpers['flags'](server_build / 'CMakeFiles/server-context.dir/flags.make')
    obj = output / 'server-context.cpp.o'
    subprocess.run(['/usr/bin/c++', '-I' + str(staged), *server_flags, '-o', str(obj), '-c', str(staged / 'server-context.cpp')], check=True)
    server_archive = output / 'libserver-context.a'
    shutil.copy2(baseline / 'libserver-context.a', server_archive)
    subprocess.run(['ar', 'r', str(server_archive), str(obj)], check=True)
    command = redirect(link, server_archive, output / 'llama-server')
    command[command.index(old_main)] = str(baseline / 'server.cpp.o')
    command[command.index(old_core)] = str(archive)
    subprocess.run(command, cwd=server_build, check=True)
    memory_test = output / 'larm-on-demand-kv-memory-test'
    memory_object = output / 'larm-on-demand-kv-memory-test.o'
    main_flags = helpers['flags'](server_build / 'CMakeFiles/llama-server.dir/flags.make')
    subprocess.run(['/usr/bin/c++', '-I' + str(staged), *main_flags, '-UNDEBUG', '-o', str(memory_object), '-c',
                    str(repo / 'deploy/local-node/patches/larm-on-demand-kv-memory-test.cpp')], check=True)
    command = redirect(link, server_archive, memory_test)
    command[command.index(old_main)] = str(memory_object)
    command[command.index(old_core)] = str(archive)
    subprocess.run(command, cwd=server_build, check=True)
    test = output / 'larm-on-demand-kv-test'
    subprocess.run(['/usr/bin/c++', '-std=c++17', '-UNDEBUG', '-I' + str(staged),
                    str(repo / 'deploy/local-node/patches/larm-on-demand-kv-test.cpp'), '-o', str(test)], check=True)
    subprocess.run([str(test)], check=True)
    if any(digest(path) != expected for path, expected in hashes.items()):
        raise SystemExit('native build inputs changed during build')
    result = {'protocol': 'larm-on-demand-kv.v1', 'baselineReproduced': True,
              'baselineExecutableSha256': manifest['executableSha256'], 'executableSha256': digest(output / 'llama-server'),
              'nativePolicyTestsPassed': True, 'liveInferenceValidated': False, 'providerStarted': False,
              'inputSha256': hashes}
    (output / 'build-manifest.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'inputSha256'}))


if __name__ == '__main__':
    main()
