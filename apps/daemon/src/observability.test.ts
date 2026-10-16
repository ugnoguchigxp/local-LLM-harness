import { expect, test } from "bun:test";
import { Hono } from "hono";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type { RuntimeDefinition, RuntimeProtocol } from "@larm/core";
import { Observability, RequestObservation, currentObservation, observabilityFromEnvironment } from "./observability";
import { RequestTracker, MetricsRegistry } from "./metrics";
import { ExecutionGate } from "./execution-gate";
import { proxyGateway } from "./gateway";

const traceId = "1234567890abcdef1234567890abcdef";
const parentId = "abcdef1234567890";
const runtime = (protocol: RuntimeProtocol): RuntimeDefinition => ({
  id: protocol, capability: ["llm.general"], protocol, backend: "systemd", node: "test",
  policy: { class: "resident" },
  resources: { estimatedMemoryGB: 1, maxConcurrentRequests: 1, maxQueuedRequests: 3, queueTimeoutMs: 1000 },
  deployment: { endpoint: "http://127.0.0.1:8080", backendEndpoint: "http://127.0.0.1:8080", service: "test.service", healthPort: 8080 },
});

function fixture(protocol: RuntimeProtocol, upstream: (headers: Headers) => Promise<Response>, metrics = new MetricsRegistry(), ratio = 1, sse = false, callbacks: { onTerminal?: () => Promise<void>; onFinish?: () => Promise<void> } = {}) {
  const exporter = new InMemorySpanExporter();
  const observation = new Observability(metrics, { exporter, sampleRatio: ratio });
  const app = new Hono();
  app.use("*", observation.middleware());
  const gate = new ExecutionGate();
  const tracker = new RequestTracker();
  const selected = runtime(protocol);
  app.post("/v1/test", c => proxyGateway({
    request: c.req.raw, allocationId: "alloc_test", runtime: selected, protocol, upstreamPath: "/test",
    ...callbacks, requestTracker: tracker,
    responseFormat: sse ? "sse" : undefined,
    bodyMode: "buffered", maxBodyBytes: 1024, timeoutMs: 1000, bootEpoch: "boot", executionGate: gate,
    revalidate: () => ({ ok: true, binding: { endpoint: selected.deployment.endpoint, runtime: selected.id } }),
    fetchImpl: async (_url, init) => await upstream(new Headers(init?.headers)),
  }));
  return { app, observation, exporter, metrics, gate, selected, tracker };
}
const request = (headers: Record<string, string> = {}, signal?: AbortSignal) => new Request("http://larm/v1/test", { method: "POST", body: JSON.stringify({ model: "test", input: "secret-prompt", voice: "test", messages: [{ role: "user", content: "secret-prompt" }] }), headers: { "content-type": "application/json", ...headers }, signal });

test("versioned context APIs propagate the incoming trace and health remains untraced", async () => {
  const exporter = new InMemorySpanExporter();
  const observation = new Observability(undefined, { exporter, sampleRatio: 1 });
  const app = new Hono();
  app.use("*", observation.middleware());
  app.post("/v2/context-views", c => {
    const end = currentObservation()?.stage("context_preparation");
    end?.();
    return c.json({ accepted: true });
  });
  app.get("/health", c => c.json({ ready: true }));
  try {
    const response = await app.request("/v2/context-views", { method: "POST", headers: { traceparent: `00-${traceId}-${parentId}-01` } });
    expect(response.headers.get("x-larm-trace-id")).toBe(traceId);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("server-timing")).toContain("context_preparation");
    expect((await app.request("/health")).headers.get("x-larm-trace-id")).toBeNull();
    await observation.provider.forceFlush();
    const roots = exporter.getFinishedSpans().filter(span => span.name === "larm.request");
    expect(roots).toHaveLength(1);
    expect(roots[0]!.spanContext().traceId).toBe(traceId);
    expect(roots[0]!.parentSpanContext?.spanId).toBe(parentId);
  } finally { await observation.shutdown(); }
});

