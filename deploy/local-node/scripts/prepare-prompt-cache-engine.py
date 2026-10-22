#!/usr/bin/env python3
"""Relink a private candidate from the pinned build; never modify the live engine/build."""
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def redirected_link(command, archive, executable):
    """Only redirect the two known outputs; fail if the link recipe changed."""
    if command.count("-o") != 1 or command.count("libserver-context.a") != 1:
        raise SystemExit("unsupported link recipe")
    result = [str(archive) if arg == "libserver-context.a" else arg for arg in command
              if not arg.startswith("-Wl,--dependency-file=")]
    result[result.index("-o") + 1] = str(executable)
    return result


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: prepare-prompt-cache-engine.py SOURCE BUILD NEW_OUTPUT_DIRECTORY")
    source, build, output = [Path(p).resolve() for p in sys.argv[1:]]
    repo = Path(__file__).resolve().parents[3]
    if output == repo or repo in output.parents or output.exists():
        raise SystemExit("output must be a new directory outside the source repository")
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if revision != "0fc9568e07ccc8553010864cb8db1957e629cbfa":
        raise SystemExit("unsupported engine revision")
    baseline = build / "bin/llama-server"
    expected = "d7b699c6d8c051b54e357d730940647ff8331d11e7543e38c96921a6c09fc1bb"
    if digest(baseline) != expected:
        raise SystemExit("build must match the deployed chat-input engine")
    patch = repo / "deploy/local-node/patches/llama-prompt-cache-exact-prefix-v1.patch"
    original = source / "tools/server/server-context.cpp"
    original_hash = digest(original)
    if original_hash != "33bb285455b0b70d2c322e0d48830a4a2232bbe615cedc275302257e3ff97499":
        raise SystemExit("unsupported local engine source; preserve and review its changes")
    cache = (build / "CMakeCache.txt").read_text()
    if f"CMAKE_HOME_DIRECTORY:INTERNAL={source}\n" not in cache:
        raise SystemExit("build belongs to a different source directory")
    output.mkdir(mode=0o700, parents=True)
    staged = output / "tools/server/server-context.cpp"
    staged.parent.mkdir(parents=True)
    shutil.copy2(original, staged)
    subprocess.run(["git", "apply", "--check", str(patch)], cwd=output, check=True)
    subprocess.run(["git", "apply", str(patch)], cwd=output, check=True)
    server_build = build / "tools/server"
    flags_text = (server_build / "CMakeFiles/server-context.dir/flags.make").read_text()
    flags = []
    for name in ["CXX_DEFINES", "CXX_INCLUDES", "CXX_FLAGS"]:
        match = re.search(rf"^{name} = (.*)$", flags_text, re.MULTILINE)
        if not match:
            raise SystemExit("missing compiler flags")
        flags.extend(shlex.split(match[1]))
    # A binary digest alone cannot prove that cached libraries or the current
    # source/headers still match that binary. Reproduce both unchanged artifacts.
    unchanged = output / "unchanged-server-context.cpp.o"
    cached_object = server_build / "CMakeFiles/server-context.dir/server-context.cpp.o"
    subprocess.run(["/usr/bin/c++", *flags, "-o", str(unchanged), "-c", str(original)], check=True)
    if digest(unchanged) != digest(cached_object):
        raise SystemExit("source, headers, compiler or flags differ from the pinned object")
    link = shlex.split((server_build / "CMakeFiles/llama-server.dir/link.txt").read_text())
    inputs = [baseline, original, cached_object,
              server_build / "CMakeFiles/server-context.dir/flags.make",
              server_build / "CMakeFiles/llama-server.dir/link.txt"]
    output_index = link.index("-o") + 1
    inputs.extend((server_build / arg).resolve() for i, arg in enumerate(link[1:], 1)
                  if i != output_index and not arg.startswith("-") and (server_build / arg).is_file())
    hashes = {str(path): digest(path) for path in inputs}
    reproduced = output / "unchanged-llama-server"
    subprocess.run(redirected_link(link, server_build / "libserver-context.a", reproduced), cwd=server_build, check=True)
    if digest(reproduced) != expected:
        raise SystemExit("cached link inputs no longer reproduce the pinned executable")
    obj = output / "server-context.cpp.o"
    subprocess.run(["/usr/bin/c++", *flags, "-o", str(obj), "-c", str(staged)], check=True)
    archive = output / "libserver-context.a"
    shutil.copy2(server_build / archive.name, archive)
    subprocess.run(["ar", "r", str(archive), str(obj)], check=True)
    subprocess.run(["ranlib", str(archive)], check=True)
    # Keep all baseline libraries/objects; replace only the patched archive and output.
    subprocess.run(redirected_link(link, archive, output / "llama-server"), cwd=server_build, check=True)
    if any(digest(path) != value for path, value in hashes.items()):
        raise SystemExit("baseline changed during build; do not deploy candidate")
    manifest = {"upstreamRevision": revision, "baselineExecutableSha256": expected,
                "executableSha256": digest(output / "llama-server"),
                "promptCachePatchSha256": digest(patch), "sourceSha256": original_hash,
                "patchedSourceSha256": digest(staged), "baselineReproduced": True,
                "inputSha256": hashes, "liveValidated": False}
    (output / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
