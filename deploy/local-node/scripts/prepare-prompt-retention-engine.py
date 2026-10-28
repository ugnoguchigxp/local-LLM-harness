#!/usr/bin/env python3
"""Build a private retention candidate and native tests. Never start a Provider."""
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
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def flags(path):
    text = path.read_text()
    result = []
    for name in ['CXX_DEFINES', 'CXX_INCLUDES', 'CXX_FLAGS']:
        match = re.search(rf'^{name} = (.*)$', text, re.MULTILINE)
        if not match:
            raise SystemExit('unsupported compiler flags')
        result.extend(shlex.split(match[1]))
    return result


def main():
    if len(sys.argv) != 5:
        raise SystemExit('usage: prepare-prompt-retention-engine.py SOURCE BUILD DEPLOYED_PREFIX_SOURCE NEW_PRIVATE_OUTPUT')
    source, build, deployed_prefix, output = [Path(s).resolve() for s in sys.argv[1:]]
    repo = Path(__file__).resolve().parents[3]
    if output.exists() or output == repo or repo in output.parents:
        raise SystemExit('output must be new and outside repository')
    output.mkdir(parents=True, mode=0o700)
    # This also reproduces the pinned unmodified objects/link and the exact-prefix fix.
    subprocess.run([sys.executable, str(Path(__file__).with_name('prepare-prompt-cache-engine.py')),
                    str(source), str(build), str(output / 'prefix-baseline')], check=True, stdout=subprocess.DEVNULL)
    baseline = output / 'prefix-baseline'
    expected_source = '5c552ef64dd9f2eb4c29894e2b8acc24eca559e4804456972dd38291c996d658'
    if digest(deployed_prefix) != expected_source or digest(baseline / 'tools/server/server-context.cpp') != expected_source:
        raise SystemExit('exact-prefix source does not match deployed manifest')
    server_build = build / 'tools/server'
    context_flags = flags(server_build / 'CMakeFiles/server-context.dir/flags.make')
    redirect = runpy.run_path(str(Path(__file__).with_name('prepare-prompt-cache-engine.py')))['redirected_link']
    link = shlex.split((server_build / 'CMakeFiles/llama-server.dir/link.txt').read_text())
    # __FILE__ embeds the build source path. Reproduce the deployed artifact
    # using that exact read-only source path before staging a new path.
    repro = output / 'deployed-repro'; repro.mkdir()
    obj = repro / 'server-context.cpp.o'
    subprocess.run(['/usr/bin/c++', *context_flags, '-o', str(obj), '-c', str(deployed_prefix)], check=True)
    repro_archive = repro / 'libserver-context.a'; shutil.copy2(server_build / 'libserver-context.a', repro_archive)
    subprocess.run(['ar', 'r', str(repro_archive), str(obj)], check=True)
    subprocess.run(['ranlib', str(repro_archive)], check=True)
    subprocess.run(redirect(link, repro_archive, repro / 'llama-server'), cwd=server_build, check=True)
    if digest(repro / 'llama-server') != '3c25c5a9861e1a8410583e4f673d14671f09f55b72dd46b61b0b8efa747a2298':
        raise SystemExit('deployed exact-prefix binary was not reproduced')
    staged = output / 'tools/server'
    staged.mkdir(parents=True)
    for path in (source / 'tools/server').iterdir():
        if path.suffix in ['.h', '.hpp', '.cpp']:
            shutil.copy2(path, staged / path.name)
    shutil.copy2(baseline / 'tools/server/server-context.cpp', staged / 'server-context.cpp')
    header = repo / 'deploy/local-node/patches/larm-prompt-retention.h'
    patch = repo / 'deploy/local-node/patches/llama-prompt-retention-v1.patch'
    shutil.copy2(header, staged / header.name)
    subprocess.run(['git', 'apply', '--check', str(patch)], cwd=output, check=True)
    subprocess.run(['git', 'apply', str(patch)], cwd=output, check=True)
    archive = server_build / 'libserver-context.a'
    members = subprocess.check_output(['ar', 't', str(archive)], text=True).splitlines()
    if any(not re.fullmatch(r'[a-z-]+\.cpp\.o', name) for name in members):
        raise SystemExit('unexpected archive contents')
    main_flags = flags(server_build / 'CMakeFiles/llama-server.dir/flags.make')
    test_source = repo / 'deploy/local-node/patches/larm-prompt-retention-test.cpp'
    hashes = {str(path): digest(path) for path in [archive, header, patch, deployed_prefix, test_source]}
    objects = []
    for member in members:
        name = member[:-2]
        original_source = source / ('examples/diffusion' if name == 'diffusion.cpp' else 'tools/server') / name
        cached = server_build / 'CMakeFiles/server-context.dir' / ('__/__/examples/diffusion/' + member if name == 'diffusion.cpp' else member)
        if name == 'diffusion.cpp': shutil.copy2(original_source, staged / name)
        # Verify ALL source/header ABI inputs, not only server-context.cpp.
        if name != 'server-context.cpp':
            unchanged = output / ('baseline-' + member)
            subprocess.run(['/usr/bin/c++', *context_flags, '-o', str(unchanged), '-c', str(original_source)], check=True)
            if digest(unchanged) != digest(cached):
                raise SystemExit('source/headers do not reproduce pinned archive member: ' + member)
            hashes[str(cached)] = digest(cached)
        obj = output / member
        subprocess.run(['/usr/bin/c++', '-I' + str(staged), *context_flags, '-o', str(obj), '-c', str(staged / name)], check=True)
        objects.append(obj)
        print('compiled ' + name, flush=True)
    candidate_archive = output / 'libserver-context.a'
    subprocess.run(['ar', 'rcs', str(candidate_archive), *map(str, objects)], check=True)
    main_obj = output / 'server.cpp.o'
    original_main = output / 'unchanged-server.cpp.o'
    subprocess.run(['/usr/bin/c++', *main_flags, '-o', str(original_main), '-c', str(source / 'tools/server/server.cpp')], check=True)
    cached_main = server_build / 'CMakeFiles/llama-server.dir/server.cpp.o'
    if digest(original_main) != digest(cached_main):
        raise SystemExit('main source/headers do not reproduce pinned object')
    hashes[str(cached_main)] = digest(cached_main)
    subprocess.run(['/usr/bin/c++', '-I' + str(staged), *main_flags, '-o', str(main_obj), '-c', str(staged / 'server.cpp')], check=True)
    link = shlex.split((server_build / 'CMakeFiles/llama-server.dir/link.txt').read_text())
    redirect = runpy.run_path(str(Path(__file__).with_name('prepare-prompt-cache-engine.py')))['redirected_link']
    command = redirect(link, candidate_archive, output / 'llama-server')
    old_main = 'CMakeFiles/llama-server.dir/server.cpp.o'
    if command.count(old_main) != 1:
        raise SystemExit('unsupported main object')
    command[command.index(old_main)] = str(main_obj)
    subprocess.run(command, cwd=server_build, check=True)
    test_obj = output / 'retention-test.cpp.o'
    subprocess.run(['/usr/bin/c++', '-I' + str(staged), *context_flags, '-UNDEBUG', '-o', str(test_obj), '-c', str(test_source)], check=True)
    test_link = redirect(link, candidate_archive, output / 'retention-test')
    test_link[test_link.index(old_main)] = str(test_obj)
    subprocess.run(test_link, cwd=server_build, check=True)
    subprocess.run([str(output / 'retention-test')], check=True)
    if any(digest(path) != h for path, h in hashes.items()):
        raise SystemExit('baseline or reviewed patch changed during build')
    manifest = {'protocol': 'larm-prompt-cache.v1', 'baselineReproduced': True,
                'baselineExecutableSha256': digest(repro / 'llama-server'),
                'executableSha256': digest(output / 'llama-server'), 'patchSha256': digest(patch),
                'headerSha256': digest(header), 'nativeTestsPassed': True, 'providerStarted': False,
                'inputSha256': hashes, 'sourceSha256': {p.name: digest(p) for p in staged.iterdir() if p.suffix in ['.cpp', '.h']}}
    (output / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({k:v for k,v in manifest.items() if k not in ['inputSha256','sourceSha256']}))


if __name__ == '__main__':
    main()