test("W3C parent, upstream child, request id and monotonic stages survive streamed response", async () => {
  let forwarded = "";
  const f = fixture("openai.chat-completions.v1", async headers => {
    forwarded = headers.get("traceparent")!;
    await Bun.sleep(5);
    return new Response("secret-recognition", { headers: { "content-type": "text/plain" } });
  });
  try {
    const response = await f.app.fetch(request({ traceparent: `00-${traceId}-${parentId}-01`, "x-request-id": "eumenes-turn-1" }));
    expect(await response.text()).toBe("secret-recognition");
    await f.observation.provider.forceFlush();
    const spans = f.exporter.getFinishedSpans();
    const root = spans.find(span => span.name === "larm.request")!;
    const upstream = spans.find(span => span.name === "larm.upstream")!;
    expect(root.spanContext().traceId).toBe(traceId);
    expect(root.parentSpanContext?.spanId).toBe(parentId);
    expect(upstream.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(forwarded).toBe(`00-${traceId}-${upstream.spanContext().spanId}-01`);
    expect(response.headers.get("x-larm-trace-id")).toBe(traceId);
    expect(root.attributes["larm.caller_request_id"]).toBe("eumenes-turn-1");
    expect(root.attributes["larm.request_id"]).toBe(response.headers.get("x-request-id")!);
    expect(Number(root.attributes["larm.duration_ms.upstream_headers"])).toBeGreaterThan(3);
    expect(Number(root.attributes["larm.duration_ms.total"])).toBeGreaterThanOrEqual(Number(root.attributes["larm.duration_ms.upstream_headers"]));
    expect(response.headers.get("server-timing")).toContain("execution_wait;dur=");
    expect(f.metrics.render()).toContain('stage="first_body"');
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain("secret-");
    expect(f.metrics.render()).not.toContain(traceId);
  } finally { await f.observation.shutdown(); }
});

for (const protocol of ["openai.chat-completions.v1", "openai.audio-transcriptions.v1", "openai.audio-speech.v1"] as const) {
  test(`${protocol}: execution queue and cancellation preserve slot order`, async () => {
    let finishFirst!: () => void;
    const blocked = new Promise<void>(resolve => { finishFirst = resolve; });
    let calls = 0;
    const f = fixture(protocol, async () => {
      calls++;
      if (calls === 1) await blocked;
      return new Response("audio-or-result");
    });
    try {
      const first = f.app.fetch(request());
      await Bun.sleep(1);
      const cancelled = new AbortController();
      const second = f.app.fetch(request({}, cancelled.signal));
      const third = f.app.fetch(request());
      await Bun.sleep(5);
      expect(f.gate.snapshot(f.selected.id)).toEqual({ active: 1, queued: 2 });
      cancelled.abort();
      expect((await second).status).toBe(400);
      finishFirst();
      expect(await (await first).text()).toBe("audio-or-result");
      expect(await (await third).text()).toBe("audio-or-result");
      expect(calls).toBe(2);
      expect(f.gate.snapshot(f.selected.id)).toEqual({ active: 0, queued: 0 });
      await f.observation.provider.forceFlush();
      const roots = f.exporter.getFinishedSpans().filter(span => span.name === "larm.request");
      expect(roots).toHaveLength(3);
      expect(roots.some(span => Number(span.attributes["larm.duration_ms.execution_wait"]) >= 4)).toBe(true);
      expect(roots.some(span => span.attributes["larm.outcome"] === "client_cancelled")).toBe(true);
    } finally { finishFirst(); await f.observation.shutdown(); }
  });
}

test("disabled, unsampled, invalid parent and failing metric sink do not affect response", async () => {
  expect(observabilityFromEnvironment(new MetricsRegistry(), {})).toBeUndefined();
  expect(() => observabilityFromEnvironment(new MetricsRegistry(), { LARM_OBSERVABILITY_ENABLED: "true", LARM_TRACE_SAMPLE_RATIO: "2" })).toThrow();
  const metrics = new MetricsRegistry();
  metrics.record = () => { throw new Error("sink unavailable"); };
  metrics.setGauge = () => { throw new Error("sink unavailable"); };
  const f = fixture("openai.audio-speech.v1", async () => new Response("ok"), metrics, 0);
  try {
    const response = await f.app.fetch(request({ traceparent: `00-${"0".repeat(32)}-${parentId}-01` }));
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("x-larm-trace-id")).not.toBe("0".repeat(32));
    await f.observation.provider.forceFlush();
    expect(f.exporter.getFinishedSpans()).toHaveLength(0);
  } finally { await f.observation.shutdown(); }
});

