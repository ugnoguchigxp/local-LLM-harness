import { expect, test } from "bun:test";
import type { Registry, RuntimeDefinition, NodeTelemetry } from "@larm/core";
import type { RuntimeBackend, RuntimeHealth } from "@larm/backends";
import { ControlPlane, type ControlPlaneOptions } from "./controller";
import { Observer } from "./observer";

const gb = 1024 ** 3;
function runtime(id: string, memory: number): RuntimeDefinition {
  return {
    id, capability: [id], protocol: "openai.chat-completions.v1", backend: "systemd", node: "node",
    policy: { class: "preferred", warm: { minInstances: 0, idleTtlSeconds: 600 } },
    resources: { estimatedMemoryGB: memory, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
    deployment: { service: `${id}.service`, healthPort: 8080, endpoint: `http://${id}:8080` },
  };
}
async function fixture(options: { live?: number; stopFails?: boolean; freeAfterStop?: number; telemetryUnavailable?: boolean; control?: ControlPlaneOptions } = {}) {
  const registry: Registry = {
    nodes: [{ id: "node", endpoint: "http://localhost", resources: { memoryTotalGB: 64, reservedMemoryGB: 8 } }],
    runtimes: [runtime("target", 40), runtime("large", 36), runtime("small", 8)], profiles: [],
    routes: ["target", "large", "small"].map(id => ({ id, capabilities: [id], explicitOnly: false, candidates: [{ runtime: id, purpose: "primary" }] })),
  };
  const running = new Set(["large", "small"]);
  let free = options.live ?? 20;
  const calls: string[] = [];
  const health = (id: string): RuntimeHealth => ({ runtimeId: id, service: running.has(id) ? "Running" : "Stopped",
    listening: running.has(id), healthOk: running.has(id), busy: false });
  const backend: RuntimeBackend = {
    health: async id => health(id), list: async () => registry.runtimes.map(r => health(r.id)),
    ensure: async r => { calls.push(`start:${r.id}`); running.add(r.id); return health(r.id); },
    stop: async id => {
      calls.push(`stop:${id}`);
      if (options.stopFails) throw new Error("stop failed");
      running.delete(id);
      free = options.freeAfterStop ?? free + registry.runtimes.find(r => r.id === id)!.resources.estimatedMemoryGB;
    },
  };
  const observer = new Observer(registry, backend, { telemetry: { observe: async (): Promise<NodeTelemetry> => options.telemetryUnavailable
    ? { status: "unavailable", source: "test", observedAt: new Date().toISOString() }
    : { status: "available", source: "test", observedAt: new Date().toISOString(), systemMemoryTotalBytes: 64 * gb, systemMemoryAvailableBytes: free * gb } } });
  await observer.tick();
  const control = new ControlPlane(registry, backend, observer, {
    idleTtlMs: 600_000, pollIntervalMs: 5, requireFreshTelemetry: true, providerSwitchHoldMs: 0, ...options.control,
  });
  const allocate = (id = "target", priority = 3000) => control.allocate({ requirements: [{ capability: id, route: id }],
    ttlSeconds: 300, allowFallback: false, deploymentPolicy: "existing-only", capacityPolicy: "wait", priority });
  return { registry, running, calls, control, observer, backend, allocate };
}

test("a Profile allocation reclaims only enough idle memory before starting the resolved runtime", async () => {
  const f = await fixture();
  try {
    const result = await f.allocate();
    expect(result.status).toBe(202);
    await f.control.flush();
    expect(f.calls).toEqual(["stop:large", "start:target"]);
    expect(f.running.has("small")).toBe(true);
    expect(f.control.getAllocations().find(a => a.id === (result.body as { id: string }).id)?.status).toBe("ready");
  } finally { f.control.beginDrain(); }
});
test("memory recovery stops a managed instance immediately instead of waiting for its idle TTL", async () => {
  const f = await fixture({ live: 56 });
  try {
    f.running.delete("large"); await f.observer.tick();
    await f.allocate("large", 0); await f.control.flush();
    const large = f.control.getAllocations().find(a => a.bindings[0]?.runtime === "large")!;
    await f.control.releaseAllocation(large.id);
    expect(f.calls).toEqual(["start:large"]);
    await f.allocate(); await f.control.flush();
    expect(f.calls).toEqual(["start:large", "stop:large", "start:target"]);
  } finally { f.control.beginDrain(); }
});
test("higher-priority foreground memory pressure preempts an unrelated lower-priority allocation", async () => {
  const f = await fixture();
  try {
    await f.allocate("large", 1000);
    await f.allocate(); await f.control.flush();
    expect(f.control.getAllocations().find(a => a.bindings[0]?.runtime === "large")).toMatchObject({ status: "released", error: { code: "foreground_preempted" } });
    expect(f.calls).toEqual(["stop:small", "stop:large", "start:target"]);
  } finally { f.control.beginDrain(); }
});

test("memory retirement drains an in-flight request normally and blocks new requests before preemption", async () => {
  const f = await fixture({ control: { memoryDrainTimeoutMs: 1000 } });
  try {
    const lower = await f.allocate("large", 1000);
    const id = (lower.body as { id: string }).id;
    const instance = f.control.retainProviderRequest(id, "large", "in-flight");
    const signal = f.control.getAllocationSignal(id)!;
    const target = f.allocate();
    for (let i = 0; i < 100 && !f.control.isRuntimeTransitioning("large"); i++) await Bun.sleep(1);
    expect(f.control.isRuntimeTransitioning("large")).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(f.calls).toEqual(["stop:small"]);
    expect(() => f.control.retainProviderRequest(id, "large", "new-request")).toThrow("provider is draining");
    f.control.releaseProviderRequest(instance, "in-flight");
    expect((await target).status).toBe(202);
    await f.control.flush();
    expect(f.calls).toEqual(["stop:small", "stop:large", "start:target"]);
    expect(signal.aborted).toBe(true);
  } finally { f.control.beginDrain(); }
});

test("drain timeout preserves a running request and releases the drain reservation", async () => {
  const f = await fixture({ control: { memoryDrainTimeoutMs: 10 } });
  try {
    const lower = await f.allocate("large", 1000);
    const id = (lower.body as { id: string }).id;
    f.control.retainProviderRequest(id, "large", "long-request");
    const signal = f.control.getAllocationSignal(id)!;
    expect((await f.allocate()).status).toBe(409);
    expect(signal.aborted).toBe(false);
    expect(f.calls).toEqual(["stop:small"]);
    expect(f.control.isRuntimeTransitioning("large")).toBe(false);
    expect(() => f.control.retainProviderRequest(id, "large", "next-request")).not.toThrow();
    f.control.releaseProviderRequest(undefined, "long-request");
    f.control.releaseProviderRequest(undefined, "next-request");
  } finally { f.control.beginDrain(); }
});

test("swap-group priority preemption also preserves an active request after memory drain times out", async () => {
  const f = await fixture({ control: { memoryDrainTimeoutMs: 10 } });
  try {
    f.registry.runtimes[0]!.policy.swapGroup = "conversation";
    f.registry.runtimes[1]!.policy.swapGroup = "conversation";
    const lower = await f.allocate("large", 1000);
    const id = (lower.body as { id: string }).id;
    const instance = f.control.retainProviderRequest(id, "large", "finishing-request");
    const signal = f.control.getAllocationSignal(id)!;
    const waiting = await f.allocate();
    expect(waiting.body).toMatchObject({ status: "waiting" });
    expect(signal.aborted).toBe(false);
    expect(() => f.control.retainProviderRequest(id, "large", "next-request")).toThrow("provider is draining");
    f.control.releaseProviderRequest(instance, "finishing-request");
    await f.control.flush();
    expect(signal.aborted).toBe(true);
    expect(f.control.getAllocation((waiting.body as { id: string }).id)?.status).toBe("ready");
  } finally { f.control.beginDrain(); }
});
test("equal-priority allocations, warm floors and lifecycle mutations are not memory victims", async () => {
  const f = await fixture({ control: { isRuntimeMutating: id => id === "small" } });
  try {
    await f.allocate("large", 3000);
    expect((await f.allocate()).status).toBe(409);
    expect(f.calls).toEqual([]);
    for (const a of f.control.getAllocations()) await f.control.releaseAllocation(a.id);
    f.registry.runtimes.find(r => r.id === "large")!.policy.warm!.minInstances = 1;
    expect((await f.allocate()).status).toBe(409);
    expect(f.calls).toEqual([]);
  } finally { f.control.beginDrain(); }
});
test("stop failures or insufficient measured recovery never start the requested process", async () => {
  for (const options of [{ stopFails: true }, { freeAfterStop: 1 }]) {
    const f = await fixture(options);
    try {
      expect((await f.allocate()).status).toBe(409);
      await f.control.flush();
      expect(f.calls.some(c => c === "start:target")).toBe(false);
      expect(f.calls.filter(c => c === "stop:large")).toHaveLength(1);
    } finally { f.control.beginDrain(); }
  }
});
test("a pure live headroom shortage also triggers recovery; unrelated admission errors do not", async () => {
  const f = await fixture({ live: 1 });
  try {
    f.registry.nodes[0]!.resources.memoryTotalGB = 128;
    expect((await f.allocate()).status).toBe(202);
    await f.control.flush();
    expect(f.calls).toEqual(["stop:large", "stop:small", "start:target"]);
  } finally { f.control.beginDrain(); }
  const unavailable = await fixture({ telemetryUnavailable: true });
  try {
    unavailable.registry.nodes[0]!.resources.memoryTotalGB = 128;
    expect((await unavailable.allocate()).status).toBe(409);
    expect(unavailable.calls).toEqual([]);
  } finally { unavailable.control.beginDrain(); }
});
test("service memory admission uses the same recovery without an Agent Connection", async () => {
  const f = await fixture();
  try {
    await f.control.reclaimMemory({ evaluateAdmission: () => f.running.has("large")
      ? { ok: false, reason: "live_memory_exhausted", node: "node" } : { ok: true } });
    expect(f.calls).toEqual(["stop:large"]);
  } finally { f.control.beginDrain(); }
});

test("a cancelled queued recovery returns promptly and never stops another service", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const stop = f.backend.stop;
  f.backend.stop = async id => { entered.resolve(); await gate.promise; await stop(id); };
  const evaluateAdmission = () => f.running.has("large")
    ? { ok: false, reason: "live_memory_exhausted", node: "node" } : { ok: true };
  try {
    const first = f.control.reclaimMemory({ evaluateAdmission });
    await entered.promise;
    const abort = new AbortController();
    const second = f.control.reclaimMemory({ evaluateAdmission, signal: abort.signal });
    abort.abort(new Error("request cancelled"));
    await expect(second).rejects.toThrow("request cancelled");
    gate.resolve(); await first; await f.control.flush();
    expect(f.calls).toEqual(["stop:large"]);
  } finally { gate.resolve(); f.control.beginDrain(); }
});

