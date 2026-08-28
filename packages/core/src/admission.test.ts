import { expect, test } from "bun:test";
import type { Allocation } from "./allocation";
import { admitRuntimes } from "./admission";
import type { Registry } from "./registry";
import type { ClusterState, RuntimeSnapshot } from "./schema";

const registry: Registry = {
  nodes: [
    {
      id: "gnosis",
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 64, reservedMemoryGB: 16 },
    },
  ],
  runtimes: [
    {
      id: "resident",
      capability: ["llm.general"],
      protocol: "openai.chat-completions.v1",
      backend: "systemd",
      node: "gnosis",
      policy: { class: "resident" },
      resources: { estimatedMemoryGB: 24, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
      deployment: { service: "resident", healthPort: 1, endpoint: "http://127.0.0.1:1" },
    },
    {
      id: "worker",
      capability: ["llm.general", "llm.coding"],
      protocol: "openai.chat-completions.v1",
      backend: "systemd",
      node: "gnosis",
      policy: { class: "preferred" },
      resources: {
        estimatedMemoryGB: 24,
        maxConcurrentAllocations: 1,
        maxConcurrentRequests: 1,
        maxQueuedRequests: 0,
        queueTimeoutMs: 100,
      },
      deployment: { service: "worker", healthPort: 2, endpoint: "http://127.0.0.1:2" },
    },
  ],
  profiles: [],
  routes: [],
};

function snapshot(id: string, status: RuntimeSnapshot["status"]): RuntimeSnapshot {
  const runtime = registry.runtimes.find((item) => item.id === id)!;
  return {
    id,
    status,
    class: runtime.policy.class,
    capability: runtime.capability,
    node: runtime.node,
    backend: runtime.backend,
    endpoint: runtime.deployment.endpoint,
    observedAt: "2026-08-28T00:00:00.000Z",
  };
}

function state(runtimes: RuntimeSnapshot[]): ClusterState {
  return {
    generatedAt: "2026-08-28T00:00:00.000Z",
    node: {
      id: "gnosis",
      online: true,
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 64, reservedMemoryGB: 16 },
    },
    runtimes,
  };
}

function allocation(runtime: string): Allocation {
  return {
    id: "alloc_existing",
    bootEpoch: "epoch-test",
    status: "ready",
    requirements: [{ capability: "llm.general", route: "llm-speed" }],
    bindings: [{
      capability: "llm.general",
      route: "llm-speed",
      runtime,
      node: "gnosis",
      endpoint: "http://127.0.0.1:2",
      status: "HOT",
      candidateRank: 1,
      fallback: false,
      selectionReason: "primary-live",
    }],
    allowFallback: false,
    deploymentPolicy: "existing-only",
    createdAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2026-08-28T00:05:00.000Z",
  };
}

test("admission counts each runtime once across multiple capabilities", () => {
  const result = admitRuntimes({
    registry,
    state: state([]),
    allocations: [],
    candidateRuntimeIds: ["worker", "worker"],
  });
  expect(result).toEqual({
    ok: true,
    nodes: [{
      node: "gnosis",
      usableMemoryGB: 48,
      committedMemoryGB: 24,
      incrementalMemoryGB: 24,
      availableMemoryGB: 24,
    }],
  });
});

test("admission reserves resident memory even while its observation is cold", () => {
  registry.runtimes[1]!.resources.estimatedMemoryGB = 25;
  const result = admitRuntimes({
    registry,
    state: state([snapshot("resident", "COLD")]),
    allocations: [],
    candidateRuntimeIds: ["worker"],
  });
  registry.runtimes[1]!.resources.estimatedMemoryGB = 24;
  expect(result).toEqual(expect.objectContaining({
    ok: false,
    reason: "memory_exhausted",
  }));
});

test("admission rejects memory oversubscription while preserving the resident reserve", () => {
  const result = admitRuntimes({
    registry,
    state: state([snapshot("resident", "HOT")]),
    allocations: [],
    candidateRuntimeIds: ["worker"],
  });
  expect(result).toEqual(expect.objectContaining({
    ok: true,
  }));

  registry.runtimes[1]!.resources.estimatedMemoryGB = 25;
  const rejected = admitRuntimes({
    registry,
    state: state([snapshot("resident", "HOT")]),
    allocations: [],
    candidateRuntimeIds: ["worker"],
  });
  registry.runtimes[1]!.resources.estimatedMemoryGB = 24;
  expect(rejected).toEqual(expect.objectContaining({
    ok: false,
    reason: "memory_exhausted",
  }));
});

test("admission rejects a runtime at declared allocation capacity", () => {
  const result = admitRuntimes({
    registry,
    state: state([snapshot("worker", "HOT")]),
    allocations: [allocation("worker")],
    candidateRuntimeIds: ["worker"],
  });
  expect(result).toEqual(expect.objectContaining({
    ok: false,
    reason: "runtime_capacity",
    runtime: "worker",
  }));
});
