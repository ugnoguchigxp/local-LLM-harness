import { expect, test } from "bun:test";
import {
  compileProviderRevision,
  type ProviderInstance,
  type RuntimeDefinition,
} from "@larm/core";
import { LifecycleError, type RuntimeBackend } from "@larm/backends";
import { ProviderInstanceManager } from "./provider-instance-manager";

const runtime: RuntimeDefinition = {
  id: "worker",
  backend: "llama-swap",
  capability: ["llm.coding"],
  protocol: "openai.chat-completions.v1",
  node: "local-node",
  policy: {
    class: "preferred",
    lifecycle: "managed",
    warm: { minInstances: 0, idleTtlSeconds: 0 },
  },
  resources: {
    estimatedMemoryGB: 1,
    maxConcurrentRequests: 1,
    maxQueuedRequests: 0,
    queueTimeoutMs: 100,
  },
  deployment: {
    modelId: "worker",
    listen: "http://127.0.0.1:8083",
    endpoint: "http://127.0.0.1:8083/upstream/worker",
  },
};

function fixture(idleTtlMs = 0) {
  let ensureCount = 0;
  const stopped: string[] = [];
  const backend: RuntimeBackend = {
    list: async () => [],
    health: async (runtimeId) => ({
      runtimeId,
      service: "Running",
      listening: true,
      healthOk: true,
      busy: false,
    }),
    ensure: async () => { throw new Error("legacy ensure must not be used"); },
    stop: async () => { throw new Error("legacy stop must not be used"); },
    ensureInstance: async (revision): Promise<ProviderInstance> => {
      ensureCount += 1;
      return {
        id: `instance-${ensureCount}`,
        runtimeId: runtime.id,
        revision: revision.revision,
        generation: ensureCount,
        node: runtime.node,
        endpoint: runtime.deployment.endpoint,
        backendEndpoint: runtime.deployment.endpoint,
        status: "HOT",
        createdAt: new Date(0).toISOString(),
      };
    },
    drainInstance: async () => undefined,
    stopInstance: async (id) => { stopped.push(id); },
  };
  const manager = new ProviderInstanceManager(backend, { idleTtlMs, now: () => 0 });
  return { manager, stopped, getEnsureCount: () => ensureCount };
}

test("elastic lifetimes keep their runtime TTL under the production Preferred grace period", async () => {
  const { manager, stopped } = fixture(60_000);
  const elastic = { ...runtime, policy: { ...runtime.policy, class: "elastic" as const } };
  const instance = await manager.acquire(elastic, "vision", "release-a");
  manager.retainRequest(instance.id, "inflight-image");
  manager.releaseAllocation("vision");
  await Bun.sleep(0);
  expect(stopped).toEqual([]);
  manager.releaseRequest(instance.id, "inflight-image");
  await Bun.sleep(0);
  expect(stopped).toEqual([instance.id]);

  const delayed = { ...elastic, policy: { ...elastic.policy, warm: { minInstances: 0, idleTtlSeconds: 5 } } };
  await manager.acquire(delayed, "delayed", "release-b");
  manager.releaseAllocation("delayed");
  expect(manager.inspect()[0]?.idleDeadline).toBe(new Date(5000).toISOString());
  manager.close();
});

test("Preferred runtimes retain the configured daemon grace period", async () => {
  const { manager, stopped } = fixture(60_000);
  await manager.acquire(runtime, "preferred", "release-a");
  manager.releaseAllocation("preferred");
  expect(manager.inspect()[0]?.idleDeadline).toBe(new Date(60_000).toISOString());
  expect(stopped).toEqual([]);
  manager.close();
});

