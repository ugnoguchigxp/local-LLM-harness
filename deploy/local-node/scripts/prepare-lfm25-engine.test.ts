import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const revision = "d05706b4f32a545814856e98ca518292585443b9";
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "larm-lfm-engine-test-"));
  temporaryDirectories.push(root);
  const source = join(root, "source"), build = join(root, "build"), runtime = join(root, "runtime");
  mkdirSync(join(source, ".git"), { recursive: true });
  mkdirSync(join(build, "bin"), { recursive: true });
  mkdirSync(join(root, "tools"));
  // Model only the external Git/build tools; exercise the real packaging script.
  writeFileSync(join(root, "tools/git"), `#!/usr/bin/env bash
case "$3" in
  status) exit 0 ;;
  rev-parse) printf '%s\\n' '${revision}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const binary = join(build, "bin/llama-server");
  writeFileSync(binary, "#!/usr/bin/env bash\necho 'version: d05706b'\n", { mode: 0o755 });
  writeFileSync(join(build, "bin/libfixture.so"), "fixture library");
  const cache = (vulkan = "ON", type = "Release", origin = source) => {
    writeFileSync(join(build, "CMakeCache.txt"), `CMAKE_HOME_DIRECTORY:INTERNAL=${origin}\nGGML_VULKAN:BOOL=${vulkan}\nCMAKE_BUILD_TYPE:STRING=${type}\n`);
  };
  cache();
  const run = () => Bun.spawnSync(["bash", join(import.meta.dir, "prepare-lfm25-engine.sh")], {
    env: { ...process.env, PATH: `${join(root, "tools")}:${process.env.PATH}`,
      LARM_LFM25_ENGINE_SOURCE: source, LARM_LFM25_ENGINE_BUILD: build, LARM_LFM25_ENGINE_ROOT: runtime },
  });
  return { root, source, build, runtime, binary, cache, run };
}

test("engine packaging rejects CPU, debug and unrelated builds before publishing", () => {
  const f = fixture();
  for (const [vulkan, type, origin, error] of [
    ["OFF", "Release", f.source, "must enable Vulkan"],
    ["ON", "Debug", f.source, "must use Release"],
    ["ON", "Release", f.root, "does not belong"],
  ]) {
    f.cache(vulkan, type, origin);
    const result = f.run();
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain(error!);
    expect(existsSync(f.runtime)).toBe(false);
  }
});

test("engine packaging publishes a runnable checked bundle and preserves an existing destination", () => {
  const f = fixture();
  expect(f.run().exitCode).toBe(0);
  expect(readFileSync(join(f.runtime, "SOURCE_REVISION"), "utf8").trim()).toBe(revision);
  expect(Bun.spawnSync([join(f.runtime, "llama-server"), "--version"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["sha256sum", "--check", "SHA256SUMS"], { cwd: f.runtime }).exitCode).toBe(0);
  const manifest = readFileSync(join(f.runtime, "SHA256SUMS"), "utf8");
  expect(f.run().exitCode).not.toBe(0);
  expect(readFileSync(join(f.runtime, "SHA256SUMS"), "utf8")).toBe(manifest);
});

test("failed binary verification leaves no published or partially staged runtime", () => {
  const f = fixture();
  writeFileSync(f.binary, "#!/usr/bin/env bash\necho 'version: other'\n");
  expect(f.run().exitCode).not.toBe(0);
  expect(existsSync(f.runtime)).toBe(false);
  expect(readdirSync(f.root).some(name => name.startsWith("runtime.preparing."))).toBe(false);
});
