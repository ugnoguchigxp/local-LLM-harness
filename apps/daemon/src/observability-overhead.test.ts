import { expect, test } from "bun:test";

const script = new URL("./observability-overhead.ts", import.meta.url).pathname;
test("overhead diagnostic exercises all transports, concurrency, slow reader and failing collector", async () => {
  const child = Bun.spawn(["bun", "run", script], { env: { ...Bun.env,
    LARM_OVERHEAD_USAGE_COMPARISON: undefined,
    LARM_OVERHEAD_READINESS_COMPARISON: undefined,
    LARM_OVERHEAD_TRACE_SAMPLE_RATIO: "1", LARM_OVERHEAD_P95_BUDGET_MS: undefined,
    LARM_OVERHEAD_ITERATIONS: "10", LARM_OVERHEAD_ROUNDS: "1", LARM_OVERHEAD_CONCURRENCY: "2",
    LARM_OVERHEAD_WORKLOADS: "json,sse,asr,tts,mixed", LARM_OVERHEAD_COLLECTOR_STATUS: "503",
    LARM_OVERHEAD_COLLECTOR_DELAY_MS: "10", LARM_OVERHEAD_EXPORT_TIMEOUT_MS: "40", LARM_OVERHEAD_READ_DELAY_MS: "1",
  }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe(""); expect(code).toBe(0);
  const report = JSON.parse(stdout);
  expect(report).toMatchObject({ schemaVersion: 2, passed: true, conditions: { concurrency: 2, collectorStatus: 503 } });
  expect(report.cases.map((item: { workload: string }) => item.workload)).toEqual(["json", "sse", "asr", "tts", "mixed"]);
  for (const item of report.cases) {
    expect(item.modes.map((mode: { mode: string }) => mode.mode)).toEqual(["disabled", "metrics", "sampled"]);
    expect(item.modes[2].traceDelivery.failedBatches).toBeGreaterThan(0);
    expect(item.modes[2].latencyMs.p95).toBeGreaterThanOrEqual(0);
  }
}, 20000);

test("usage overhead comparison runs authenticated protection across all transports", async () => {
  const child = Bun.spawn(["bun", "run", script], { env: { ...Bun.env,
    LARM_OVERHEAD_USAGE_COMPARISON: "true", LARM_OVERHEAD_TRACE_SAMPLE_RATIO: "0",
    LARM_OVERHEAD_READINESS_COMPARISON: "true", LARM_OVERHEAD_READINESS_SAMPLES: "1",
    LARM_OVERHEAD_ITERATIONS: "10", LARM_OVERHEAD_ROUNDS: "1", LARM_OVERHEAD_CONCURRENCY: "2",
    LARM_OVERHEAD_P95_BUDGET_MS: undefined, LARM_OVERHEAD_OUTPUT: undefined,
    LARM_OVERHEAD_WORKLOADS: "json,sse,asr,tts,mixed",
  }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe(""); expect(code).toBe(0);
  const report = JSON.parse(stdout);
  expect(report).toMatchObject({ schemaVersion: 3, kind: "larm-usage-overhead", passed: true });
  expect(report.readinessLatencyMs.results.map((value: { pollIntervalMs: number }) => value.pollIntervalMs)).toEqual([500, 1000]);
  for (const item of report.cases) {
    expect(item.modes.map((mode: { mode: string }) => mode.mode)).toEqual(["usage-disabled", "usage-enabled"]);
    expect(item.modes[1].requestsPerSecond).toBeGreaterThan(0);
  }
}, 20000);
