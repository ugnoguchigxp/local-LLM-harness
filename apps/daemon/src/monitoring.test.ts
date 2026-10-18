import { expect, test } from "bun:test";
import { monitoringSnapshotSchema, monitoringEventsSchema, type Registry, type MonitoringRuntime } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { createApp } from "./app";
import { ControlPlane } from "./controller";
import { Observer } from "./observer";
import { ExecutionGate } from "./execution-gate";
import { RequestTracker } from "./metrics";
import { MonitoringService } from "./monitoring";
import { proxyGateway } from "./gateway";

const registry: Registry = {
  nodes: [{ id: "node", endpoint: "http://secret-node.invalid", resources: { memoryTotalGB: 128, reservedMemoryGB: 16 } }], profiles: [],
  runtimes: [{ id: "runtime", capability: ["llm.general"], protocol: "openai.chat-completions.v1", backend: "systemd", node: "node", policy: { class: "preferred" }, resources: { estimatedMemoryGB: 1, maxConcurrentRequests: 1, maxQueuedRequests: 1, queueTimeoutMs: 1000 }, deployment: { service: "fixture.service", endpoint: "http://SECRET-endpoint", backendEndpoint: "http://SECRET-upstream", healthPort: 8080 } }],
  routes: [{ id: "route", capabilities: ["llm.general"], explicitOnly: true, candidates: [{ runtime: "runtime", purpose: "primary" }] }],
};
async function fixture() {
  let clock = Date.parse("2026-10-18T08:30:00.000Z"), mono = 0, running = true, busy = false, healthy = true;
  let ensures = 0, stops = 0, probes = 0;
  const backend: RuntimeBackend = {
    list: async () => { probes++; return [{ runtimeId: "runtime", service: running ? "Running" : "Stopped", healthOk: healthy && running, listening: running, busy, detail: "SECRET-health-body" }]; },
    health: async () => { throw new Error("monitor must not probe"); }, ensure: async () => { ensures++; throw new Error("monitor must not start"); }, stop: async () => { stops++; },
  };
  const observer = new Observer(registry, backend, { now: () => clock }); await observer.tick();
  const tracker = new RequestTracker();
  const monitor = new MonitoringService(registry, "epoch-test", { now: () => clock, monotonic: () => mono });
  const control = new ControlPlane(registry, backend, observer, { now: () => clock, bootEpoch: "epoch-test", idleTtlMs: 0, onEvent: monitor.capture });
  const gate = new ExecutionGate({ now: () => mono, onEvent: monitor.capture });
  const app = createApp({ registry, control, getState: () => observer.getState(), now: () => clock,
    apiToken: "standard-secret", managementToken: "management-secret", protectedConsumerToken: "protected-secret",
    requestTracker: tracker, executionGate: gate, monitoring: monitor, onEvent: monitor.capture, usageMonotonicNow: () => mono });
  const read = (path: string, token = "standard-secret", method = "GET") => app.request(path, { method, headers: { authorization: `Bearer ${token}` } });
  return { app, monitor, control, observer, gate, tracker, read,
    advance: (ms: number) => { clock += ms; mono += ms; }, state: (s: { running?: boolean; busy?: boolean; healthy?: boolean }) => { running = s.running ?? running; busy = s.busy ?? busy; healthy = s.healthy ?? healthy; },
    counters: () => ({ ensures, stops, probes }) };
}
test("monitoring routes reuse Control bearer auth, validate versions and queries, expose missing sensors and survive drain", async () => {
  const f = await fixture();
  try {
    const first = await f.read("/v1/monitoring/snapshot"); expect(first.status).toBe(200); expect(first.headers.get("cache-control")).toBe("no-store");
    const data = monitoringSnapshotSchema.parse(await first.json()); expect(data.core.runtimes[0]!.status.value).toBe("HOT");
    expect(data.nodes[0]!.cpu.utilization.status).toBe("unavailable"); expect(data.nodes[0]!.cpu.utilization.value).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain("SECRET"); expect(JSON.stringify(data)).not.toContain("secret-node");
    for (const path of ["/v1/monitoring/snapshot", "/v1/monitoring/events"]) {
      for (const token of ["standard-secret", "protected-secret"]) expect((await f.read(path, token)).status).toBe(200);
      for (const token of ["bad", "larm_conn_v1.fake", "management-secret"]) expect((await f.read(path, token)).status).toBe(401);
      expect((await f.app.request(path)).status).toBe(401);
      expect((await f.app.request(path, { headers: { "x-larm-management-token": "management-secret" } })).status).toBe(401);
      expect((await f.read(path, "standard-secret", "POST")).status).toBe(405);
      expect((await f.read(path, "standard-secret", "HEAD")).status).toBe(405);
    }
    for (const query of ["?x=1", "?contractVersion=a&contractVersion=b"]) expect((await f.read(`/v1/monitoring/snapshot${query}`)).status).toBe(400);
    expect((await f.read("/v1/monitoring/snapshot?contractVersion=larm-monitoring.v2")).status).toBe(406);
    expect((await f.read("/v1/monitoring/events?limit=1001")).status).toBe(400);
    f.control.beginDrain(); f.monitor.publish(); expect((await f.read("/v1/monitoring/snapshot")).status).toBe(200);
    expect(f.monitor.snapshot()?.core.draining.value).toBe(true);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});
test("repeated parallel observations never create, resolve, expire, renew or probe anything", async () => {
  const f = await fixture();
  try {
    const allocation = await f.control.allocate({ requirements: [{ capability: "llm.general", route: "route" }], allowFallback: false, deploymentPolicy: "existing-only", ttlSeconds: 30, priority: 0, capacityPolicy: "reject" });
    expect(allocation.status).toBe(200);
    const id = (allocation.body as { id: string }).id;
    const live = f.control.getAllocation(id), before = structuredClone(live), instances = f.control.getProviderInstances(), counters = f.counters();
    f.control.usage!.run(f.control.usage!.protectedOwner, () => f.control.usage!.prepare(600_000)(true));
    // These getters mutate expiry and must never be used by monitoring.
    const getAllocations = f.control.getAllocations; f.control.getAllocations = () => { throw new Error("mutating allocation getter used"); };
    const getAllocation = f.control.getAllocation; f.control.getAllocation = () => { throw new Error("mutating allocation getter used"); };
    f.advance(31_000); // Expiry is due; monitoring still must not trigger it.
    const protection = f.control.usage!.protection.snapshot();
    f.monitor.publish(); const snapshot = f.monitor.snapshot()!;
    const replies = await Promise.all(Array.from({ length: 8 }, () => f.read("/v1/monitoring/snapshot")));
    expect(replies.every(r => r.status === 200)).toBe(true);
    for (const reply of replies) { const data = await reply.json() as typeof snapshot; expect(data.snapshotId).toBe(snapshot.snapshotId); expect(data.core.runtimes[0]!.status.status).toBe("stale"); }
    expect(f.counters()).toEqual(counters); expect(f.control.getProviderInstances()).toEqual(instances);
    expect(live).toEqual(before);
    expect(f.control.usage!.protection.snapshot()).toEqual(protection);
    f.control.getAllocations = getAllocations; f.control.getAllocation = getAllocation;
    // Inspect the already-stored object rather than causing expiry through an ordinary public lookup.
    expect(before?.expiresAt).toBe(new Date(Date.parse(before!.createdAt) + 30_000).toISOString());
  } finally { f.control.beginDrain(); await f.control.flush(); }
});
test("runtime states and request queue are distinct; cancellation and late events never become success or speed samples", async () => {
  const f = await fixture();
  try {
    f.state({ running: false }); await f.observer.tick(); f.monitor.publish(); expect(f.monitor.snapshot()!.core.runtimes[0]!.status.value).toBe("COLD");
    f.state({ running: true, healthy: false }); await f.observer.tick(); f.monitor.publish(); expect(f.monitor.snapshot()!.core.runtimes[0]!.status.value).toBe("STARTING");
    f.advance(300_001); await f.observer.tick(); f.monitor.publish(); expect(f.monitor.snapshot()!.core.runtimes[0]!.status.value).toBe("FAILED");
    f.state({ healthy: true, busy: true }); await f.observer.tick(); f.monitor.publish(); expect(f.monitor.snapshot()!.core.runtimes[0]!.status.value).toBe("BUSY");
    const labels = { runtime: "runtime", request: "PRIVATE-correlation" };
    f.monitor.capture({ name: "gateway_request_started", labels });
    f.monitor.capture({ name: "gateway_request_queued", labels });
    const release = await f.gate.acquire("runtime", registry.runtimes[0]!.resources, new AbortController().signal);
    const abort = new AbortController(); const queued = f.gate.acquire("runtime", registry.runtimes[0]!.resources, abort.signal);
    f.advance(100); f.monitor.publish(); const active = f.monitor.snapshot()!.core.runtimes[0]!;
    expect(active.gateOccupiedSlots.value).toBe(1); expect(active.queuedRequests.value).toBe(1); expect(active.oldestQueueWaitMs.value).toBe(100);
    abort.abort(); await queued.catch(() => undefined); release();
    f.monitor.capture({ name: "gateway_decode_rate", labels, value: 999 });
    f.monitor.capture({ name: "gateway_request_completed", labels: { ...labels, outcome: "attempt_cancelled" } });
    f.monitor.capture({ name: "gateway_request_completed", labels: { ...labels, outcome: "http_200" } });
    f.monitor.publish(); expect(f.monitor.snapshot()!.core.runtimes[0]!.lastDecodeTokensPerSecond.value).toBeUndefined();
    const events = f.monitor.eventPage(); expect(events.events.filter(e => e.kind === "request.terminal").map(e => e.outcome)).toEqual(["cancelled"]);
    expect(events.events.find(e => e.kind === "request.queued")!.workId).toBe(events.events.find(e => e.kind === "request.started")!.workId);
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
  } finally { f.control.beginDrain(); await f.control.flush(); }
});
test("real gateway instrumentation supplies first body and engine rates with tracing disabled, and fast terminal history", async () => {
  const f = await fixture();
  try {
    const response = await proxyGateway({ request: new Request("http://fixture/v1/chat/completions", { method: "POST", body: "{}" }), allocationId: "alloc_fixture", runtime: registry.runtimes[0]!, protocol: "openai.chat-completions.v1", upstreamPath: "/v1/chat/completions", bodyMode: "buffered", maxBodyBytes: 1024, timeoutMs: 1000, bootEpoch: "epoch-test", executionGate: f.gate, requestTracker: f.tracker,
      revalidate: () => ({ ok: true, binding: { runtime: "runtime", endpoint: "http://fixture" } }),
      onEvent: f.monitor.capture, fetchImpl: async () => Response.json({ choices: [{ message: { role: "assistant", content: "PRIVATE OUTPUT" }, finish_reason: "stop" }], timings: { predicted_per_second: 42 } }) });
    expect(response.status).toBe(200); await response.text(); f.monitor.publish();
    const rt: MonitoringRuntime = f.monitor.snapshot()!.core.runtimes[0]!;
    expect(rt.lastDecodeTokensPerSecond.value).toBe(42); expect(rt.lastFirstResponseMs.value).toBeGreaterThanOrEqual(0);
    expect(rt.inFlightRequests.value).toBe(0); expect(f.monitor.eventPage().events.filter(e => e.kind === "request.terminal").map(e => e.outcome)).toEqual(["succeeded"]);
    expect(JSON.stringify(f.monitor.snapshot())).not.toContain("PRIVATE OUTPUT");
  } finally { f.control.beginDrain(); await f.control.flush(); }
});
test("monitoring media terminal is idempotent and secrets cannot become reasons; auth fails closed without Control credentials", async () => {
  const f = await fixture();
  try {
    f.monitor.media("music", "PRIVATE-JOB", "queued"); f.monitor.media("music", "PRIVATE-JOB", "cancelled"); f.monitor.media("music", "PRIVATE-JOB", "completed");
    expect(f.monitor.eventPage().events.filter(e => e.kind === "request.terminal").map(e => e.outcome)).toEqual(["cancelled"]);
    f.monitor.capture({ name: "allocation_rejected", labels: { reason: "PRIVATE-ERROR", endpoint: "PRIVATE-URL" } });
    expect(JSON.stringify(f.monitor.eventPage())).not.toContain("PRIVATE");
    const anonymous = createApp({ registry, control: f.control, getState: () => f.observer.getState(), monitoring: f.monitor });
    for (const path of ["/v1/monitoring/snapshot", "/v1/monitoring/events"]) {
      const reply = await anonymous.request(path);
      expect(reply.status).toBe(503);
      expect(await reply.json()).toMatchObject({ error: { code: "monitoring_auth_not_configured" } });
    }
    monitoringEventsSchema.parse(f.monitor.eventPage());
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("late successful upstream after cancellation remains one cancelled terminal and no successful speed sample", async () => {
  const f = await fixture(), abort = new AbortController();
  let respond!: () => void; const blocked = new Promise<void>(resolve => { respond = resolve; });
  let enter!: () => void; const started = new Promise<void>(resolve => { enter = resolve; });
  try {
    const pending = proxyGateway({ request: new Request("http://fixture/v1/chat/completions", { method: "POST", body: "{}", signal: abort.signal }), allocationId: "alloc_fixture", runtime: registry.runtimes[0]!, protocol: "openai.chat-completions.v1", upstreamPath: "/v1/chat/completions", bodyMode: "buffered", maxBodyBytes: 1024, timeoutMs: 1000, bootEpoch: "epoch-test", executionGate: f.gate,
      revalidate: () => ({ ok: true, binding: { runtime: "runtime", endpoint: "http://fixture" } }), onEvent: f.monitor.capture,
      fetchImpl: async () => { enter(); await blocked; return Response.json({ choices: [], timings: { predicted_per_second: 999 } }); } });
    await started; abort.abort(); respond(); const reply = await pending; await reply.text(); f.monitor.publish();
    expect(f.monitor.eventPage().events.filter(e => e.kind === "request.terminal").map(e => e.outcome)).toEqual(["cancelled"]);
    expect(f.monitor.snapshot()!.core.runtimes[0]!.lastDecodeTokensPerSecond.value).toBeUndefined();
  } finally { respond?.(); f.control.beginDrain(); await f.control.flush(); }
});

test("API keeps partial GPU failure and an OOM delta interval without inventing initial OOM events", async () => {
  const f = await fixture();
  const data = monitoringSnapshotSchema.parse(await Bun.file(new URL("../../../specs/assets/spatial-monitoring-v1/snapshot-partial.json", import.meta.url)).json());
  let ms = Date.parse("2026-10-18T08:30:00.000Z"), mono = 0, count = "3";
  const monitoring = new MonitoringService(registry, "epoch-partial", { now: () => ms, monotonic: () => mono, sampler: { observe: async () => {
    const node = structuredClone(data.nodes[0]!); node.nodeId = "node";
    node.memory.oomKills.value = count; node.memory.oomKills.observedAt = new Date(ms).toISOString(); node.memory.oomKills.lastAttempt.at = new Date(ms).toISOString();
    return { node, modelStorage: data.modelStorage };
  } } });
  try {
    const app = createApp({ registry, control: f.control, getState: () => f.observer.getState(), executionGate: f.gate, monitoring, apiToken: "standard-secret" });
    await monitoring.collect(); expect(monitoring.eventPage().events.filter(e => e.kind === "host.oom_counter_changed")).toHaveLength(0);
    ms += 2000; mono += 2000; count = "5"; await monitoring.collect();
    const reply = await app.request("/v1/monitoring/snapshot", { headers: { authorization: "Bearer standard-secret" } }); expect(reply.status).toBe(200);
    const snapshot = monitoringSnapshotSchema.parse(await reply.json());
    expect(snapshot.nodes[0]!.gpus.value![0]!.utilization.status).toBe("permission_denied"); expect(snapshot.nodes[0]!.memory.memTotal.value).toBeGreaterThan(0);
    const oom = monitoring.eventPage().events.filter(e => e.kind === "host.oom_counter_changed"); expect(oom).toHaveLength(1); expect(oom[0]!.countDelta).toBe("2"); expect(oom[0]!.observationInterval?.durationMs).toBe(2000);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("an already loaded model at first observation is not a new load completion", async () => {
  const f = await fixture(); let load: "loaded" | "loading" = "loaded";
  const monitor = new MonitoringService(registry, "epoch-bootstrap");
  try {
    monitor.bind({ observer: { getState: () => f.observer.getState(), monitoringSnapshot: () => new Map([["runtime", { observedAt: new Date().toISOString(), failed: false, modelLoadState: load }]]) }, control: f.control, gate: f.gate });
    expect(monitor.eventPage().events.filter(e => e.kind.startsWith("model.load"))).toHaveLength(0);
    load = "loading"; monitor.publish(); load = "loaded"; monitor.publish();
    expect(monitor.eventPage().events.filter(e => e.kind.startsWith("model.load")).map(e => e.kind)).toEqual(["model.load_started", "model.load_completed"]);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});
