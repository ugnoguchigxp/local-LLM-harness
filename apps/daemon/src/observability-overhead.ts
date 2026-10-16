import { resolve } from "node:path";
import { Hono } from "hono";
import { UsageCoordinator } from "./usage-coordinator";
import { usagePolicy } from "./usage-policy";
import { agentPrincipal } from "./agent-connection-controller";
import { authenticatedBearerKinds, secretMatcher } from "./app-auth";
import { AllocationNotifications } from "./allocation-notifications";
import type { Allocation } from "@larm/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { RuntimeDefinition, RuntimeProtocol } from "@larm/core";
import { Observability } from "./observability";
import { MetricsRegistry } from "./metrics";
import { ExecutionGate } from "./execution-gate";
import { proxyGateway } from "./gateway";
import { startProcessMetrics } from "./process-metrics";
import { summarize } from "../../../deploy/local-node/scripts/performance-helpers";
import { absoluteOutput, prepareExternalOutput, writeExclusive } from "../../../deploy/local-node/scripts/benchmark-helpers";

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_${name.toLowerCase()}`);
  return value;
}
const iterations = integer("LARM_OVERHEAD_ITERATIONS", 1000, 10, 10000);
const rounds = integer("LARM_OVERHEAD_ROUNDS", 5, 1, 20);
const concurrency = integer("LARM_OVERHEAD_CONCURRENCY", 1, 1, 16);
const readDelayMs = integer("LARM_OVERHEAD_READ_DELAY_MS", 0, 0, 1000);
const collectorDelayMs = integer("LARM_OVERHEAD_COLLECTOR_DELAY_MS", 0, 0, 2000);
const exportTimeoutMs = integer("LARM_OVERHEAD_EXPORT_TIMEOUT_MS", 2000, 20, 10000);
const collectorStatus = integer("LARM_OVERHEAD_COLLECTOR_STATUS", 200, 200, 503);
if (![200, 503].includes(collectorStatus)) throw new Error("collector_status_must_be_200_or_503");
const budget = process.env.LARM_OVERHEAD_P95_BUDGET_MS === undefined ? undefined : Number(process.env.LARM_OVERHEAD_P95_BUDGET_MS);
if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) throw new Error("invalid_p95_budget");
const allWorkloads = ["json", "sse", "asr", "tts", "mixed"] as const;
type Workload = typeof allWorkloads[number];
type Inference = Exclude<Workload, "mixed">;
const workloads = (process.env.LARM_OVERHEAD_WORKLOADS ?? allWorkloads.join(",")).split(",");
if (workloads.some(value => !allWorkloads.includes(value as Workload)) || new Set(workloads).size !== workloads.length) throw new Error("invalid_overhead_workloads");
if (iterations * rounds * concurrency * workloads.length * 3 > 200000) throw new Error("overhead_sample_limit_exceeded");
const compareUsage = process.env.LARM_OVERHEAD_USAGE_COMPARISON === "true";
const compareReadiness = process.env.LARM_OVERHEAD_READINESS_COMPARISON === "true";
const traceSampleRatio = Number(process.env.LARM_OVERHEAD_TRACE_SAMPLE_RATIO ?? (compareUsage ? 0 : 1));
if (!Number.isFinite(traceSampleRatio) || traceSampleRatio < 0 || traceSampleRatio > 1) throw new Error("invalid_trace_sample_ratio");
const processMetrics = process.env.LARM_OVERHEAD_PROCESS_METRICS === "true";
let exportedBatches = 0;
const collector = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  await request.arrayBuffer(); exportedBatches++;
  if (collectorDelayMs) await Bun.sleep(collectorDelayMs);
  return Response.json({}, { status: collectorStatus });
} });
const metadata = { id: "chatcmpl-fixture", created: 1, model: "fixture" };
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const completion = { ...metadata, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage };
const event = (choices: unknown[], extra = {}) => new TextEncoder().encode(`data: ${JSON.stringify({ ...metadata, object: "chat.completion.chunk", choices, ...extra })}\n\n`);
const sse = [event([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]), event([{ index: 0, delta: { content: "ok" }, finish_reason: null }]), event([{ index: 0, delta: {}, finish_reason: "stop" }]), event([], { usage }), new TextEncoder().encode("data: [DONE]\n\n")];
const wav = new Uint8Array(44 + 16384);
for (const [offset, value] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i);
const view = new DataView(wav.buffer);
view.setUint32(4, wav.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
view.setUint32(24, 8192, true); view.setUint32(28, 16384, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 16384, true);
function chunks(values: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({ pull(controller) { const value = values[index++]; if (value) controller.enqueue(value); else controller.close(); } });
}
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  await request.arrayBuffer(); // Exercise complete uploads, including multipart ASR.
  const path = new URL(request.url).pathname;
  if (path === "/asr") return Response.json({ text: "fixture", duration: 1 });
  if (path === "/tts") return new Response(chunks([wav.subarray(0, 44), wav.subarray(44, 8192), wav.subarray(8192)]), { headers: { "content-type": "audio/wav" } });
  if (path === "/sse") return new Response(chunks(sse), { headers: { "content-type": "text/event-stream" } });
  return Response.json(completion);
} });
const protocol: Record<Inference, RuntimeProtocol> = { json: "openai.chat-completions.v1", sse: "openai.chat-completions.v1", asr: "openai.audio-transcriptions.v1", tts: "openai.audio-speech.v1" };
const modes = compareUsage ? ["usage-disabled", "usage-enabled"] as const : ["disabled", "metrics", "sampled"] as const;
const paths = { json: "/v1/chat/completions", sse: "/v1/chat/completions?stream=true", asr: "/v1/audio/transcriptions", tts: "/v1/audio/speech" };
const fixtures = modes.map(mode => {
  const metrics = new MetricsRegistry();
  const observation = mode === "disabled" ? undefined : new Observability(metrics, {
    sampleRatio: (mode === "sampled" || compareUsage) ? traceSampleRatio : 0, exportTimeoutMs,
    exporter: (mode === "sampled" || (compareUsage && traceSampleRatio > 0)) ? new OTLPTraceExporter({ url: `${collector.url.origin}/v1/traces`, timeoutMillis: exportTimeoutMs }) : undefined,
  });
  const gate = new ExecutionGate();
  const app = new Hono();
  if (observation) app.use("*", observation.middleware());
  if (compareUsage) {
    const authenticate = secretMatcher("Bearer fixture-consumer");
    app.use("*", async (c, next) => {
      if (!authenticate(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
      authenticatedBearerKinds.set(c.req.raw, "protected");
      await next();
    });
  }
  if (mode === "usage-enabled") {
    const coordinator = new UsageCoordinator(undefined, metrics, agentPrincipal("fixture-consumer"));
    coordinator.run(agentPrincipal("fixture-consumer"), () => coordinator.prepare(600_000)(true));
    app.use("*", usagePolicy(coordinator, "fixture-consumer"));
  }
  app.post("*", c => {
    const workload: Inference = c.req.path.endsWith("transcriptions") ? "asr" : c.req.path.endsWith("speech") ? "tts" : new URL(c.req.url).searchParams.has("stream") ? "sse" : "json";
    const runtime: RuntimeDefinition = {
      id: workload === "sse" ? "json" : workload, capability: ["fixture"], protocol: protocol[workload], backend: "systemd", node: "fixture",
      policy: { class: "resident" }, resources: { estimatedMemoryGB: 1, maxConcurrentRequests: workload === "tts" ? 1 : concurrency, maxQueuedRequests: 128, queueTimeoutMs: 10000 },
      deployment: { endpoint: upstream.url.origin, backendEndpoint: upstream.url.origin, service: "fixture.service", healthPort: Number(upstream.port) },
    };
    return proxyGateway({
      request: c.req.raw, allocationId: "alloc_fixture", runtime, protocol: protocol[workload], upstreamPath: `/${workload}`,
      bodyMode: workload === "asr" ? "stream" : "buffered", maxBodyBytes: 65536, timeoutMs: 30000, bootEpoch: "fixture", executionGate: gate, metrics,
      validateChatResponse: workload === "json", validateTranscriptionResponse: workload === "asr", validateSpeechResponse: workload === "tts",
      responseFormat: workload === "sse" ? "sse" : undefined,
      revalidate: () => ({ ok: true, binding: { endpoint: runtime.deployment.endpoint, runtime: runtime.id } }),
    });
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  return { mode, metrics, observation, server };
});
async function sample(url: string, workload: Inference): Promise<number> {
  let body: string | FormData;
  if (workload === "asr") { body = new FormData(); body.append("file", new Blob([wav]), "fixture.wav"); }
  else body = JSON.stringify(workload === "tts" ? { model: "fixture", input: "fixture", voice: "fixture", response_format: "wav" } : { model: "fixture", messages: [{ role: "user", content: "fixture" }], max_tokens: 1, stream: workload === "sse" });
  const start = performance.now();
  const response = await fetch(`${url}${paths[workload]}`, { method: "POST", headers: { authorization: "Bearer fixture-consumer", ...(typeof body === "string" ? { "content-type": "application/json" } : {}) }, body });
  if (readDelayMs && (workload === "tts" || workload === "sse")) {
    const reader = response.body!.getReader();
    while (!(await reader.read()).done) await Bun.sleep(readDelayMs);
  } else await response.arrayBuffer();
  if (!response.ok) throw new Error(`fixture_http_${response.status}`);
  return performance.now() - start;
}
const cases: unknown[] = [];
async function readinessComparison() {
  if (!compareReadiness) return null;
  const samples = integer("LARM_OVERHEAD_READINESS_SAMPLES", 5, 1, 20);
  const results = [];
  for (const pollIntervalMs of [500, 1000]) {
    const times = { polling: [] as number[], notification: [] as number[] };
    for (const mode of ["polling", "notification"] as const) for (let i = 0; i < samples; i++) {
      const notifications = new AllocationNotifications();
      const allocation = { status: "pending" } as Allocation;
      let readyAt = 0;
      const timer = setTimeout(() => { allocation.status = "ready"; readyAt = performance.now(); notifications.notify("fixture"); }, 5);
      try {
        if (mode === "notification") await notifications.wait("fixture", () => allocation, undefined, 5000);
        else while (allocation.status === "pending") await Bun.sleep(pollIntervalMs);
        times[mode].push(performance.now() - readyAt);
        if (notifications.size) throw new Error("readiness_waiter_leak");
      } finally { clearTimeout(timer); }
    }
    results.push({ pollIntervalMs, samples, polling: summarize(times.polling), notification: summarize(times.notification) });
  }
  return { scope: "synthetic internal allocation transition to waiter resumption; excludes engine load and semantic readiness", readyAfterMs: 5, results };
}
try {
  for (const workload of workloads as Workload[]) {
    const inference: Inference[] = workload === "mixed" ? ["sse", "asr", "tts"] : [workload];
    const reports = fixtures.map(fixture => ({ fixture, samples: [] as number[], blocks: [] as ReturnType<typeof summarize>[], processSamples: 0, elapsedMs: 0 }));
    const batch = (url: string) => Promise.all(Array.from({ length: concurrency }, () => inference.map(kind => sample(url, kind))).flat());
    for (const { fixture } of reports) for (let i = 0; i < 10; i++) await batch(fixture.server.url.origin);
    for (let round = 0; round < rounds; round++) {
      for (let offset = 0; offset < reports.length; offset++) {
        const report = reports[(round + offset) % reports.length]!;
        const sampleCount = () => Number(/^larm_event_loop_delay_seconds_count ([0-9]+)$/m.exec(report.fixture.metrics.render())?.[1] ?? 0);
        const beforeProcessSamples = sampleCount();
        const stop = processMetrics && report.fixture.observation ? startProcessMetrics(report.fixture.metrics) : () => {};
        const block: number[] = [];
        const blockStarted = performance.now();
        try { for (let i = 0; i < iterations; i++) block.push(...await batch(report.fixture.server.url.origin)); }
        finally { report.elapsedMs += performance.now() - blockStarted; stop(); }
        report.processSamples += sampleCount() - beforeProcessSamples;
        report.samples.push(...block); report.blocks.push(summarize(block));
        await report.fixture.observation?.provider.forceFlush().catch(() => undefined);
        report.fixture.observation?.collect();
      }
    }
    const baseline = summarize(reports[0]!.samples)!;
    cases.push({ workload, concurrency, requestsPerMode: iterations * rounds * concurrency * inference.length,
      modes: reports.map(({ fixture, samples, blocks, processSamples, elapsedMs }) => {
        const latencyMs = summarize(samples)!;
        const p95DifferenceMs = Number((latencyMs.p95 - baseline.p95).toFixed(3));
        return { mode: fixture.mode, latencyMs, blocks, processSamples, p95DifferenceMs, requestsPerSecond: samples.length / (elapsedMs / 1000),
          budgetPassed: budget === undefined || (fixture.mode === "disabled" || fixture.mode === "usage-disabled") ? null : p95DifferenceMs <= budget,
          traceDelivery: fixture.observation?.delivery?.snapshot() ?? null };
      }),
    });
  }
  const budgetPassed = (cases as Array<{ modes: Array<{ budgetPassed: boolean | null }> }>).every(item => item.modes.every(mode => mode.budgetPassed !== false));
  const report = {
    schemaVersion: compareUsage ? 3 : 2, kind: compareUsage ? "larm-usage-overhead" : "larm-observability-overhead", recordedAt: new Date().toISOString(), bun: Bun.version, passed: budgetPassed,
    conditions: { iterations, rounds, warmupsPerModePerCase: 10, concurrency, workloads, readDelayMs, collectorDelayMs, collectorStatus, exportTimeoutMs, traceSampleRatio, processMetrics, p95BudgetMs: budget ?? null, compareUsage,
      engine: "synthetic-loopback", scope: "HTTP middleware + proxy + existing metrics; optional authenticated usage protection; optional process sampler; excludes Broker, real models, host/GPU sampler and production logging",
      caveat: "Mixed request samples are pooled. Read delay measures client delay; socket buffering can hide backpressure. Export counters accumulate across cases. All fixtures share one process." },
    exportedBatches, cases, readinessLatencyMs: await readinessComparison(),
  };
  const serialized = JSON.stringify(report, null, 2);
  if (process.env.LARM_OVERHEAD_OUTPUT) {
    const output = await prepareExternalOutput(absoluteOutput("LARM_OVERHEAD_OUTPUT", process.env.LARM_OVERHEAD_OUTPUT), resolve(import.meta.dir, "../../.."));
    await writeExclusive(output, serialized);
  }
  console.log(serialized);
  if (!budgetPassed) process.exitCode = 1;
} finally {
  for (const fixture of fixtures) { fixture.server.stop(true); await fixture.observation?.shutdown(); }
  upstream.stop(true); collector.stop(true);
}
