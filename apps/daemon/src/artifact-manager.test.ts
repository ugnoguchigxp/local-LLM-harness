import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Allocation, FileArtifactDefinition, Registry } from "@larm/core";
import {
  ArtifactStoreError,
  LocalArtifactStore,
  type RuntimeBackend,
  type RuntimeHealth,
} from "@larm/backends";
import { ArtifactManager, type ArtifactOperation } from "./artifact-manager";
import { Observer } from "./observer";
import { MutationCoordinator } from "./mutation-coordinator";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function setup(
  activeAllocations: () => Allocation[] = () => [],
  options: {
    sharedOwner?: boolean;
    historyLimit?: number;
    multipleArtifacts?: boolean;
    isRuntimeTransitioning?: (runtimeId: string) => boolean;
    maxPendingOperations?: number;
    mutationCoordinator?: MutationCoordinator;
    onOperationState?: (active: number) => void;
    startupTimeoutMs?: number;
  } = {},
) {
  let sequence = 0;
  const root = await mkdtemp(join(tmpdir(), "larm-manager-"));
  const target = join(root, "active", "model.gguf");
  const artifact: FileArtifactDefinition = {
    kind: "file",
    id: "tiny-model",
    role: "preferred-llm",
    source: "https://example.com/model.gguf",
    revision: "revision-1",
    filename: "model.gguf",
    path: target,
    bytes: 9,
    sha256: sha256("new-model"),
  };
  const secondTarget = join(root, "active", "model-two.gguf");
  const secondArtifact: FileArtifactDefinition | undefined = options.multipleArtifacts
    ? {
        ...artifact,
        id: "tiny-model-two",
        source: "https://example.com/model-two.gguf",
        filename: "model-two.gguf",
        path: secondTarget,
        bytes: 11,
        sha256: sha256("new-model-2"),
      }
    : undefined;
  const registry: Registry = {
    nodes: [{
      id: "local-node",
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
    }],
    runtimes: [{
      id: "worker",
      artifacts: ["tiny-model"],
      capability: ["llm.general"],
      protocol: "openai.chat-completions.v1",
      backend: "systemd",
      node: "local-node",
      policy: { class: "preferred" },
      resources: { estimatedMemoryGB: 24, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
      deployment: {
        service: "worker.service",
        healthPort: 8080,
        endpoint: "http://127.0.0.1:8080",
      },
    }],
    profiles: [],
    routes: [],
  };
  if (options.sharedOwner) {
    const baseRuntime = registry.runtimes[0]!;
    if (baseRuntime.backend !== "systemd") {
      throw new Error("test fixture requires a systemd runtime");
    }
    registry.runtimes.push({
      ...baseRuntime,
      id: "worker-shared",
      deployment: {
        service: "worker-shared.service",
        healthPort: 8081,
        endpoint: "http://127.0.0.1:8081",
      },
    });
  }
  if (secondArtifact) {
    registry.runtimes[0]!.artifacts?.push(secondArtifact.id);
  }
  const probes = new Map<string, RuntimeHealth>([["worker", {
    runtimeId: "worker",
    service: "Stopped",
    listening: false,
    healthOk: false,
    busy: false,
  }]]);
  if (options.sharedOwner) {
    probes.set("worker-shared", {
      runtimeId: "worker-shared",
      service: "Stopped",
      listening: false,
      healthOk: false,
      busy: false,
    });
  }
  const ensureCalls: string[] = [];
  const backend: RuntimeBackend = {
    list: async () => [...probes.values()],
    health: async (id) => probes.get(id)!,
    ensure: async (runtime) => {
      ensureCalls.push(runtime.id);
      const health: RuntimeHealth = {
        runtimeId: runtime.id,
        service: "Running",
        listening: true,
        healthOk: true,
        busy: false,
        httpStatus: 200,
      };
      probes.set(runtime.id, health);
      return health;
    },
    stop: async (id) => {
      probes.set(id, {
        runtimeId: id,
        service: "Stopped",
        listening: false,
        healthOk: false,
        busy: false,
      });
    },
  };
  const observer = new Observer(registry, backend);
  await observer.tick();
  const store = new LocalArtifactStore({
    stagingRoot: join(root, "staging"),
    rollbackRoot: join(root, "rollback"),
    stateRoot: join(root, "state"),
    random: () => String(++sequence),
    fetchImpl: async (input) => new Response(
      String(input).includes("model-two.gguf") ? "new-model-2" : "new-model",
    ),
  });
  const manager = new ArtifactManager(
    secondArtifact ? [artifact, secondArtifact] : [artifact],
    registry,
    store,
    backend,
    observer,
    {
      activeAllocations,
      isRuntimeTransitioning: options.isRuntimeTransitioning,
      pollIntervalMs: 0,
      random: () => String(++sequence),
      historyLimit: options.historyLimit,
      maxPendingOperations: options.maxPendingOperations,
      mutationCoordinator: options.mutationCoordinator,
      onOperationState: options.onOperationState,
      startupTimeoutMs: options.startupTimeoutMs,
    },
  );
  await manager.initialize();
  return {
    root,
    target,
    artifact,
    secondTarget,
    secondArtifact,
    manager,
    store,
    backend,
    probes,
    observer,
    ensureCalls,
  };
}

function activateRuntime(manager: ArtifactManager, artifactIds = ["tiny-model"]) {
  return manager.activateRuntimeRelease(
    "worker",
    "test-release",
    artifactIds,
    "test-config",
    "/health",
    async () => undefined,
  );
}

function rollbackRuntime(manager: ArtifactManager, artifactIds = ["tiny-model"]) {
  return manager.rollbackRuntimeRelease(
    "worker",
    "test-release",
    artifactIds,
    "test-config",
    "/health",
    async () => undefined,
  );
}

test("artifact manager stages, activates, health-checks, and rolls back a preferred runtime", async () => {
  const { root, target, manager } = await setup();
  try {
    await mkdir(join(root, "active"), { recursive: true });
    await writeFile(target, "old-model");
    const staged = await manager.stage("tiny-model");
    await manager.flush();
    expect(manager.getOperation(staged.id)?.status).toBe("succeeded");

    const activated = await activateRuntime(manager);
    await manager.flush();
    expect(manager.getOperation(activated.id)?.status).toBe("succeeded");
    expect(await readFile(target, "utf8")).toBe("new-model");

    const rolledBack = await rollbackRuntime(manager);
    await manager.flush();
    expect(manager.getOperation(rolledBack.id)?.status).toBe("succeeded");
    expect(await readFile(target, "utf8")).toBe("old-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager reports only unstaged bytes in deployment preflight", async () => {
  const { root, manager } = await setup(() => [], { multipleArtifacts: true });
  try {
    expect(await manager.inspectStagedArtifacts(["tiny-model", "tiny-model-two"])).toEqual({
      staged: false,
      additionalBytesRequired: 20,
    });
    const staged = await manager.stage("tiny-model");
    await manager.flush();
    expect(staged.status).toBe("succeeded");
    expect(await manager.inspectStagedArtifacts(["tiny-model", "tiny-model-two"])).toEqual({
      staged: false,
      additionalBytesRequired: 11,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release staging retries when a previously staged artifact is missing", async () => {
  const { root, artifact, manager, store } = await setup();
  try {
    const first = await manager.stageRelease("worker-r2", [artifact.id]);
    await manager.flush();
    const staged = await store.getStaged(artifact);
    expect(staged).toBeDefined();
    await rm(staged!.path, { force: true });

    const retried = await manager.stageRelease("worker-r2", [artifact.id]);
    await manager.flush();
    expect(retried.id).not.toBe(first.id);
    expect(retried.status).toBe("succeeded");
    expect(await store.getStaged(artifact)).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager bounds pending operations", async () => {
  const { root, manager } = await setup(() => [], { maxPendingOperations: 1 });
  try {
    const operations = (manager as unknown as {
      operations: Map<string, ArtifactOperation>;
    }).operations;
    operations.set("artifact_op_busy", {
      id: "artifact_op_busy",
      kind: "stage",
      artifactId: "tiny-model",
      status: "running",
      createdAt: new Date().toISOString(),
    });
    const rejected = await manager.stage("tiny-model");
    expect(rejected.status).toBe("failed");
    expect(rejected.error?.code).toBe("artifact_operation_capacity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager rejects activation while another allocation uses the runtime", async () => {
  let allocations: Allocation[] = [];
  const { root, manager } = await setup(() => allocations);
  try {
    const staged = await manager.stage("tiny-model");
    await manager.flush();
    expect(manager.getOperation(staged.id)?.status).toBe("succeeded");
    allocations = [{
      id: "alloc_active",
      bootEpoch: "epoch-test",
      status: "ready",
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
      bindings: [{
        capability: "llm.general",
        route: "llm-speed",
        runtime: "worker",
        node: "local-node",
        endpoint: "http://127.0.0.1:8080",
        status: "HOT",
        candidateRank: 1,
        fallback: false,
        selectionReason: "primary-live",
      }],
      allowFallback: false,
      deploymentPolicy: "existing-only",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }];
    const operation = await activateRuntime(manager);
    await manager.flush();
    expect(manager.getOperation(operation.id)).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ code: "runtime_in_use" }),
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager rejects activation during a control-plane lifecycle transition", async () => {
  const { root, manager } = await setup(() => [], {
    isRuntimeTransitioning: (runtimeId) => runtimeId === "worker",
  });
  try {
    await manager.stage("tiny-model");
    await manager.flush();
    const operation = await activateRuntime(manager);
    await manager.flush();
    expect(operation.status).toBe("failed");
    expect(operation.error?.code).toBe("runtime_transition_in_progress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager restores the previous revision when activated runtime health fails", async () => {
  const { root, target, manager, backend, probes } = await setup();
  try {
    await mkdir(join(root, "active"), { recursive: true });
    await writeFile(target, "old-model");
    const staged = await manager.stage("tiny-model");
    await manager.flush();
    expect(manager.getOperation(staged.id)?.status).toBe("succeeded");

    backend.ensure = async (runtime) => {
      const failed: RuntimeHealth = {
        runtimeId: runtime.id,
        service: "NotFound",
        listening: false,
        healthOk: false,
        busy: false,
      };
      probes.set(runtime.id, failed);
      return failed;
    };
    const activation = await activateRuntime(manager);
    await manager.flush();

    expect(manager.getOperation(activation.id)).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ code: "runtime_failed" }),
    }));
    expect(await readFile(target, "utf8")).toBe("old-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager times out a stalled health probe and restores the previous artifact", async () => {
  const { root, target, manager, backend, probes } = await setup(undefined, { startupTimeoutMs: 2 });
  try {
    await mkdir(join(root, "active"), { recursive: true });
    await writeFile(target, "old-model");
    await manager.stage("tiny-model");
    await manager.flush();
    backend.ensure = async (runtime) => {
      const stalled: RuntimeHealth = {
        runtimeId: runtime.id,
        service: "Running",
        listening: true,
        healthOk: false,
        busy: false,
      };
      probes.set(runtime.id, stalled);
      return stalled;
    };
    const activation = await activateRuntime(manager);
    await manager.flush();
    expect(activation).toMatchObject({ status: "failed", error: { code: "startup_timeout" } });
    expect(await readFile(target, "utf8")).toBe("old-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager marks unfinished journal operations interrupted on restart", async () => {
  const { root, manager, store } = await setup();
  try {
    await store.writeOperation({
      id: "artifact_op_interrupted",
      kind: "stage",
      artifactId: "tiny-model",
      status: "running",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    await manager.initialize();
    expect(manager.getOperation("artifact_op_interrupted")).toEqual(expect.objectContaining({
      status: "interrupted",
      error: expect.objectContaining({ code: "daemon_restarted" }),
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager orders restored operation history by timestamps", async () => {
  const { root, manager, store } = await setup();
  try {
    await store.writeOperation({
      id: "artifact_op_z_old",
      kind: "stage",
      releaseId: "worker-r2",
      status: "succeeded",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    await store.writeOperation({
      id: "artifact_op_a_new",
      kind: "stage",
      releaseId: "worker-r2",
      status: "succeeded",
      createdAt: "2026-08-28T00:00:01.000Z",
    });
    await manager.initialize();
    expect(manager.findLatestOperation({ kind: "stage", releaseId: "worker-r2" })?.id).toBe(
      "artifact_op_a_new",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager rejects changing a shared artifact while another owner is live", async () => {
  const { root, manager, probes } = await setup(() => [], { sharedOwner: true });
  try {
    const staged = await manager.stage("tiny-model");
    await manager.flush();
    expect(manager.getOperation(staged.id)?.status).toBe("succeeded");
    probes.set("worker-shared", {
      runtimeId: "worker-shared",
      service: "Running",
      listening: true,
      healthOk: true,
      busy: false,
      httpStatus: 200,
    });

    const activation = await activateRuntime(manager);
    await manager.flush();
    expect(manager.getOperation(activation.id)).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ code: "shared_artifact_in_use" }),
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback preserves a cold runtime instead of starting it", async () => {
  const { root, artifact, manager, store, ensureCalls } = await setup();
  try {
    const staged = await store.stage(artifact);
    await store.activate(artifact, staged);
    const rollback = await rollbackRuntime(manager);
    await manager.flush();
    expect(manager.getOperation(rollback.id)?.status).toBe("succeeded");
    expect(ensureCalls).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback preflights every artifact before changing any target", async () => {
  const { root, secondTarget, secondArtifact, manager, store } = await setup(
    () => [],
    { multipleArtifacts: true },
  );
  try {
    await mkdir(join(root, "active"), { recursive: true });
    await writeFile(secondTarget, "old-model-2");
    const staged = await store.stage(secondArtifact!);
    await store.activate(secondArtifact!, staged);

    const rollback = await rollbackRuntime(manager, ["tiny-model", "tiny-model-two"]);
    await manager.flush();
    expect(manager.getOperation(rollback.id)).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ code: "rollback_unavailable" }),
    }));
    expect(await readFile(secondTarget, "utf8")).toBe("new-model-2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact operation history is bounded in memory and on disk", async () => {
  const { root, manager, store } = await setup(() => [], { historyLimit: 1 });
  try {
    const first = await manager.stage("missing-one");
    const second = await manager.stage("missing-two");
    expect(manager.getOperation(first.id)).toBeUndefined();
    expect(manager.getOperation(second.id)?.status).toBe("failed");
    expect((await store.loadOperations()).map((operation) => operation.id)).toEqual([second.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager rejects malformed operation journals", async () => {
  const { root, manager, store } = await setup();
  try {
    await store.writeOperation({
      id: "artifact_op_bad",
      kind: "unknown",
      status: "succeeded",
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    await expect(manager.initialize()).rejects.toMatchObject({ code: "journal_corrupt" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager rejects unknown fields in operation journals", async () => {
  const { root, manager, store } = await setup();
  try {
    await store.writeOperation({
      id: "artifact_op_extra",
      kind: "stage",
      artifactId: "tiny-model",
      status: "succeeded",
      createdAt: "2026-08-28T00:00:00.000Z",
      unexpected: true,
    });
    await expect(manager.initialize()).rejects.toMatchObject({ code: "journal_corrupt" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager releases the mutation lease when failure journaling fails", async () => {
  const coordinator = new MutationCoordinator();
  const { root, manager, store } = await setup(undefined, { mutationCoordinator: coordinator });
  try {
    const writeOperation = store.writeOperation.bind(store);
    store.writeOperation = async (record) => {
      if (record.status === "failed") throw new Error("journal unavailable");
      await writeOperation(record);
    };
    await expect(manager.stage("missing-artifact")).rejects.toThrow("journal unavailable");
    expect(coordinator.current()).toBeUndefined();
    const lease = coordinator.reserve("runtime-activation");
    lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allow-listed ensure is mutation-reserved and journaled", async () => {
  const { root, manager, store } = await setup();
  try {
    const ensuring = manager.ensureRuntime("worker", "alloc_test");
    expect(manager.isRuntimeMutating("worker")).toBe(true);
    await ensuring;
    expect(manager.isRuntimeMutating("worker")).toBe(false);
    expect(await store.loadOperations()).toEqual([
      expect.objectContaining({
        kind: "activate",
        runtimeId: "worker",
        status: "succeeded",
      }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allow-listed ensure rolls back when cancellation arrives during final observation", async () => {
  const { root, target, manager, backend } = await setup();
  try {
    await mkdir(join(root, "active"), { recursive: true });
    await writeFile(target, "old-model");
    const originalList = backend.list.bind(backend);
    let listCalls = 0;
    let releaseObservation: (() => void) | undefined;
    backend.list = async () => {
      listCalls += 1;
      if (listCalls === 2) {
        await new Promise<void>((resolve) => {
          releaseObservation = resolve;
        });
      }
      return await originalList();
    };
    const controller = new AbortController();
    const ensuring = manager.ensureRuntime(
      "worker",
      "alloc_cancel",
      () => undefined,
      controller.signal,
    );
    while (!releaseObservation) {
      await Bun.sleep(0);
    }
    controller.abort(new Error("allocation expired"));
    releaseObservation();

    await expect(ensuring).rejects.toMatchObject({ code: "operation_cancelled" });
    expect(await readFile(target, "utf8")).toBe("old-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact manager drain cancels an in-flight staging operation", async () => {
  const { root, manager, store } = await setup();
  try {
    let started!: () => void;
    const stagingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    store.stage = async (_artifact, signal) => {
      started();
      return await new Promise((_resolve, reject) => {
        const cancelled = () => reject(new ArtifactStoreError(
          "operation_cancelled",
          signal?.reason instanceof Error ? signal.reason.message : "cancelled",
        ));
        if (signal?.aborted) {
          cancelled();
        } else {
          signal?.addEventListener("abort", cancelled, { once: true });
        }
      });
    };
    const operation = await manager.stage("tiny-model");
    await stagingStarted;
    manager.beginDrain();
    await manager.flush();
    expect(manager.getOperation(operation.id)).toEqual(expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ code: "operation_cancelled" }),
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime release activation records provider config and enforces its health contract", async () => {
  const { manager, artifact } = await setup();
  const staged = await manager.stageRelease("worker-r2", [artifact.id]);
  await manager.flush();
  expect(staged.status).toBe("succeeded");
  const activated = await manager.activateRuntimeRelease(
    "worker",
    "worker-r2",
    [artifact.id],
    "worker-config-r2",
    "/health",
    async () => undefined,
  );
  await manager.flush();
  expect(activated.status).toBe("succeeded");
  expect(activated.result).toMatchObject({
    release: "worker-r2",
    providerConfigRevision: "worker-config-r2",
    healthPath: "/health",
  });

  const rejected = await manager.activateRuntimeRelease(
    "worker",
    "worker-r3",
    [artifact.id],
    "worker-config-r3",
    "/readyz",
    async () => undefined,
  );
  expect(rejected).toMatchObject({
    status: "failed",
    error: { code: "health_contract_mismatch" },
  });
});

test("artifact operations share the global mutation coordinator and publish an active gauge", async () => {
  const coordinator = new MutationCoordinator();
  const states: number[] = [];
  const { manager } = await setup(undefined, {
    mutationCoordinator: coordinator,
    onOperationState: (active) => states.push(active),
  });
  const catalog = coordinator.reserve("runtime-activation");
  const rejected = await manager.stage("tiny-model");
  expect(rejected).toMatchObject({ status: "failed", error: { code: "mutation_in_progress" } });
  catalog.release();
  const staged = await manager.stage("tiny-model");
  expect(manager.activeOperationCount()).toBe(1);
  await manager.flush();
  expect(staged.status).toBe("succeeded");
  expect(manager.activeOperationCount()).toBe(0);
  expect(states).toContain(1);
  expect(states.at(-1)).toBe(0);
});
