import { expect, test } from "bun:test";
import type { Allocation, ClusterState, Registry } from "@larm/core";
import { planAllocationCapacity } from "./allocation-admission-planner";

const registry = {
  nodes: [{ id: "node", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 128, reservedMemoryGB: 16 } }],
  runtimes: [{
    id: "runtime",
    capability: ["llm"],
    protocol: "openai.chat-completions.v1",
    backend: "systemd",
    node: "node",
    policy: { class: "resident" },
    resources: { estimatedMemoryGB: 8, maxConcurrentRequests: 1, maxConcurrentAllocations: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
    deployment: { service: "model.service", healthPort: 8080, endpoint: "http://127.0.0.1:8080" },
  }],
  profiles: [],
  routes: [],
} as unknown as Registry;
const state = {
  generatedAt: "2026-09-29T00:00:00.000Z",
  online: true,
  node: { id: "node", online: true, endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 128, reservedMemoryGB: 16 } },
  runtimes: [],
} as unknown as ClusterState;

function allocation(status: Allocation["status"], priority: number): Allocation {
  return { id: `${status}-${priority}`, status, priority, bindings: [{ runtime: "runtime" }] } as unknown as Allocation;
}

function input(overrides: Partial<Parameters<typeof planAllocationCapacity>[0]> = {}) {
  return {
    registry,
    state,
    allocations: [] as Allocation[],
    runtimeIds: ["runtime"],
    priority: 10,
    capacityPolicy: "reject" as const,
    conflictsWithAdmitted: false,
    requireFreshTelemetry: false,
    telemetryMaxAgeMs: 10_000,
    now: Date.parse("2026-09-29T00:00:00.000Z"),
    ...overrides,
  };
}

test("admits available capacity and waits only when requested by capacity policy", () => {
  expect(planAllocationCapacity(input())).toEqual({ ok: true, waiting: false });
  expect(planAllocationCapacity(input({
    capacityPolicy: "wait",
    allocations: [allocation("waiting", 10)],
  }))).toEqual({ ok: true, waiting: true });
});

test("rejects switch holds and reports the stable compatibility error", () => {
  const holdUntil = input().now! + 60_000;
  expect(planAllocationCapacity(input({ providerSwitchHoldUntil: holdUntil }))).toMatchObject({
    ok: false,
    reason: "provider_switch_hold",
    result: {
      status: 409,
      body: { error: { code: "resource_exhausted", message: "provider switch is held for foreground reuse" } },
    },
  });
});

test("higher-priority allocations wait or fail with the existing reason", () => {
  const higher = allocation("ready", 20);
  expect(planAllocationCapacity(input({ allocations: [higher], capacityPolicy: "wait" })))
    .toEqual({ ok: true, waiting: true });
  expect(planAllocationCapacity(input({ allocations: [higher] }))).toMatchObject({
    ok: false,
    reason: "higher_priority_allocation_active",
    result: { body: { error: { code: "resource_exhausted" } } },
  });
});

test("lower-priority work shares a warm multi-slot runtime and waits when all slots are reserved", () => {
  const sharedRegistry = structuredClone(registry);
  sharedRegistry.runtimes[0]!.resources.maxConcurrentAllocations = 4;
  sharedRegistry.runtimes[0]!.policy.swapGroup = "conversation";
  const foreground = allocation("ready", 20);
  expect(planAllocationCapacity(input({ registry: sharedRegistry, allocations: [foreground], capacityPolicy: "wait" })))
    .toEqual({ ok: true, waiting: false });
  const full = Array.from({ length: 4 }, (_, index) => ({ ...foreground, id: `slot-${index}` }));
  expect(planAllocationCapacity(input({ registry: sharedRegistry, allocations: full, capacityPolicy: "wait", conflictsWithAdmitted: true })))
    .toEqual({ ok: true, waiting: true });
});

test("old estimates do not refuse demand starts; real live shortage remains structured", () => {
  const memoryRegistry = structuredClone(registry);
  memoryRegistry.runtimes[0]!.policy.class = "preferred";
  memoryRegistry.runtimes[0]!.resources.estimatedMemoryGB = 120;
  expect(planAllocationCapacity(input({registry:memoryRegistry}))).toEqual({ok:true,waiting:false});
  const liveState = structuredClone(state);
  liveState.node.telemetry = { status: "available", source: "test", observedAt: liveState.generatedAt,
    systemMemoryAvailableBytes: 4 * 1024 ** 3 };
  expect(planAllocationCapacity(input({ registry: memoryRegistry, state: liveState, requireFreshTelemetry: true })))
    .toMatchObject({ ok: false, result: { status: 503, body: { error: {
      code: "resource_exhausted", reason: "live_memory_exhausted",
      admission: [{ effectiveLiveAvailableMemoryGB: 0 }],
    } } } });
});

test("reusing a warm provider needs no new memory despite zero live headroom", () => {
  for (const policyClass of ["resident", "preferred"] as const) {
    const warmRegistry = structuredClone(registry);
    warmRegistry.runtimes[0]!.policy.class = policyClass;
    const warmState = structuredClone(state);
    warmState.runtimes = [{ id: "runtime", status: "HOT" } as ClusterState["runtimes"][number]];
    warmState.node.telemetry = { status: "available", source: "test", observedAt: warmState.generatedAt,
      systemMemoryAvailableBytes: 0 };
    expect(planAllocationCapacity(input({ registry: warmRegistry, state: warmState, requireFreshTelemetry: true })))
      .toEqual({ ok: true, waiting: false });
  }
});
