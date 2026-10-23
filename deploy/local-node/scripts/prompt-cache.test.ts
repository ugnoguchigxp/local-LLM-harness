import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { promptCacheCandidate } from "./prepare-prompt-cache-config";
import { assertReuse, cacheSample } from "./verify-prompt-cache";

// Reconstruct the disabled predecessor while checking preservation of the
// current catalog's other Providers. Live configuration is never read in tests.
function legacySource(): string {
  const config = parse(readFileSync(new URL("../../../config/local-node/llama-swap.yaml", import.meta.url), "utf8"));
  config.models["ornith15-strix-conversation"].cmd = config.models["ornith15-strix-conversation"].cmd
    .replace(/^\/usr\/bin\/python3\s+\S+\/launch-prompt-retention\.py\s+\S+\s+/, "")
    .replace("--no-kv-unified", "--kv-unified")
    .replace(/-cram\s+8192\b/, "-cram 0")
    .replace("--cache-prompt", "--no-cache-prompt")
    .replace(/-ctxcp\s+8\b/, "-ctxcp 0")
    .replace(/-cpent\s+1024\b/, "");
  return stringify(config);
}

test("candidate preserves the shared pool, four slots, model and other Providers", () => {
  const source = legacySource();
  const before = parse(source);
  const after = parse(promptCacheCandidate(source, "/staging/llama-server"));
  const cmd = after.models["ornith15-strix-conversation"].cmd as string;
  expect(cmd).toContain("--cache-prompt");
  expect(cmd).toContain("-ctxcp 8");
  expect(cmd).toContain("-cpent 1024");
  for (const flag of ["--parallel 4", "--ctx-size 1048576", "--spec-type none", "-cram 0", "--no-cache-idle-slots", "--cache-reuse 0"]) expect(cmd).toContain(flag);
  after.models["ornith15-strix-conversation"].cmd = before.models["ornith15-strix-conversation"].cmd;
  expect(after).toEqual(before);
  expect(() => promptCacheCandidate(source.replaceAll("--parallel 4", "--parallel 3"), "/staging/llama-server")).toThrow();
  expect(() => promptCacheCandidate(source, "/staging/bad path")).toThrow();
});

test("numeric evidence preserves cache counters and excludes content and credentials", () => {
  const sample = cacheSample({ timings: { prompt_n: 4, cache_n: 3036, prompt_ms: 12 },
    usage: { prompt_tokens: 3040, prompt_tokens_details: { cached_tokens: 3036 } },
    choices: [{ finish_reason: "stop", message: { content: "must not escape" } }], token: "must not escape" });
  expect(sample).toEqual({ prompt_n: 4, cache_n: 3036, prompt_ms: 12, prompt_tokens: 3040, cached_tokens: 3036 });
  expect(() => assertReuse(sample, sample.prompt_tokens, 32)).not.toThrow();
  expect(() => assertReuse({ ...sample, cache_n: 0, cached_tokens: 0 }, 3040, 32)).toThrow();
  expect(() => cacheSample({ timings: { prompt_n: 4, cache_n: 1, prompt_ms: 12 }, usage: { prompt_tokens: 3040, prompt_tokens_details: { cached_tokens: 2 } } })).toThrow();
  expect(() => cacheSample({})).toThrow();
  for (const [expected, tolerance] of [[NaN, 32], [3040, NaN], [32, 32], [3.5, 0], [3040, -1]]) expect(() => assertReuse(sample, expected!, tolerance!)).toThrow();
});

test("candidate rejects prefix matches, duplicate flags and conflicting aliases", () => {
  const source = legacySource();
  for (const override of ["--parallel 40", "--parallel 4 --parallel 1", "--parallel 4 -np 1", "--parallel 4 --parallel=1"]) {
    expect(() => promptCacheCandidate(source.replaceAll("--parallel 4", override), "/staging/llama-server")).toThrow();
  }
  for (const override of ["--no-cache-prompt --cache-prompt", "--no-cache-prompt -cpent 16", "--no-cache-prompt --ctx-checkpoints 0"]) {
    expect(() => promptCacheCandidate(source.replaceAll("--no-cache-prompt", override), "/staging/llama-server")).toThrow();
  }
});

test("cache evidence rejects partial responses and impossible token accounting", () => {
  const valid = { timings: { prompt_n: 4, cache_n: 3036, prompt_ms: 12 }, usage: { prompt_tokens: 3040, prompt_tokens_details: { cached_tokens: 3036 } }, choices: [{ finish_reason: "stop" }] };
  for (const bad of [
    { ...valid, choices: [] }, { ...valid, choices: [{ finish_reason: null }] },
    { ...valid, timings: { ...valid.timings, prompt_n: 3 } },
    { ...valid, timings: { ...valid.timings, cache_n: 3036.5 } },
    { ...valid, timings: { ...valid.timings, prompt_ms: Infinity } },
  ]) expect(() => cacheSample(bad)).toThrow();
});

test("config CLI requires reproduced build provenance and never overwrites a candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "larm-prompt-cache-test-"));
  try {
    const engine = join(dir, "llama-server"), output = join(dir, "candidate.yaml"), input = join(dir, "baseline.yaml");
    writeFileSync(input, legacySource());
    writeFileSync(engine, "fixture executable");
    const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
    const manifest = { executableSha256: hash("fixture executable"),
      promptCachePatchSha256: hash(readFileSync(new URL("../patches/llama-prompt-cache-exact-prefix-v1.patch", import.meta.url))) };
    const invoke = () => spawnSync(process.execPath, [new URL("./prepare-prompt-cache-config.ts", import.meta.url).pathname,
      input, engine, output], { encoding: "utf8" });
    writeFileSync(join(dir, "build-manifest.json"), JSON.stringify(manifest));
    expect(invoke().status).not.toBe(0);
    writeFileSync(join(dir, "build-manifest.json"), JSON.stringify({ ...manifest, baselineReproduced: true }));
    expect(invoke().status).toBe(0);
    const initial = readFileSync(output, "utf8");
    expect(invoke().status).not.toBe(0);
    expect(readFileSync(output, "utf8")).toBe(initial);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
