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
