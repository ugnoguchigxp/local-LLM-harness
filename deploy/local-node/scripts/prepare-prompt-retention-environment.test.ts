import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { preparePromptRetentionEnvironment } from "./prepare-prompt-retention-environment";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "larm-retention-env-test-")); roots.push(root);
  const credentialPath = join(root, "daemon.env"), outputPath = join(root, "retention.json");
  writeFileSync(credentialPath, `LARM_API_TOKEN=unrelated\nLARM_PROMPT_CACHE_KEY=${"a".repeat(64)}\n`, { mode: 0o600 });
  return { credentialPath, outputPath, configDir: resolve(import.meta.dir, "../../../config/local-node"),
    uid: process.getuid!(), gid: process.getgid!() };
}

test("installation gives daemon and engine the same key and bounded runtime policy", () => {
  const f = fixture(); preparePromptRetentionEnvironment(f);
  const first = readFileSync(f.outputPath, "utf8");
  const env = JSON.parse(first);
  expect(Object.keys(env).sort()).toEqual(["LARM_PROMPT_CACHE_KEY", "LARM_PROMPT_CACHE_POLICY"]);
  expect(env.LARM_PROMPT_CACHE_KEY).toBe("a".repeat(64));
  expect(JSON.parse(env.LARM_PROMPT_CACHE_POLICY)).toMatchObject({ protocol: "larm-prompt-cache.v1", maxBytes: 8 * 1024 ** 3 });
  expect(statSync(f.outputPath).mode & 0o777).toBe(0o600);
  preparePromptRetentionEnvironment(f);
  expect(readFileSync(f.outputPath, "utf8")).toBe(first);
});

test("installation refuses key mismatch, duplicate credentials and symlink outputs", () => {
  const f = fixture();
  const other = JSON.stringify({ LARM_PROMPT_CACHE_KEY: "b".repeat(64) });
  writeFileSync(f.outputPath, other, { mode: 0o600 });
  expect(() => preparePromptRetentionEnvironment(f)).toThrow("keys differ");
  expect(readFileSync(f.outputPath, "utf8")).toBe(other);
  rmSync(f.outputPath); symlinkSync(f.credentialPath, f.outputPath);
  expect(() => preparePromptRetentionEnvironment(f)).toThrow();
  rmSync(f.outputPath);
  writeFileSync(f.credentialPath, `LARM_PROMPT_CACHE_KEY=${"a".repeat(64)}\nLARM_PROMPT_CACHE_KEY=${"a".repeat(64)}\n`);
  expect(() => preparePromptRetentionEnvironment(f)).toThrow("key is missing or invalid");
});