test("stream cancellation finishes one trace and releases TTS slot", async () => {
  const f = fixture("openai.audio-speech.v1", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
  })));
  try {
    const response = await f.app.fetch(request());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await f.observation.provider.forceFlush();
    expect(f.gate.snapshot(f.selected.id).active).toBe(0);
    expect(f.exporter.getFinishedSpans().filter(span => span.name === "larm.request")).toHaveLength(1);
  } finally { await f.observation.shutdown(); }
});

test("export failure is independent of inference response completion", async () => {
  let exports = 0;
  const observability = new Observability(new MetricsRegistry(), { sampleRatio: 1, exporter: {
    export(_spans, callback) { exports++; callback({ code: 1, error: new Error("collector unavailable") }); },
    async shutdown() {},
  } });
  const app = new Hono(); app.use("*", observability.middleware()); app.post("/v1/test", c => c.text("ok"));
  try {
    const response = await app.fetch(request());
    expect(await response.text()).toBe("ok");
    await observability.provider.forceFlush().catch(() => undefined);
    expect(exports).toBe(1);
  } finally { await observability.shutdown(); }
});


test("wall clock regression cannot produce negative request durations", async () => {
  const exporter = new InMemorySpanExporter();
  const observation = new Observability(undefined, { exporter, sampleRatio: 1 });
  const active = new RequestObservation(observation, request());
  const end = active.stage("test_work");
  const original = Date.now;
  try {
    Date.now = () => original() - 100000;
    await Bun.sleep(2); end(); active.finish("complete");
  } finally { Date.now = original; }
  try {
    await observation.provider.forceFlush();
    const root = exporter.getFinishedSpans().find(span => span.name === "larm.request")!;
    expect(Number(root.attributes["larm.duration_ms.test_work"])).toBeGreaterThanOrEqual(1);
    expect(Number(root.attributes["larm.duration_ms.total"])).toBeGreaterThanOrEqual(1);
  } finally { await observation.shutdown(); }
});

test("legacy JSON statistics observation remains bounded and preserves response bytes", async () => {
  for (const oversized of [false, true]) {
    const payload = { choices: [{ message: { content: "a".repeat(oversized ? 70000 : 10) } }], usage: { prompt_tokens: 10, completion_tokens: 2 }, timings: { prompt_ms: 4, predicted_ms: 5 } };
    const text = JSON.stringify(payload);
    const f = fixture("openai.chat-completions.v1", async () => new Response(text, { headers: { "content-type": "application/json" } }));
    try {
      const response = await f.app.fetch(request());
      expect(await response.text()).toBe(text);
      await f.observation.provider.forceFlush();
      const root = f.exporter.getFinishedSpans().find(span => span.name === "larm.request")!;
      expect(root.attributes["larm.engine.prefill_ms"]).toBe(oversized ? undefined : 4);
    } finally { await f.observation.shutdown(); }
  }
});


