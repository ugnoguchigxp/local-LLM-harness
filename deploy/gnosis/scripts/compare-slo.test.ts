import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const comparator = resolve(import.meta.dir, "compare-slo.ts");
const commit = "a".repeat(40);
const configRevision = "b".repeat(64);

test("comparator publishes a fail-closed result without overwriting evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-slo-comparator-"));
  const summaryPath = join(root, "summary.json");
  const resultPath = join(root, "comparison.json");
  await writeFile(summaryPath, JSON.stringify({
    schemaVersion: 1,
    recordedAt: "2026-08-29T00:00:00Z",
    commit,
    configRevision,
    series: [{
      id: "llm-normal",
      promptClass: "llm-normal-fixed-control",
      maxTokens: 32,
      concurrency: 1,
      iterations: 3,
      successes: 3,
      errors: 0,
      errorRate: 0,
      fallbackCount: 0,
      provider429Count: 0,
      maxQueueDepth: 0,
      bootEpochs: ["epoch-test"],
      routes: ["llm-default"],
      runtimes: ["qwen-general"],
      releases: ["qwen-general-current"],
      latencyMs: { ttfbP95: 10, totalP95: 20, startupP95: 1 },
      memoryHeadroomMinBytes: { system: 1_000, accelerator: 2_000 },
    }],
  }));
  const run = () => Bun.spawn(["bun", "run", comparator], {
    env: {
      ...Bun.env,
      LARM_SLO_SUMMARY: summaryPath,
      LARM_SLO_EXPECTED_COMMIT: commit,
      LARM_SLO_EXPECTED_CONFIG_REVISION: configRevision,
      LARM_SLO_OUTPUT: resultPath,
    },
    stderr: "ignore",
    stdout: "ignore",
  }).exited;
  try {
    expect(await run()).toBe(1);
    const before = await readFile(resultPath, "utf8");
    expect(JSON.parse(before)).toEqual({
      schemaVersion: 1,
      passed: false,
      failures: [{ code: "manifest_uncalibrated" }],
    });
    expect((await lstat(resultPath)).mode & 0o777).toBe(0o600);
    expect(await run()).not.toBe(0);
    expect(await readFile(resultPath, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