test("a physically impossible request or unavailable telemetry never evicts useful work", async () => {
  const f = await fixture();
  try {
    f.registry.runtimes[0]!.resources.estimatedMemoryGB = 100;
    expect((await f.allocate()).status).toBe(409);
    expect(f.calls).toEqual([]);
  } finally { f.control.beginDrain(); }
  const unavailable = await fixture({ telemetryUnavailable: true });
  try {
    expect((await unavailable.allocate()).status).toBe(409);
    expect(unavailable.calls).toEqual([]);
  } finally { unavailable.control.beginDrain(); }
});

test("recovery observation failure returns a retryable response and leaves the queue usable", async () => {
  const f = await fixture();
  const list = f.backend.list;
  try {
    f.backend.list = async () => { throw new Error("probe failed"); };
    expect(await f.allocate()).toMatchObject({ status: 503, body: { error: { code: "memory_reclamation_failed" } } });
    expect(f.calls).toEqual([]);
    f.backend.list = list;
    expect((await f.allocate()).status).toBe(202);
    await f.control.flush();
  } finally { f.control.beginDrain(); }
});

test("an existing waiter reclaims idle memory when its execution slot becomes available", async () => {
  const f = await fixture();
  try {
    f.registry.runtimes[0]!.resources.maxConcurrentAllocations = 1;
    f.running.delete("large"); f.running.add("target"); await f.observer.refresh();
    const first = await f.allocate();
    const second = await f.allocate();
    expect(second.body).toMatchObject({ status: "waiting" });
    f.running.add("large"); await f.observer.refresh();
    await f.control.releaseAllocation((first.body as { id: string }).id);
    await f.control.flush();
    expect(f.control.getAllocation((second.body as { id: string }).id)?.status).toBe("ready");
    expect(f.calls).toEqual(["stop:large"]);
  } finally { f.control.beginDrain(); }
});

