import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { preparePromptRetentionEnvironment } from "./prepare-prompt-retention-environment";
import { parse, stringify } from "yaml";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "larm-retention-env-test-")); roots.push(root);
  const credentialPath = join(root, "daemon.env"), outputPath = join(root, "retention.json");
  writeFileSync(credentialPath, `LARM_API_TOKEN=unrelated\nLARM_PROMPT_CACHE_KEY=${"a".repeat(64)}\n`, { mode: 0o600 });
  const configDir = join(root, "config");
  cpSync(resolve(import.meta.dir, "../../../config/local-node"), configDir, { recursive: true });
  return { credentialPath, outputPath, configDir,
    uid: process.getuid!(), gid: process.getgid!() };
}

test("installation shares the daemon key and 8 GiB policy while dedicated 24 GiB engines remain independent", () => {
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

test("installation refuses conflicting policies for engines using the same environment", () => {
  const f = fixture();
  const path = join(f.configDir, "runtimes.yaml");
  const runtimes = parse(readFileSync(path, "utf8"));
  runtimes.runtimes["lfm3-conversation"].promptRetention.maxBytes = 24 * 1024 ** 3;
  writeFileSync(path, stringify(runtimes));
  expect(() => preparePromptRetentionEnvironment(f)).toThrow("matching retention policies");
  expect(existsSync(f.outputPath)).toBe(false);
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
