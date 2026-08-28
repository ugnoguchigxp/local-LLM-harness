import { expect, test } from "bun:test";
import type { Registry, RuntimeReleaseDefinition } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { SwappableRuntimeBackend } from "@larm/backends";
import {
  CatalogManager,
  CatalogManagerError,
  computeCatalogGenerationRevision,
  type CatalogGeneration,
} from "./catalog-manager";
import type { ControlPlane } from "./controller";
import type { Observer } from "./observer";
import type { ArtifactManager } from "./artifact-manager";
import type { RuntimeReleaseManager } from "./runtime-release-manager";
import type { ExecutionGate } from "./execution-gate";
import { MutationCoordinator } from "./mutation-coordinator";

const registry: Registry = {
  nodes: [{
    id: "gnosis",
    endpoint: "http://127.0.0.1",
    resources: { memoryTotalGB: 64, reservedMemoryGB: 8 },
  }],
  runtimes: [{
    id: "resident",
    capability: ["llm.general"],
    protocol: "openai.chat-completions.v1",
    backend: "systemd",
    node: "gnosis",
    policy: { class: "resident" },
    resources: { estimatedMemoryGB: 24, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
    deployment: { service: "resident.service", healthPort: 8080, endpoint: "http://127.0.0.1:8080" },
  }],
  profiles: [],
  routes: [{
    id: "llm-default",
    capabilities: ["llm.general"],
    explicitOnly: false,
    candidates: [{ runtime: "resident", purpose: "primary" }],
  }],
};

function backend(): RuntimeBackend {
  return {
    list: async () => [],
    health: async (runtimeId) => ({ runtimeId, service: "Unknown", listening: false, healthOk: false, busy: false }),
    ensure: async (runtime) => ({ runtimeId: runtime.id, service: "Running", listening: true, healthOk: true, busy: false }),
    stop: async () => undefined,
  };
}

function generation(nextRegistry = registry): CatalogGeneration {
  const value = { registry: nextRegistry, artifacts: [], releases: [] as RuntimeReleaseDefinition[] };
  return { ...value, revision: computeCatalogGenerationRevision(value) };
}

function harness(
  current: CatalogGeneration,
  candidate: CatalogGeneration,
  observerFails = false,
  mutationCoordinator?: MutationCoordinator,
) {
  let reserved = false;
  let controlRegistry = current.registry;
  let observerRegistry = current.registry;
  let releaseCatalog: RuntimeReleaseDefinition[] = current.releases;
  let artifactCatalog = current.artifacts;
  const control = {
    catalogReloadBlockers: () => [],
    beginCatalogReload: () => {
      reserved = true;
      return { ok: true as const, release: () => { reserved = false; } };
    },
    replaceRegistry: (value: Registry) => { controlRegistry = value; },
  } as unknown as ControlPlane;
  const observer = {
    replaceRegistry: async (value: Registry) => {
      if (observerFails && value === candidate.registry) throw new Error("probe failed");
      observerRegistry = value;
      return {};
    },
  } as unknown as Observer;
  const artifacts = {
    hasActiveOperations: () => false,
    replaceCatalog: (value: CatalogGeneration["artifacts"]) => { artifactCatalog = value; },
  } as unknown as ArtifactManager;
  const releases = {
    catalogReplacementBlockers: () => [],
    replaceCatalog: async (value: RuntimeReleaseDefinition[]) => { releaseCatalog = value; },
  } as unknown as RuntimeReleaseManager;
  const execution = { totals: () => ({ active: 0, queued: 0 }) } as unknown as ExecutionGate;
  const manager = new CatalogManager(
    current,
    { configDir: "/unused", artifactManifestPath: "/unused", releaseCatalogPath: "/unused" },
    control,
    observer,
    new SwappableRuntimeBackend(backend()),
    artifacts,
    releases,
    execution,
    { load: () => candidate, createBackend: () => backend(), mutationCoordinator },
  );
  return {
    manager,
    state: () => ({ reserved, controlRegistry, observerRegistry, releaseCatalog, artifactCatalog }),
  };
}

test("catalog reload atomically activates a validated non-resident generation", async () => {
  const current = generation();
  const nextRegistry: Registry = {
    ...registry,
    routes: [...registry.routes, {
      id: "experimental",
      capabilities: ["llm.general"],
      explicitOnly: true,
      candidates: [{ runtime: "resident", purpose: "primary" }],
    }],
  };
  const candidate = generation(nextRegistry);
  const { manager, state } = harness(current, candidate);
  expect(manager.plan()).toMatchObject({ changed: true, allowed: true });
  const result = await manager.reload(current.revision, candidate.revision);
  expect(result).toMatchObject({ changed: false, currentRevision: candidate.revision });
  expect(manager.registry.routes).toHaveLength(2);
  expect(state()).toMatchObject({ reserved: false, controlRegistry: nextRegistry, observerRegistry: nextRegistry });
});

test("catalog reload rejects resident contract changes", async () => {
  const current = generation();
  const candidate = generation({
    ...registry,
    runtimes: registry.runtimes.map((runtime) => ({
      ...runtime,
      resources: { ...runtime.resources, estimatedMemoryGB: 25 },
    })),
  });
  const { manager } = harness(current, candidate);
  expect(manager.plan()).toMatchObject({
    allowed: false,
    blockers: ["resident_change_requires_attended_restart"],
  });
  await expect(manager.reload(current.revision, candidate.revision)).rejects.toMatchObject({
    code: "catalog_reload_blocked",
  });
});

test("failed catalog activation restores the complete previous generation", async () => {
  const current = generation();
  const candidate = generation({ ...registry, profiles: [{ id: "new", require: ["llm.general"] }] });
  const { manager, state } = harness(current, candidate, true);
  await expect(manager.reload(current.revision, candidate.revision)).rejects.toBeInstanceOf(CatalogManagerError);
  expect(manager.revision).toBe(current.revision);
  expect(state()).toMatchObject({
    reserved: false,
    controlRegistry: current.registry,
    observerRegistry: current.registry,
    releaseCatalog: current.releases,
    artifactCatalog: current.artifacts,
  });
});

test("invalid candidate errors are fail-closed and sanitized through the manager", () => {
  const current = generation();
  const manager = harness(current, current).manager;
  const broken = new CatalogManager(
    current,
    { configDir: "/unused", artifactManifestPath: "/unused", releaseCatalogPath: "/unused" },
    (manager as unknown as { control: ControlPlane }).control,
    (manager as unknown as { observer: Observer }).observer,
    (manager as unknown as { backend: SwappableRuntimeBackend }).backend,
    (manager as unknown as { artifactManager: ArtifactManager }).artifactManager,
    (manager as unknown as { runtimeReleaseManager: RuntimeReleaseManager }).runtimeReleaseManager,
    (manager as unknown as { executionGate: ExecutionGate }).executionGate,
    { load: () => { throw new Error("bad yaml"); } },
  );
  expect(() => broken.plan()).toThrow(/candidate catalog is invalid/);
});

test("catalog reload is deterministically blocked by another runtime mutation", async () => {
  const current = generation();
  const candidate = generation({ ...registry, profiles: [{ id: "new", require: ["llm.general"] }] });
  const coordinator = new MutationCoordinator();
  const mutation = coordinator.reserve("runtime-activation");
  const { manager } = harness(current, candidate, false, coordinator);
  await expect(manager.reload(current.revision, candidate.revision)).rejects.toMatchObject({
    code: "catalog_reload_blocked",
    blockers: ["mutation_in_progress:runtime-activation"],
  });
  mutation.release();
  expect((await manager.reload(current.revision, candidate.revision)).currentRevision).toBe(candidate.revision);
});

test("catalog reload releases its mutation lease when preflight throws unexpectedly", async () => {
  const current = generation();
  const candidate = generation({ ...registry, profiles: [{ id: "new", require: ["llm.general"] }] });
  const coordinator = new MutationCoordinator();
  const { manager } = harness(current, candidate, false, coordinator);
  const execution = (manager as unknown as { executionGate: ExecutionGate }).executionGate;
  execution.totals = () => { throw new Error("metrics unavailable"); };
  await expect(manager.reload(current.revision, candidate.revision)).rejects.toThrow("metrics unavailable");
  expect(coordinator.current()).toBeUndefined();
  const lease = coordinator.reserve("artifact-stage");
  lease.release();
});

test("an observability callback cannot roll back an activated catalog", async () => {
  const current = generation();
  const candidate = generation({ ...registry, profiles: [{ id: "new", require: ["llm.general"] }] });
  const base = harness(current, candidate);
  const source = base.manager as unknown as {
    control: ControlPlane;
    observer: Observer;
    backend: SwappableRuntimeBackend;
    artifactManager: ArtifactManager;
    runtimeReleaseManager: RuntimeReleaseManager;
    executionGate: ExecutionGate;
  };
  const manager = new CatalogManager(
    current,
    { configDir: "/unused", artifactManifestPath: "/unused", releaseCatalogPath: "/unused" },
    source.control,
    source.observer,
    source.backend,
    source.artifactManager,
    source.runtimeReleaseManager,
    source.executionGate,
    {
      load: () => candidate,
      createBackend: () => backend(),
      onEvent: () => { throw new Error("event sink unavailable"); },
    },
  );
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    expect((await manager.reload(current.revision, candidate.revision)).currentRevision).toBe(
      candidate.revision,
    );
  } finally {
    console.error = originalConsoleError;
  }
  expect(manager.revision).toBe(candidate.revision);
  expect(manager.registry).toBe(candidate.registry);
});