test("memory reclamation overrides idle TTL but rechecks request, mutation and retention references", async () => {
  const { manager, stopped } = fixture(60_000);
  try {
    const instance = await manager.acquire(runtime, "allocation", "release-a");
    expect(await manager.reclaimIdle(runtime.id)).toBe(false);
    manager.retainRequest(instance.id, "request");
    manager.retainMutation(instance.id, "mutation");
    manager.releaseAllocation("allocation");
    expect(await manager.reclaimIdle(runtime.id)).toBe(false);
    manager.releaseRequest(instance.id, "request");
    expect(await manager.reclaimIdle(runtime.id)).toBe(false);
    manager.retainUntilNextProfile([runtime.id]);
    manager.releaseMutation(instance.id, "mutation");
    expect(await manager.reclaimIdle(runtime.id)).toBe(false);
    manager.retainUntilNextProfile([]);
    expect(await manager.reclaimIdle(runtime.id)).toBe(true);
    expect(stopped).toEqual([instance.id]);
  } finally { manager.close(); }
});

test("shares a revision and stops only after the last allocation reference", async () => {
  const { manager, stopped, getEnsureCount } = fixture();
  const [first, second] = await Promise.all([
    manager.acquire(runtime, "allocation-a", "release-a"),
    manager.acquire(runtime, "allocation-b", "release-a"),
  ]);
  expect(second.id).toBe(first.id);
  expect(getEnsureCount()).toBe(1);
  manager.releaseAllocation("allocation-a");
  await Bun.sleep(0);
  expect(stopped).toEqual([]);
  manager.releaseAllocation("allocation-b");
  await Bun.sleep(0);
  expect(stopped).toEqual([first.id]);
});

test("retention survives the last reference and keeps shared providers during handover", async () => {
  const { manager, stopped, getEnsureCount } = fixture();
  manager.retainUntilNextProfile([runtime.id]);
  const instance = await manager.acquire(runtime, "first", "release-a");
  manager.releaseAllocation("first");
  await Bun.sleep(1);
  expect(stopped).toEqual([]);
  await manager.releaseRetained([runtime.id]);
  expect(stopped).toEqual([]);
  const reused = await manager.acquire(runtime, "second", "release-a");
  expect(reused.id).toBe(instance.id);
  expect(getEnsureCount()).toBe(1);
  manager.releaseAllocation("second");
  await manager.releaseRetained([]);
  expect(stopped).toEqual([instance.id]);
});

test("profile handover preserves an independent shared provider warm floor", async () => {
  const { manager, stopped } = fixture();
  const shared = { ...runtime, policy: { ...runtime.policy, warm: { minInstances: 1, idleTtlSeconds: 0 } } };
  await manager.ensureWarm(shared, "shared-release");
  manager.retainUntilNextProfile([shared.id], []);
  await manager.releaseRetained([], []);
  expect(stopped).toEqual([]);
  expect(manager.inspect()[0]!.warmRefs).toBe(1);
});

test("request reference cancels an idle stop and revision changes do not alias", async () => {
  const { manager, stopped } = fixture();
  const first = await manager.acquire(runtime, "allocation-a", "release-a");
  manager.retainRequest(first.id, "request-a");
  manager.releaseAllocation("allocation-a");
  await Bun.sleep(0);
  expect(stopped).toEqual([]);
  manager.releaseRequest(first.id, "request-a");
  await Bun.sleep(0);
  expect(stopped).toEqual([first.id]);

  const nextRevision = compileProviderRevision({ runtime, runtimeRelease: "release-b" });
  const second = await manager.acquire(runtime, "allocation-b", "release-b");
  expect(second.revision).toBe(nextRevision.revision);
  expect(second.id).not.toBe(first.id);
});

test("warm policy preserves a zero-reference resident instance", async () => {
  const { manager, stopped } = fixture();
  const resident = {
    ...runtime,
    id: "resident",
    policy: { class: "resident" as const },
    deployment: { ...runtime.deployment, modelId: "resident" },
  };
  await manager.ensureWarm(resident, "release-a");
  await Bun.sleep(0);
  expect(stopped).toEqual([]);
  expect(manager.inspect()[0]?.warmRefs).toBe(1);
});

