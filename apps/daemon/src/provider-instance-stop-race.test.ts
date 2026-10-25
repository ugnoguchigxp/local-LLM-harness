import { expect, test } from "bun:test";
import type { ProviderInstance, RuntimeDefinition } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { ProviderInstanceManager } from "./provider-instance-manager";

const runtime: RuntimeDefinition = {
  id: "on-demand", capability: ["vision.perception"], protocol: "larm.visual-perception.v1", backend: "systemd", node: "node",
  policy: { class: "elastic", lifecycle: "managed", warm: { minInstances: 0, idleTtlSeconds: 0 } },
  resources: { estimatedMemoryGB: 20, maxConcurrentAllocations: 1, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
  deployment: { scope: "user", service: "fixture.service", healthPort: 8094, endpoint: "http://127.0.0.1:8094" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function fixture() {
  let instance: ProviderInstance | undefined;
  let generations = 0;
  let healthCalls = 0;
  const stopping = deferred<void>();
  const finishStop = deferred<void>();
  const probing = deferred<void>();
  const finishProbe = deferred<void>();
  let holdProbe = false;
  const backend: RuntimeBackend = {
    list: async () => [], health: async () => ({ runtimeId: runtime.id, service: "Running", listening: true, healthOk: true, busy: false }),
    ensure: async () => { throw new Error("legacy ensure forbidden"); }, stop: async () => { throw new Error("legacy stop forbidden"); },
    ensureInstance: async revision => {
      if (instance) return instance; // The existing systemd backend caches the live revision.
      generations++;
      instance = { id: `instance-${generations}`, runtimeId: runtime.id, revision: revision.revision, generation: generations,
        node: runtime.node, endpoint: runtime.deployment.endpoint, backendEndpoint: runtime.deployment.endpoint,
        status: "HOT", createdAt: new Date().toISOString() };
      return instance;
    },
    healthInstance: async () => {
      healthCalls++;
      const current = instance!;
      probing.resolve();
      if (holdProbe) await finishProbe.promise;
      // The old listener may answer while the stop command is in flight.
      return { ...current, status: "HOT", service: "Running", listening: true, healthOk: true, busy: false };
    },
    drainInstance: async () => {},
    stopInstance: async () => { stopping.resolve(); await finishStop.promise; instance = undefined; },
  };
  const manager = new ProviderInstanceManager(backend, { idleTtlMs: 60_000 });
  return { manager, stopping, finishStop, probing, finishProbe, holdProbe: () => { holdProbe = true; },
    generations: () => generations, healthCalls: () => healthCalls };
}

test("immediate reacquisition waits for an irreversible stop and binds a new generation", async () => {
  const f = fixture();
  try {
    const first = await f.manager.acquire(runtime, "cancelled", "release-a");
    f.manager.releaseAllocation("cancelled");
    await f.stopping.promise;
    let settled = false;
    const acquiring = f.manager.acquire(runtime, "replacement", "release-a").then(value => { settled = true; return value; });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(f.healthCalls()).toBe(0);
    f.finishStop.resolve();
    const next = await acquiring;
    expect(next.id).not.toBe(first.id);
    expect(next.generation).toBe(2);
    expect(f.generations()).toBe(2);
    expect(f.manager.inspect()).toMatchObject([{ instance: { id: next.id }, refs: { allocation: 1 } }]);
  } finally { f.finishStop.resolve(); f.manager.close(); }
});

test("a healthy probe arriving during stop cannot resurrect the retired generation", async () => {
  const f = fixture();
  try {
    const first = await f.manager.acquire(runtime, "first", "release-a");
    f.holdProbe();
    let settled = false;
    const acquiring = f.manager.acquire(runtime, "replacement", "release-a").then(value => { settled = true; return value; });
    await f.probing.promise;
    f.manager.releaseAllocation("first");
    await f.stopping.promise;
    f.finishProbe.resolve();
    await Bun.sleep(0);
    expect(settled).toBe(false);
    f.finishStop.resolve();
    const next = await acquiring;
    expect(next.id).not.toBe(first.id);
    expect(next.generation).toBe(2);
    expect(f.manager.inspect()).toHaveLength(1);
  } finally { f.finishProbe.resolve(); f.finishStop.resolve(); f.manager.close(); }
});

test("cancelling a waiter for stop completion does not start or cancel another generation", async () => {
  const f = fixture();
  try {
    await f.manager.acquire(runtime, "first", "release-a");
    f.manager.releaseAllocation("first"); await f.stopping.promise;
    const abort = new AbortController();
    const acquiring = f.manager.acquire(runtime, "cancelled-waiter", "release-a", abort.signal);
    abort.abort(new Error("caller cancelled"));
    await expect(acquiring).rejects.toThrow("caller cancelled");
    expect(f.generations()).toBe(1);
    f.finishStop.resolve();
    const next = await f.manager.acquire(runtime, "last", "release-a");
    expect(next.generation).toBe(2);
    expect(f.manager.inspect()).toMatchObject([{ refs: { allocation: 1 } }]);
  } finally { f.finishStop.resolve(); f.manager.close(); }
});