test("SSE separates first body, first meaningful token and explicit engine statistics", async () => {
  const metadata = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "test" };
  const events = [
    { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "secret-answer" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, timings: { predicted_ms: 9, prompt_ms: 3, cache_n: 8 } },
  ];
  let index = 0;
  const f = fixture("openai.chat-completions.v1", async () => new Response(new ReadableStream({
    async pull(controller) {
      if (index === 1) await Bun.sleep(5);
      if (index < events.length) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...metadata, ...events[index++] })}\n\n`));
      else { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); }
    },
  }), { headers: { "content-type": "text/event-stream" } }), new MetricsRegistry(), 1, true);
  try {
    const response = await f.app.fetch(request()); await response.text();
    await f.observation.provider.forceFlush();
    const root = f.exporter.getFinishedSpans().find(span => span.name === "larm.request")!;
    expect(Number(root.attributes["larm.duration_ms.first_token"])).toBeGreaterThan(Number(root.attributes["larm.duration_ms.first_body"]));
    expect(root.attributes["larm.engine.output_tokens"]).toBe(2);
    expect(root.attributes["larm.engine.cached_tokens"]).toBe(8);
    expect(root.attributes["larm.engine.decode_ms"]).toBe(9);
    expect(root.attributes["larm.relay_chunks"]).toBe(5);
    expect(JSON.stringify(root.attributes)).not.toContain("secret-answer");
  } finally { await f.observation.shutdown(); }
});


test("slow terminal and lease cleanup are visible without postponing response completion", async () => {
  let releaseTerminal!: () => void; const terminal = new Promise<void>(resolve => { releaseTerminal = resolve; });
  let releaseLease!: () => void; const lease = new Promise<void>(resolve => { releaseLease = resolve; });
  const f = fixture("openai.chat-completions.v1", async () => new Response("ok"), new MetricsRegistry(), 1, false, { onTerminal: () => terminal, onFinish: () => { const child = currentObservation()?.operation("runtime_mutation"); child?.finish(); return lease; } });
  try {
    const response = await f.app.fetch(request()); expect(await response.text()).toBe("ok");
    expect(f.gate.snapshot(f.selected.id).active).toBe(1);
    expect(f.tracker.count()).toBe(1);
    await f.observation.provider.forceFlush();
    expect(f.exporter.getFinishedSpans().some(span => span.name === "larm.request")).toBe(true);
    expect(f.exporter.getFinishedSpans().some(span => span.name === "larm.request_cleanup")).toBe(false);
    await Bun.sleep(4); releaseTerminal(); await Bun.sleep(0);
    expect(f.gate.snapshot(f.selected.id).active).toBe(0);
    expect(f.tracker.count()).toBe(1);
    releaseLease(); await Bun.sleep(0); await f.observation.provider.forceFlush();
    expect(f.tracker.count()).toBe(0);
    const cleanup = f.exporter.getFinishedSpans().find(span => span.name === "larm.request_cleanup")!;
    expect(Number(cleanup.attributes["larm.duration_ms.post_response_slot_hold"])).toBeGreaterThanOrEqual(3);
    expect(Number(cleanup.attributes["larm.duration_ms.terminal_callback"])).toBeGreaterThanOrEqual(3);
    expect(cleanup.attributes["larm.duration_ms.finish_callback"]).toBeDefined();
    const nested = f.exporter.getFinishedSpans().find(span => span.name === "larm.runtime_mutation")!;
    expect(nested.parentSpanContext?.spanId).toBe(cleanup.spanContext().spanId);
  } finally { releaseTerminal(); releaseLease(); await f.observation.shutdown(); }
});


test("terminal callback failure remains separate from inference outcome and releases slot", async () => {
  const f = fixture("openai.chat-completions.v1", async () => new Response("ok"), new MetricsRegistry(), 1, false, { onTerminal: async () => { throw new Error("secret callback message"); } });
  try {
    const response = await f.app.fetch(request()); expect(await response.text()).toBe("ok");
    await Bun.sleep(0); await f.observation.provider.forceFlush();
    const spans = f.exporter.getFinishedSpans();
    expect(spans.find(span => span.name === "larm.request")!.attributes["larm.outcome"]).toBe("http_200");
    expect(spans.find(span => span.name === "larm.request_cleanup")!.attributes["larm.outcome"]).toBe("terminal_error");
    expect(f.gate.snapshot(f.selected.id).active).toBe(0);
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain("secret callback");
  } finally { await f.observation.shutdown(); }
});
