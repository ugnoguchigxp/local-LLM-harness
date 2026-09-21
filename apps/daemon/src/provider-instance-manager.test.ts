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