test("rechecks and recovers a managed instance that became cold outside the manager", async () => {
  let status: ProviderInstance["status"] = "HOT";
  let ensureCount = 0;
  const instance = (revision: string): ProviderInstance => ({
    id: "instance-recoverable",
    runtimeId: runtime.id,
    revision,
    generation: 1,
    node: runtime.node,
    endpoint: runtime.deployment.endpoint,
    backendEndpoint: runtime.deployment.endpoint,
    status,
    createdAt: new Date(0).toISOString(),
  });
  const backend: RuntimeBackend = {
    list: async () => [],
    health: async () => ({
      runtimeId: runtime.id,
      service: status === "COLD" ? "Stopped" : "Running",
      listening: status !== "COLD",
      healthOk: status !== "COLD",
      busy: false,
    }),
    ensure: async () => { throw new Error("unexpected legacy ensure"); },
    stop: async () => undefined,
    ensureInstance: async (revision) => {
      ensureCount += 1;
      status = "HOT";
      return instance(revision.revision);
    },
    healthInstance: async (id) => ({
      ...instance(compileProviderRevision({ runtime, runtimeRelease: "release-a" }).revision),
      id,
      status,
      service: status === "COLD" ? "Stopped" : "Running",
      listening: status !== "COLD",
      healthOk: status !== "COLD",
      busy: false,
    }),
  };
  const manager = new ProviderInstanceManager(backend, { idleTtlMs: 10_000 });
  await manager.acquire(runtime, "allocation-a", "release-a");
  status = "COLD";
  await manager.acquire(runtime, "allocation-b", "release-a");
  expect(ensureCount).toBe(2);
  expect(manager.inspect()[0]?.instance.status).toBe("HOT");
  manager.close();
});

test("one cancelled waiter does not cancel a shared ensure", async () => {
  let finish!: (instance: ProviderInstance) => void;
  const ensured = new Promise<ProviderInstance>((resolve) => { finish = resolve; });
  let backendSignal: AbortSignal | undefined;
  let ensureCount = 0;
  const backend: RuntimeBackend = {
    list: async () => [],
    health: async () => ({ runtimeId: runtime.id, service: "Running", listening: true, healthOk: true, busy: false }),
    ensure: async () => { throw new Error("unexpected legacy ensure"); },
    stop: async () => undefined,
    ensureInstance: async (revision, _runtime, signal) => {
      ensureCount += 1;
      backendSignal = signal;
      const instance = await ensured;
      return { ...instance, revision: revision.revision };
    },
  };
  const manager = new ProviderInstanceManager(backend);
  const cancelled = new AbortController();
  const first = manager.acquire(runtime, "allocation-a", "release-a", cancelled.signal);
  const second = manager.acquire(runtime, "allocation-b", "release-a");
  cancelled.abort(new Error("caller left"));
  await expect(first).rejects.toThrow("caller left");
  expect(backendSignal?.aborted).toBe(false);
  finish({
    id: "instance-shared",
    runtimeId: runtime.id,
    revision: "0".repeat(64),
    generation: 1,
    node: runtime.node,
    endpoint: runtime.deployment.endpoint,
    backendEndpoint: runtime.deployment.endpoint,
    status: "HOT",
    createdAt: new Date(0).toISOString(),
  });
  expect((await second).id).toBe("instance-shared");
  expect(ensureCount).toBe(1);
});

test("active old revision rejects a replacement instead of aliasing the daemon", async () => {
  const { manager, stopped, getEnsureCount } = fixture(10_000);
  await manager.acquire(runtime, "allocation-a", "release-a");
  await expect(manager.acquire(runtime, "allocation-b", "release-b")).rejects.toMatchObject({
    code: "revision_conflict",
  } satisfies Partial<LifecycleError>);
  expect(getEnsureCount()).toBe(1);
  expect(stopped).toEqual([]);
  manager.close();
});

test("idle old revision is retired before its replacement starts", async () => {
  const { manager, stopped, getEnsureCount } = fixture(10_000);
  const first = await manager.acquire(runtime, "allocation-a", "release-a");
  manager.releaseAllocation("allocation-a");
  const second = await manager.acquire(runtime, "allocation-b", "release-b");
  expect(stopped).toEqual([first.id]);
  expect(second.id).not.toBe(first.id);
  expect(getEnsureCount()).toBe(2);
  manager.close();
});