test("a full execution slot does not trigger unrelated memory eviction", async () => {
  const f = await fixture();
  try {
    f.registry.runtimes[0]!.resources.maxConcurrentAllocations = 1;
    f.running.delete("large"); f.running.add("target"); await f.observer.refresh();
    await f.allocate();
    f.running.add("large"); await f.observer.refresh();
    expect((await f.allocate()).body).toMatchObject({ status: "waiting" });
    expect(f.calls).toEqual([]);
  } finally { f.control.beginDrain(); }
});

test("cancelling a waiter during recovery observation prevents victim preemption and stop", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  try {
    f.registry.runtimes[0]!.resources.maxConcurrentAllocations = 1;
    f.running.delete("large"); f.running.add("target"); await f.observer.refresh();
    const first = await f.allocate();
    const waiter = await f.allocate();
    const waiterId = (waiter.body as { id: string }).id;
    f.running.add("large"); await f.observer.refresh();
    const list = f.backend.list;
    f.backend.list = async () => {
      if (f.control.isRuntimeTransitioning("large")) { entered.resolve(); await gate.promise; }
      return await list();
    };
    await f.control.releaseAllocation((first.body as { id: string }).id);
    await entered.promise;
    await f.control.releaseAllocation(waiterId);
    gate.resolve(); await f.control.flush();
    expect(f.calls).toEqual([]);
    expect(f.control.getAllocation(waiterId)?.status).toBe("released");
    expect(f.control.isRuntimeTransitioning("large")).toBe(false);
  } finally { gate.resolve(); f.control.beginDrain(); }
});

test("a concurrent admission cannot exceed the active allocation limit during memory recovery", async () => {
  const f = await fixture({ control: { maxActiveAllocations: 1 } });
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const stop = f.backend.stop;
  f.backend.stop = async id => { entered.resolve(); await gate.promise; await stop(id); };
  try {
    const pending = f.allocate();
    await entered.promise;
    expect((await f.allocate("small", 3000)).status).toBe(200);
    gate.resolve();
    expect((await pending).status).toBe(503);
    expect(f.control.getActiveAllocationCount()).toBe(1);
    expect(f.calls).toEqual(["stop:large"]);
  } finally { gate.resolve(); f.control.beginDrain(); }
});
