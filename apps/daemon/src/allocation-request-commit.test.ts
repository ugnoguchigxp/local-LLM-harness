import { describe, expect, test } from "bun:test";
import type { Allocation, AllocationRequest } from "@larm/core";
import type { AllocationRequestAdmission } from "./allocation-request-admission";
import { commitAllocationRequest, type AllocationRequestCommitPort } from "./allocation-request-commit";

const request: AllocationRequest = {
  requirements: [{ capability: "llm.general", route: "route" }],
  client: "test",
  allowFallback: false,
  deploymentPolicy: "existing-only",
  priority: 1,
  ttlSeconds: 60,
  capacityPolicy: "reject",
};

function admitted(status: "HOT" | "COLD", waiting = false): Extract<
  AllocationRequestAdmission,
  { ok: true }
> {
  const binding = {
    capability: "llm.general",
    route: "route",
    runtime: "runtime",
    status,
  } as unknown as Allocation["bindings"][number];
  return {
    ok: true,
    capabilities: ["llm.general"],
    runtimeIds: ["runtime"],
    bindings: [binding],
    waiting,
  };
}

function fixture(overrides: Partial<AllocationRequestCommitPort> = {}) {
  const events: string[] = [];
  const allocations: Allocation[] = [];
  const operations: unknown[] = [];
  const port: AllocationRequestCommitPort = {
    allocationId: "alloc_epoch_id",
    bootEpoch: "epoch",
    catalogRevision: "catalog",
    request,
    admission: admitted("HOT"),
    now: Date.parse("2026-09-29T00:00:00.000Z"),
    storeAllocation: (allocation) => { events.push("store-allocation"); allocations.push(allocation); },
    retainExisting: () => { events.push("retain-existing"); return undefined; },
    requiresInstanceTracking: false,
    registerLifecycleAbort: () => events.push("register-abort"),
    emitCreated: () => events.push("emit-created"),
    emitReady: () => events.push("emit-ready"),
    scheduleExpiry: () => events.push("schedule-expiry"),
    cancelIdle: () => events.push("cancel-idle"),
    startupDeadline: () => { events.push("startup-deadline"); return 10_000; },
    createOperationId: () => "operation",
    storeOperation: (operation) => { events.push("store-operation"); operations.push(operation); },
    enqueueWaitingPromotion: () => events.push("enqueue-promotion"),
    enqueueStartup: () => events.push("enqueue-startup"),
    pruneHistory: () => events.push("prune-history"),
    ...overrides,
  };
  return { port, events, allocations, operations };
}

describe("allocation request commit", () => {
  test("commits an existing HOT allocation and publishes ready after expiry protection", () => {
    const state = fixture();
    const result = commitAllocationRequest(state.port);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      id: "alloc_epoch_id",
      bootEpoch: "epoch",
      catalogRevision: "catalog",
      status: "ready",
      expiresAt: "2026-09-29T00:01:00.000Z",
    });
    expect(state.events).toEqual([
      "store-allocation",
      "retain-existing",
      "register-abort",
      "emit-created",
      "schedule-expiry",
      "cancel-idle",
      "emit-ready",
      "prune-history",
    ]);
  });

  test("downgrades an unpinned ready binding when instance tracking is required", () => {
    const state = fixture({
      requiresInstanceTracking: true,
      startupDeadline: () => { state.events.push("startup-deadline"); return 10_000; },
    });
    const result = commitAllocationRequest(state.port);
    expect(result.status).toBe(202);
    expect(result.body.status).toBe("pending");
    expect(result.body.operationId).toBe("operation");
    expect(state.operations[0]).toMatchObject({
      status: "pending",
      phase: "scheduled",
      deadlineAt: new Date(10_000).toISOString(),
    });
    expect(state.events).toEqual([
      "store-allocation",
      "retain-existing",
      "register-abort",
      "emit-created",
      "schedule-expiry",
      "cancel-idle",
      "startup-deadline",
      "store-operation",
      "enqueue-startup",
      "prune-history",
    ]);
  });

  test("waiting allocations use expiry as deadline and enqueue promotion only", () => {
    const state = fixture({ admission: admitted("COLD", true) });
    const result = commitAllocationRequest(state.port);
    expect(result.status).toBe(202);
    expect(result.body.status).toBe("waiting");
    expect(state.operations[0]).toMatchObject({
      phase: "waiting-for-capacity",
      deadlineAt: "2026-09-29T00:01:00.000Z",
    });
    expect(state.events).toEqual([
      "store-allocation",
      "retain-existing",
      "register-abort",
      "emit-created",
      "schedule-expiry",
      "cancel-idle",
      "store-operation",
      "enqueue-promotion",
      "prune-history",
    ]);
  });
});