test("concurrent different revisions for one runtime fail closed", async () => {
  let finish!: (instance: ProviderInstance) => void;
  const pending = new Promise<ProviderInstance>((resolve) => { finish = resolve; });
  let ensureCount = 0;
  const backend: RuntimeBackend = {
    list: async () => [],
    health: async () => ({ runtimeId: runtime.id, service: "Running", listening: true, healthOk: true, busy: false }),
    ensure: async () => { throw new Error("unexpected legacy ensure"); },
    stop: async () => undefined,
    ensureInstance: async (revision) => {
      ensureCount += 1;
      const instance = await pending;
      return { ...instance, revision: revision.revision };
    },
  };
  const manager = new ProviderInstanceManager(backend);
  const first = manager.acquire(runtime, "allocation-a", "release-a");
  await expect(manager.acquire(runtime, "allocation-b", "release-b")).rejects.toMatchObject({
    code: "revision_conflict",
  } satisfies Partial<LifecycleError>);
  finish({
    id: "instance-first",
    runtimeId: runtime.id,
    revision: "0".repeat(64),
    generation: 1,
    node: runtime.node,
    endpoint: runtime.deployment.endpoint,
    backendEndpoint: runtime.deployment.endpoint,
    status: "HOT",
    createdAt: new Date(0).toISOString(),
  });
  await first;
  expect(ensureCount).toBe(1);
  manager.close();
});

test("a later acquire retries cleanup after an idle stop failure", async () => {
  let ensureCount = 0;
  let stopCount = 0;
  const backend: RuntimeBackend = {
    list: async () => [],
    health: async () => ({ runtimeId: runtime.id, service: "Running", listening: true, healthOk: true, busy: false }),
    ensure: async () => { throw new Error("unexpected legacy ensure"); },
    stop: async () => undefined,
    ensureInstance: async (revision) => {
      ensureCount += 1;
      return {
        id: `instance-${ensureCount}`,
        runtimeId: runtime.id,
        revision: revision.revision,
        generation: ensureCount,
        node: runtime.node,
        endpoint: runtime.deployment.endpoint,
        backendEndpoint: runtime.deployment.endpoint,
        status: "HOT",
        createdAt: new Date(0).toISOString(),
      };
    },
    stopInstance: async () => {
      stopCount += 1;
      if (stopCount === 1) throw new Error("temporary stop failure");
    },
  };
  const manager = new ProviderInstanceManager(backend, { idleTtlMs: 0 });
  const first = await manager.acquire(runtime, "allocation-a", "release-a");
  manager.releaseAllocation("allocation-a");
  await Bun.sleep(0);
  expect(manager.inspect()[0]?.instance.status).toBe("FAILED");
  const recovered = await manager.acquire(runtime, "allocation-b", "release-a");
  expect(recovered.id).not.toBe(first.id);
  expect(stopCount).toBe(2);
  expect(ensureCount).toBe(2);
  manager.close();
});

test("preempted background instances stop after request drain while shared warm instances remain loaded", async () => {
  const { manager, stopped } = fixture(60_000);
  const background = await manager.acquire(runtime, "background", "release-a");
  manager.retainRequest(background.id, "running");
  manager.releaseAllocation("background", true);
  await Bun.sleep(0);
  expect(stopped).toEqual([]);
  manager.releaseRequest(background.id, "running");
  await Bun.sleep(0);
  expect(stopped).toEqual([background.id]);
  const warm = { ...runtime, policy: { ...runtime.policy, warm: { minInstances: 1, idleTtlSeconds: 60 } } };
  const shared = await manager.ensureWarm(warm, "release-a");
  await manager.acquire(warm, "background-again", "release-a");
  manager.releaseAllocation("background-again", true);
  await Bun.sleep(0);
  expect(stopped).toEqual([background.id]);
  expect(manager.inspect().find(item => item.instance.id === shared!.id)).toMatchObject({ warmRefs: 1, refs: { allocation: 0 } });
  manager.close();
});
