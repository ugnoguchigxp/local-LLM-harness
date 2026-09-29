import { expect, test } from "bun:test";
import type { Allocation, AllocationRequest, ClusterState, Registry } from "@larm/core";
import { planAllocationRequestAdmission } from "./allocation-request-admission";

const registry: Registry = {
  nodes: [{
    id: "node",
    endpoint: "http://127.0.0.1",
    resources: { memoryTotalGB: 64, reservedMemoryGB: 8 },
  }],
  runtimes: [{
    id: "runtime",
    capability: ["llm"],
    protocol: "openai.chat-completions.v1",
    backend: "systemd",
    node: "node",
    policy: { class: "resident", swapGroup: "worker" },
    resources: {
      estimatedMemoryGB: 8,
      maxConcurrentAllocations: 2,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0,
      queueTimeoutMs: 100,
    },
    deployment: { service: "model.service", healthPort: 8080, endpoint: "http://127.0.0.1:8080" },
  }],
  profiles: [],
  routes: [{
    id: "route",
    capabilities: ["llm"],
    explicitOnly: false,
    candidates: [{ runtime: "runtime", purpose: "primary" }],
  }],
};

const state: ClusterState = {
  generatedAt: "2026-09-29T00:00:00.000Z",
  node: {
    id: "node",
    online: true,
    endpoint: "http://127.0.0.1",
    resources: { memoryTotalGB: 64, reservedMemoryGB: 8 },
  },
  runtimes: [{
    id: "runtime",
    status: "HOT",
    class: "resident",
    capability: ["llm"],
    node: "node",
    backend: "systemd",
    endpoint: "http://127.0.0.1:8080",
    service: "model.service",
    observedAt: "2026-09-29T00:00:00.000Z",
    health: { ok: true },
  }],
};

const request: AllocationRequest = {
  client: "test",
  requirements: [{ capability: "llm", route: "route" }],
  allowFallback: false,
  deploymentPolicy: "existing-only",
  priority: 0,
  ttlSeconds: 60,
  capacityPolicy: "reject",
};

function plan(overrides: Partial<Parameters<typeof planAllocationRequestAdmission>[0]> = {}) {
  const calls: string[] = [];
  const input: Parameters<typeof planAllocationRequestAdmission>[0] = {
    registry,
    request,
    getState: () => {
      calls.push("state");
      return state;
    },
    getAllocations: () => [],
    isLifecycleReserved: () => false,
    isRuntimeMutating: () => false,
    hasResourceConflict: () => {
      calls.push("conflict");
      return false;
    },
    providerSwitchHoldUntil: () => {
      calls.push("switch-hold");
      return undefined;
    },
    preemptLowerPriorityConflicts: () => calls.push("preempt"),
    requireFreshTelemetry: false,
    telemetryMaxAgeMs: 10_000,
    now: () => 0,
    onRejected: (reason) => calls.push(`reject:${reason}`),
    ...overrides,
  };
  return { result: planAllocationRequestAdmission(input), calls };
}

test("allocation admission preserves binding, conflict, preemption, and capacity-plan order", () => {
  const { result, calls } = plan();
  expect(result).toMatchObject({
    ok: true,
    runtimeIds: ["runtime"],
    capabilities: ["llm"],
    waiting: false,
  });
  expect(calls).toEqual(["state", "switch-hold", "conflict", "preempt", "state"]);
});

test("lifecycle and deployment conflicts reject before priority preemption", () => {
  const transitioning = plan({ isLifecycleReserved: () => true });
  expect(transitioning.result).toMatchObject({
    ok: false,
    result: { status: 409, body: { error: { code: "runtime_transition_in_progress" } } },
  });
  expect(transitioning.calls).toEqual([
    "state", "switch-hold", "conflict", "reject:runtime_transition_in_progress",
  ]);

  const mutating = plan({ isRuntimeMutating: () => true });
  expect(mutating.result).toMatchObject({
    ok: false,
    result: { status: 409, body: { error: { code: "deployment_in_progress" } } },
  });
  expect(mutating.calls).toEqual([
    "state", "switch-hold", "conflict", "reject:deployment_in_progress",
  ]);
});

test("wait policy can retain a lifecycle-conflicting request for admission planning", () => {
  const admitted: Allocation = {
    id: "existing",
    status: "ready",
    bindings: [{ runtime: "runtime" }],
    requirements: [{ capability: "llm", route: "route" }],
    expiresAt: "2026-09-29T00:01:00.000Z",
  } as Allocation;
  const waiting = plan({
    request: { ...request, capacityPolicy: "wait" },
    getAllocations: () => [admitted],
    isLifecycleReserved: () => true,
    hasResourceConflict: () => true,
  });
  expect(waiting.result).toMatchObject({ ok: true, waiting: true });
  expect(waiting.calls).toEqual(["state", "switch-hold", "preempt", "state"]);
});
