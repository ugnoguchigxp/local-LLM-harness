import { ServiceResourceLedger } from "@larm/core";
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
    nodes: [{ id: "node", endpoint: "http://localhost", resources: { memoryTotalGB: 64, reservedMemoryGB: 40 } }],
    runtimes: [runtime("target", 40), runtime("large", 36), runtime("small", 8)], profiles: [],
    routes: ["target", "large", "small"].map(id => ({ id, capabilities: [id], explicitOnly: false, candidates: [{ runtime: id, purpose: "primary" }] })),
  };
  const running = new Set(["large", "small"]);
  const busy = new Set<string>();
  let free = options.live ?? 20;
  const calls: string[] = [];
  const health = (id: string): RuntimeHealth => ({ runtimeId: id, service: running.has(id) ? "Running" : "Stopped",
    listening: running.has(id), healthOk: running.has(id), busy: busy.has(id) });
  const backend: RuntimeBackend = {
    health: async id => health(id), list: async () => registry.runtimes.map(r => health(r.id)),
    ensure: async r => { calls.push(`start:${r.id}`); if (!running.has(r.id)) free -= r.resources.estimatedMemoryGB; running.add(r.id); return health(r.id); },
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
  return { registry, running, busy, calls, control, observer, backend, allocate, setFree: (value: number) => { free = value; } };
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

test("a promoted waiter waits for an in-progress idle stop and retains the replacement instance", async () => {
  const f = await fixture({ live: 56 });
  const stopping = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
  const stop = f.backend.stop;
  f.backend.stop = async id => {
    if (id === "large") { stopping.resolve(); await stopped.promise; }
    await stop(id);
  };
  try {
    const runtime = f.registry.runtimes.find(r => r.id === "large")!;
    runtime.policy.class = "elastic";
    runtime.policy.warm!.idleTtlSeconds = 0;
    runtime.resources.maxConcurrentAllocations = 1;
    f.running.delete("large"); await f.observer.refresh();
    const first = await f.allocate("large", 1000); await f.control.flush();
    const waiter = await f.allocate("large", 1000);
    const waiterId = (waiter.body as { id: string }).id;
    expect(waiter.body).toMatchObject({ status: "waiting" });
    await f.control.releaseAllocation((first.body as { id: string }).id);
    await stopping.promise;
    expect(f.control.getAllocation(waiterId)?.status).not.toBe("ready");
    stopped.resolve(); await f.control.flush();
    expect(f.control.getAllocation(waiterId)?.status).toBe("ready");
    expect(typeof f.control.getAllocation(waiterId)?.bindings[0]?.instanceId).toBe("string");
    expect(f.control.getProviderInstances()).toMatchObject([{ refs: { allocation: 1 } }]);
    expect(f.running.has("large")).toBe(true);
    const instance = f.control.retainProviderRequest(waiterId, "large", "next");
    f.control.releaseProviderRequest(instance, "next");
  } finally { stopped.resolve(); f.control.beginDrain(); }
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

test("a rejected memory request keeps its victim draining and stops it as soon as inference finishes", async () => {
  const f = await fixture({ control: { memoryDrainTimeoutMs: 10 } });
  try {
    const lower = await f.allocate("large", 1000);
    const id = (lower.body as { id: string }).id;
    f.control.retainProviderRequest(id, "large", "long-request");
    const signal = f.control.getAllocationSignal(id)!;
    expect((await f.allocate()).status).toBe(503);
    expect(signal.aborted).toBe(false);
    expect(f.calls).toEqual(["stop:small"]);
    expect(f.control.isRuntimeTransitioning("large")).toBe(true);
    expect(() => f.control.retainProviderRequest(id, "large", "next-request")).toThrow("provider is draining");
    await f.control.flush(); // Does not wait for the still-running inference.
    expect(signal.aborted).toBe(false);
    f.control.releaseProviderRequest(undefined, "long-request");
    await f.control.flush();
    expect(f.calls).toEqual(["stop:small", "stop:large"]);
    expect(signal.aborted).toBe(true);
    expect(f.control.isRuntimeTransitioning("large")).toBe(false);
    // Eumenes can poll again; the failed request did not start the target itself.
    expect((await f.allocate()).status).toBe(202);
    await f.control.flush();
    expect(f.calls).toEqual(["stop:small", "stop:large", "start:target"]);
  } finally { f.control.beginDrain(); }
});

test("repeated polls cannot reuse a draining managed instance and retirement waits for every request", async () => {
  const f = await fixture({ live: 56, control: { memoryDrainTimeoutMs: 5 } });
  const stopping = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
  const stop = f.backend.stop;
  f.backend.stop = async id => {
    if (id === "large") { stopping.resolve(); await stopped.promise; }
    await stop(id);
  };
  try {
    f.running.delete("large"); await f.observer.refresh();
    const lower = await f.allocate("large", 1000); await f.control.flush();
    const id = (lower.body as { id: string }).id;
    const instance = f.control.retainProviderRequest(id, "large", "first");
    expect(instance).toBeDefined();
    f.control.retainProviderRequest(id, "large", "second");
    expect((await f.allocate()).status).toBe(503);
    expect((await f.allocate()).status).toBe(503);
    const sameRuntime = await f.allocate("large", 1000);
    expect(sameRuntime.body).toMatchObject({ status: "waiting" });
    f.control.releaseProviderRequest(instance, "first"); await f.control.flush();
    expect(f.calls).toEqual(["start:large", "stop:small"]);
    f.control.releaseProviderRequest(instance, "second");
    await stopping.promise;
    await f.control.releaseAllocation((sameRuntime.body as { id: string }).id);
    stopped.resolve(); await f.control.flush();
    expect(f.calls).toEqual(["start:large", "stop:small", "stop:large"]);
    expect(f.control.getProviderInstances()).toEqual([]);
    expect(f.observer.getState().runtimes.find(r => r.id === "large")?.status).toBe("COLD");
    expect((await f.allocate()).status).toBe(202); await f.control.flush();
    expect(f.calls.at(-1)).toBe("start:target");
  } finally { stopped.resolve(); f.control.beginDrain(); }
});

test("deferred retirement stops waiting when cancelled or the daemon shuts down", async () => {
  for (const shutdown of [false, true]) {
    const f = await fixture({ control: { memoryDrainTimeoutMs: 5 } });
    try {
      const lower = await f.allocate("large", 1000);
      const id = (lower.body as { id: string }).id;
      const instance = f.control.retainProviderRequest(id, "large", "running");
      const abort = new AbortController();
      await f.control.reclaimMemory({ priority: 3000, requestedRuntimeIds: ["target"], signal: abort.signal,
        evaluateAdmission: () => ({ ok: false, reason: "live_memory_exhausted", node: "node" }) });
      expect(f.control.isRuntimeTransitioning("large")).toBe(true);
      if (shutdown) f.control.beginDrain();
      else abort.abort(new Error("request cancelled"));
      await f.control.flush();
      expect(f.control.isRuntimeTransitioning("large")).toBe(false);
      f.control.releaseProviderRequest(instance, "running"); await f.control.flush();
      expect(f.calls).toEqual(["stop:small"]);
      expect(f.control.getAllocation(id)?.status).toBe("ready");
    } finally { f.control.beginDrain(); }
  }
});

test("deferred retirement rechecks memory need and protection before stopping", async () => {
  for (const protect of [false, true]) {
    const f = await fixture({ control: { memoryDrainTimeoutMs: 5 } });
    try {
      const lower = await f.allocate("large", 1000);
      const id = (lower.body as { id: string }).id;
      const instance = f.control.retainProviderRequest(id, "large", "running");
      expect((await f.allocate()).status).toBe(503);
      if (protect) f.registry.runtimes.find(r => r.id === "large")!.policy.warm!.minInstances = 1;
      else { f.setFree(56); await f.observer.refresh(); }
      f.control.releaseProviderRequest(instance, "running"); await f.control.flush();
      expect(f.calls).toEqual(["stop:small"]);
      expect(f.control.isRuntimeTransitioning("large")).toBe(false);
      expect(f.control.getAllocation(id)?.status).toBe("ready");
      expect(() => f.control.retainProviderRequest(id, "large", "next")).not.toThrow();
      f.control.releaseProviderRequest(instance, "next");
    } finally { f.control.beginDrain(); }
  }
});

test("a legacy lease acquired during drain protects its runtime before retirement", async () => {
  const f = await fixture({ control: { memoryDrainTimeoutMs: 5 } });
  try {
    f.registry.runtimes.find(r => r.id === "large")!.capability.push("legacy-only");
    const lower = await f.allocate("large", 1000);
    const id = (lower.body as { id: string }).id;
    const instance = f.control.retainProviderRequest(id, "large", "running");
    expect((await f.allocate()).status).toBe(503);
    expect((await f.control.prepare({ capabilities: ["legacy-only"] })).status).toBe(200);
    f.control.releaseProviderRequest(instance, "running"); await f.control.flush();
    expect(f.calls).toEqual(["stop:small"]);
    expect(f.control.getAllocation(id)?.status).toBe("ready");
    expect(f.control.isRuntimeTransitioning("large")).toBe(false);
  } finally { f.control.beginDrain(); }
});

test("deferred retirement does not stop a runtime after pressure moves to another node", async () => {
  const f = await fixture({ control: { memoryDrainTimeoutMs: 5 } });
  try {
    const lower = await f.allocate("large", 1000);
    const id = (lower.body as { id: string }).id;
    const instance = f.control.retainProviderRequest(id, "large", "running");
    let node = "node";
    await f.control.reclaimMemory({ priority: 3000, requestedRuntimeIds: ["target"],
      evaluateAdmission: () => ({ ok: false, reason: "memory_exhausted", node }) });
    expect(f.control.isRuntimeTransitioning("large")).toBe(true);
    node = "remote";
    f.control.releaseProviderRequest(instance, "running"); await f.control.flush();
    expect(f.calls).toEqual(["stop:small"]);
    expect(f.control.getAllocation(id)?.status).toBe("ready");
    expect(f.control.isRuntimeTransitioning("large")).toBe(false);
  } finally { f.control.beginDrain(); }
});

test("a request for a draining runtime does not reclaim unrelated services", async () => {
  const f = await fixture({ control: { memoryDrainTimeoutMs: 5 } });
  try {
    const lower = await f.allocate("large", 1000);
    const id = (lower.body as { id: string }).id;
    const instance = f.control.retainProviderRequest(id, "large", "running");
    expect((await f.allocate()).status).toBe(503);
    f.running.add("small");
    f.registry.nodes[0]!.resources.memoryTotalGB = 48;
    await f.observer.refresh();
    expect((await f.allocate("large", 1000)).body).toMatchObject({ status: "waiting" });
    expect(f.calls).toEqual(["stop:small"]);
    f.control.beginDrain();
    f.control.releaseProviderRequest(instance, "running");
  } finally { f.control.beginDrain(); }
});

test("simultaneous completions reclaim only enough memory across deferred victims", async () => {
  const f = await fixture({ control: { memoryDrainTimeoutMs: 5 } });
  try {
    f.registry.runtimes.find(r => r.id === "target")!.resources.estimatedMemoryGB = 16;
    const large = await f.allocate("large", 1000);
    const small = await f.allocate("small", 1000);
    const largeId = (large.body as { id: string }).id;
    const smallId = (small.body as { id: string }).id;
    const largeInstance = f.control.retainProviderRequest(largeId, "large", "large-request");
    const smallInstance = f.control.retainProviderRequest(smallId, "small", "small-request");
    expect((await f.allocate()).status).toBe(503);
    expect(f.control.isRuntimeTransitioning("large")).toBe(true);
    expect(f.control.isRuntimeTransitioning("small")).toBe(true);
    f.control.releaseProviderRequest(largeInstance, "large-request");
    f.control.releaseProviderRequest(smallInstance, "small-request");
    await f.control.flush();
    expect(f.calls).toEqual(["stop:large"]);
    expect(f.control.isRuntimeTransitioning("small")).toBe(false);
    expect(f.control.getAllocation(smallId)?.status).toBe("ready");
    expect((await f.allocate()).status).toBe(202); await f.control.flush();
  } finally { f.control.beginDrain(); }
});

test("backend BUSY after request completion also delays retirement until the process is idle", async () => {
  const f = await fixture({ control: { memoryDrainTimeoutMs: 5 } });
  try {
    const lower = await f.allocate("large", 1000);
    const id = (lower.body as { id: string }).id;
    const instance = f.control.retainProviderRequest(id, "large", "running");
    expect((await f.allocate()).status).toBe(503);
    f.busy.add("large");
    f.control.releaseProviderRequest(instance, "running"); await f.control.flush();
    expect(f.calls).toEqual(["stop:small"]);
    expect(f.control.isRuntimeTransitioning("large")).toBe(true);
    f.busy.delete("large");
    for (let i = 0; i < 100 && f.control.isRuntimeTransitioning("large"); i++) await Bun.sleep(2);
    await f.control.flush();
    expect(f.calls).toEqual(["stop:small", "stop:large"]);
    expect((await f.allocate()).status).toBe(202); await f.control.flush();
  } finally { f.control.beginDrain(); }
});

test("a failed observation after deferred stop cannot publish the stale HOT runtime", async () => {
  const f = await fixture({ control: { memoryDrainTimeoutMs: 5 } });
  const list = f.backend.list;
  try {
    const lower = await f.allocate("large", 1000);
    const id = (lower.body as { id: string }).id;
    const instance = f.control.retainProviderRequest(id, "large", "running");
    expect((await f.allocate()).status).toBe(503);
    f.backend.list = async () => {
      if (!f.running.has("large")) throw new Error("post-stop observation failed");
      return await list();
    };
    f.control.releaseProviderRequest(instance, "running"); await f.control.flush();
    expect(f.calls).toEqual(["stop:small", "stop:large"]);
    expect((await f.allocate("large", 1000)).status).toBe(503);
    f.backend.list = list;
    await f.observer.refresh();
    expect((await f.allocate()).status).toBe(202); await f.control.flush();
  } finally { f.backend.list = list; f.control.beginDrain(); }
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
    expect((await f.allocate()).status).toBe(503);
    expect(f.calls).toEqual([]);
    for (const a of f.control.getAllocations()) await f.control.releaseAllocation(a.id);
    f.registry.runtimes.find(r => r.id === "large")!.policy.warm!.minInstances = 1;
    expect((await f.allocate()).status).toBe(503);
    expect(f.calls).toEqual([]);
  } finally { f.control.beginDrain(); }
});
test("stop failures or insufficient measured recovery never start the requested process", async () => {
  for (const options of [{ stopFails: true }, { freeAfterStop: 1 }]) {
    const f = await fixture(options);
    try {
      expect((await f.allocate()).status).toBe(503);
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

test("a historical estimate is not an occupied reservation; unavailable telemetry never evicts", async () => {
  const f = await fixture({ live: 56 });
  try {
    f.registry.runtimes[0]!.resources.estimatedMemoryGB = 100;
    expect((await f.allocate()).status).toBe(202);
    expect(f.calls.filter(c => c.startsWith("stop:"))).toEqual([]);
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

test("an existing waiter reuses a hot instance without evicting unrelated memory", async () => {
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
    expect(f.calls).toEqual([]);
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
    f.running.add("large"); f.running.delete("target"); await f.observer.refresh();
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


test("service recovery does not evict work based on historical reservations", async () => {
  const f = await fixture({ live: 56 });
  const ledger = new ServiceResourceLedger();
  try {
    // Fresh live headroom is sufficient even when old estimates suggest otherwise.
    f.registry.runtimes.find(r => r.id === "large")!.policy.warm!.minInstances = 1;
    const evaluateAdmission = () => ledger.admission("node", 32 * gb, {
      registry: f.registry, state: f.observer.getState(), allocations: f.control.getAllocations(),
      now: Date.now(), maxAgeMs: 1000,
    });
    expect(evaluateAdmission()).toMatchObject({ ok: true });
    await f.control.reclaimMemory({ evaluateAdmission });
    expect(f.calls).toEqual([]);
    expect(ledger.reservations()).toEqual([]);
  } finally { f.control.beginDrain(); }
});
