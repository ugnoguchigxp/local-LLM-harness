import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { LarmClient } from "../../../packages/client/src/index";
import { daemonHealthSchema } from "../../../packages/core/src/index";

const output = process.env.LARM_BENCHMARK_OUTPUT;
const commit = process.env.LARM_BENCHMARK_COMMIT;
if (!output || !isAbsolute(output)) throw new Error("LARM_BENCHMARK_OUTPUT must be an absolute repository-external path");
if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("LARM_BENCHMARK_COMMIT must be a full commit hash");
const repoRoot = resolve(import.meta.dir, "../../..");
const target = resolve(output);
const fromRepo = relative(repoRoot, target);
if (fromRepo === "" || (!fromRepo.startsWith("..") && !isAbsolute(fromRepo))) {
  throw new Error("benchmark raw output must stay outside the repository");
}
const iterations = Number(process.env.LARM_BENCHMARK_ITERATIONS ?? 3);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) {
  throw new Error("LARM_BENCHMARK_ITERATIONS must be between 1 and 100");
}
const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
const authHeaders = process.env.LARM_API_TOKEN
  ? { authorization: `Bearer ${process.env.LARM_API_TOKEN}` }
  : undefined;
const healthResponse = await fetch(`${baseUrl}/health`, {
  headers: authHeaders,
  signal: AbortSignal.timeout(2_000),
});
if (!healthResponse.ok) throw new Error(`LARM health returned HTTP ${healthResponse.status}`);
const health = daemonHealthSchema.parse(await healthResponse.json());
const client = new LarmClient({ baseUrl, apiToken: process.env.LARM_API_TOKEN });
const samples: Array<Record<string, unknown>> = [];
const memoryHeadroomMinBytes: { system?: number; accelerator?: number } = {};
let monitorMemory = true;
const memoryMonitor = (async () => {
  while (monitorMemory) {
    const metrics = await fetch(`${baseUrl}/metrics`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(2_000),
    })
      .then((response) => response.ok ? response.text() : "")
      .catch(() => "");
    for (const [name, key] of [
      ["larm_system_memory_available_bytes", "system"],
      ["larm_accelerator_memory_available_bytes", "accelerator"],
    ] as const) {
      const match = metrics.match(new RegExp(`^${name} ([0-9]+(?:\\.[0-9]+)?)$`, "m"));
      if (!match?.[1]) continue;
      const value = Number(match[1]);
      memoryHeadroomMinBytes[key] = Math.min(memoryHeadroomMinBytes[key] ?? value, value);
    }
    await Bun.sleep(100);
  }
})();

try {
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  const startedAt = performance.now();
  let firstByteAt: number | undefined;
  const binding = await client.withAllocation({
    requirements: [{ capability: "llm.general", route: "llm-default" }],
    allowFallback: false,
    deploymentPolicy: "existing-only",
    ttlSeconds: 120,
  }, async (allocation, larm) => {
    const response = await larm.chat(allocation.id, {
      model: "larm",
      stream: true,
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("benchmark response body is missing");
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      firstByteAt ??= performance.now();
    }
    return allocation.bindings[0];
  });
  const completedAt = performance.now();
  samples.push({
    iteration,
    promptClass: "fixed-short-control",
    maxTokens: 32,
    concurrency: 1,
    route: binding?.route,
    runtime: binding?.runtime,
    release: binding?.release,
    fallback: binding?.fallback,
    ttfbMs: firstByteAt === undefined ? null : firstByteAt - startedAt,
    totalMs: completedAt - startedAt,
  });
}
} finally {
  monitorMemory = false;
  await memoryMonitor;
}

await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify({
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  commit,
  ...health,
  memoryHeadroomMinBytes,
  samples,
}, null, 2)}\n`, { mode: 0o600 });

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}
const totals = samples.map((sample) => sample.totalMs as number);
const ttfbs = samples.map((sample) => sample.ttfbMs).filter((value): value is number => typeof value === "number");
const routes = [...new Set(samples.map((sample) => sample.route).filter((value): value is string => typeof value === "string"))];
const runtimes = [...new Set(samples.map((sample) => sample.runtime).filter((value): value is string => typeof value === "string"))];
const releases = [...new Set(samples.map((sample) => sample.release).filter((value): value is string => typeof value === "string"))];
console.log(JSON.stringify({
  commit,
  configRevision: health.configRevision,
  bootEpoch: health.bootEpoch,
  iterations,
  promptClass: "fixed-short-control",
  maxTokens: 32,
  concurrency: 1,
  routes,
  runtimes,
  releases,
  memoryHeadroomMinBytes,
  totalMs: { mean: totals.reduce((sum, value) => sum + value, 0) / totals.length, p95: percentile(totals, 0.95) },
  ttfbMs: { mean: ttfbs.reduce((sum, value) => sum + value, 0) / ttfbs.length, p95: percentile(ttfbs, 0.95) },
  rawOutput: target,
}));
