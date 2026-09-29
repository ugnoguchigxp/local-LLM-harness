import { describe, expect, test } from "bun:test";
import type { Allocation, Registry } from "@larm/core";
import {
  commitWaitingAllocationPromotion,
  evaluateWaitingPromotion,
  promoteWaitingAllocationBatch,
  prioritizeWaitingAllocations,
} from "./allocation-waiting-promotion";
import type { Operation } from "./controller";

const admitted = { ok: true as const, plan: "ready" };
const rejected = { ok: false as const, reason: "capacity" };
const runtimeId = "runtime";
const registry = {
  nodes: [],
  profiles: [],
  routes: [],
  runtimes: [
    { id: runtimeId, policy: { swapGroup: "swap" } },
    { id: "swap-peer", policy: { swapGroup: "swap" } },
  ],
} as unknown as Registry;

function allocation(deploymentPolicy: Allocation["deploymentPolicy"] = "existing-only"): Allocation {
  return {
    id: "allocation",
    status: "waiting",
    deploymentPolicy,
    bindings: [{ runtime: runtimeId, status: "COLD" }],
  } as unknown as Allocation;
}

function operation(): Operation {
  return {
    id: "operation",
    kind: "allocation",
    allocationId: "allocation",
    status: "pending",
    ready: false,
    desired: [],
    ensure: [],
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

describe("waiting allocation promotion policy", () => {
  test("orders waiting allocations by priority, FIFO, then stable identifier", () => {
    const candidates = [
      { id: "z", status: "waiting", priority: 2, createdAt: "2026-09-29T00:00:00.000Z" },
      { id: "b", status: "waiting", priority: 2, createdAt: "2026-09-29T00:00:00.000Z" },
      { id: "old", status: "waiting", priority: 1, createdAt: "2026-09-28T00:00:00.000Z" },
      { id: "active", status: "ready", priority: 99, createdAt: "2026-09-27T00:00:00.000Z" },
    ] as unknown as Allocation[];
    expect(prioritizeWaitingAllocations(candidates).map(({ id }) => id)).toEqual(["b", "z", "old"]);
    expect(candidates.map(({ id }) => id)).toEqual(["z", "b", "old", "active"]);
  });

  test("provider switch holds retry at the hold boundary without evaluating admission", () => {
    const calls: string[] = [];
    const result = evaluateWaitingPromotion({
      registry,
      runtimeIds: [runtimeId],
      providerSwitchHoldUntil: 20_000,
      now: () => 12_000,
      pollIntervalMs: 500,
      isRuntimeBusy: () => { calls.push("busy"); return false; },
      hasHigherPriorityConflict: () => { calls.push("priority"); return false; },
      evaluateAdmission: () => { calls.push("admission"); return admitted; },
      hasAdmittedResourceConflict: () => false,
    });

    expect(result).toEqual({ kind: "wait", retryDelayMs: 8_000 });
    expect(calls).toEqual([]);
  });

  test("a mutation in a swap-group peer blocks promotion and requests a poll", () => {
    const result = evaluateWaitingPromotion({
      registry,
      runtimeIds: [runtimeId],
      now: () => 1_000,
      pollIntervalMs: 500,
      isRuntimeBusy: (id) => id === "swap-peer",
      hasHigherPriorityConflict: () => { throw new Error("should not evaluate priority"); },
      evaluateAdmission: () => { throw new Error("should not evaluate admission"); },
      hasAdmittedResourceConflict: () => false,
    });
    expect(result).toEqual({ kind: "wait", retryDelayMs: 500 });
  });

  test("admitted resource conflicts wait for state change while unblocked admission retries", () => {
    const common = {
      registry,
      runtimeIds: [runtimeId],
      now: () => 1_000,
      pollIntervalMs: 500,
      isRuntimeBusy: () => false,
      hasHigherPriorityConflict: () => false,
      evaluateAdmission: () => rejected,
    };
    expect(evaluateWaitingPromotion({
      ...common,
      hasAdmittedResourceConflict: () => true,
    })).toEqual({ kind: "wait" });
    expect(evaluateWaitingPromotion({
      ...common,
      hasAdmittedResourceConflict: () => false,
    })).toEqual({ kind: "wait", retryDelayMs: 500 });
  });

  test("returns admission only after lifecycle and priority checks pass", () => {
    const calls: string[] = [];
    const result = evaluateWaitingPromotion({
      registry,
      runtimeIds: [runtimeId],
      now: () => 1_000,
      pollIntervalMs: 500,
      isRuntimeBusy: () => false,
      hasHigherPriorityConflict: () => { calls.push("priority"); return false; },
      evaluateAdmission: () => { calls.push("admission"); return admitted; },
      hasAdmittedResourceConflict: () => false,
    });
    expect(result).toEqual({ kind: "admit" });
    expect(calls).toEqual(["priority", "admission"]);
  });

  test("commits ready state and operation before publishing readiness", async () => {
    const candidate = allocation();
    const currentOperation = operation();
    const events: string[] = [];
    await commitWaitingAllocationPromotion({
      allocation: candidate,
      runtimeStatuses: new Map([[runtimeId, "HOT"]]),
      operation: currentOperation,
      now: () => "2026-09-29T00:00:01.000Z",
      startupDeadline: () => { throw new Error("ready allocation has no startup deadline"); },
      onAdmitted: () => events.push("admitted"),
      onReady: () => events.push("ready"),
      failMissingOperation: () => { throw new Error("operation exists"); },
      runEnsure: async () => { throw new Error("ready allocation does not start runtime"); },
    });
    expect(candidate.bindings[0]?.status).toBe("HOT");
    expect(candidate.status).toBe("ready");
    expect(currentOperation).toMatchObject({
      status: "succeeded",
      ready: true,
      phase: "runtime-ready",
      completedAt: "2026-09-29T00:00:01.000Z",
    });
    expect(events).toEqual(["admitted", "ready"]);
  });

  test("fails closed if a non-ready waiter lost its startup operation", async () => {
    const candidate = allocation("allow-listed");
    const events: string[] = [];
    await commitWaitingAllocationPromotion({
      allocation: candidate,
      runtimeStatuses: new Map([[runtimeId, "COLD"]]),
      now: () => "2026-09-29T00:00:01.000Z",
      startupDeadline: () => { throw new Error("missing operation cannot schedule startup"); },
      onAdmitted: () => events.push("admitted"),
      onReady: () => { throw new Error("cold runtime cannot be ready"); },
      failMissingOperation: () => events.push("abort"),
      runEnsure: async () => { throw new Error("missing operation cannot start runtime"); },
    });
    expect(candidate).toMatchObject({
      status: "failed",
      error: { code: "operation_missing", message: "waiting allocation lost its startup operation" },
    });
    expect(events).toEqual(["admitted", "abort"]);
  });

  test("schedules startup only after admitted allocation and operation are transitioned", async () => {
    const candidate = allocation("allow-listed");
    const currentOperation = operation();
    const events: string[] = [];
    await commitWaitingAllocationPromotion({
      allocation: candidate,
      runtimeStatuses: new Map([[runtimeId, "COLD"]]),
      operation: currentOperation,
      now: () => "2026-09-29T00:00:01.000Z",
      startupDeadline: () => Date.parse("2026-09-29T00:01:00.000Z"),
      onAdmitted: () => events.push("admitted"),
      onReady: () => { throw new Error("cold runtime cannot be ready"); },
      failMissingOperation: () => { throw new Error("operation exists"); },
      runEnsure: async (_allocation, scheduledOperation, deadline) => {
        expect(candidate.status).toBe("pending");
        expect(scheduledOperation.phase).toBe("scheduled");
        expect(scheduledOperation.deadlineAt).toBe("2026-09-29T00:01:00.000Z");
        expect(deadline).toBe(Date.parse("2026-09-29T00:01:00.000Z"));
        events.push("ensure");
      },
    });
    expect(events).toEqual(["admitted", "ensure"]);
  });

  test("refresh failure schedules another attempt without inspecting or mutating waiters", async () => {
    const events: string[] = [];
    await promoteWaitingAllocationBatch({
      queue: {
        draining: false,
        hasFreshState: () => false,
        tick: async () => { events.push("tick"); throw new Error("observer unavailable"); },
        allocations: () => { throw new Error("must not inspect stale waiters"); },
        now: () => 1_000,
        pollIntervalMs: 500,
        scheduleRetry: (delay) => events.push(`retry:${delay ?? "default"}`),
        pruneHistory: () => events.push("prune"),
      },
      admission: {
        registry,
        providerSwitchHoldUntil: () => undefined,
        isRuntimeBusy: () => false,
        hasHigherPriorityConflict: () => false,
        evaluateAdmission: () => ({ ok: true }),
        hasAdmittedResourceConflict: () => false,
      },
      lifecycle: {
        runtimeStatuses: () => new Map(),
        getOperation: () => undefined,
        isoNow: () => "2026-09-29T00:00:00.000Z",
        startupDeadline: () => 10_000,
        onAdmitted: () => {},
        onReady: () => {},
        failMissingOperation: () => {},
        runEnsure: async () => {},
      },
    });
    expect(events).toEqual(["tick", "retry:default"]);
  });

  test("processes waiters by priority and schedules the earliest policy retry", async () => {
    const low = allocation();
    low.id = "low";
    low.priority = 0;
    const high = allocation();
    high.id = "high";
    high.priority = 2;
    const events: string[] = [];
    const visitedPriorities: number[] = [];
    await promoteWaitingAllocationBatch({
      queue: {
        draining: false,
        hasFreshState: () => true,
        tick: async () => { throw new Error("fresh state does not require a tick"); },
        allocations: () => [low, high],
        now: () => 1_000,
        pollIntervalMs: 500,
        scheduleRetry: (delay) => events.push(`retry:${delay}`),
        pruneHistory: () => events.push("prune"),
      },
      admission: {
        registry,
        providerSwitchHoldUntil: (_runtimeIds, priority) => {
          visitedPriorities.push(priority);
          return 1_000 + (priority === 2 ? 7_500 : 1_500);
        },
        isRuntimeBusy: () => false,
        hasHigherPriorityConflict: () => false,
        evaluateAdmission: () => { throw new Error("provider hold short-circuits admission"); },
        hasAdmittedResourceConflict: () => false,
      },
      lifecycle: {
        runtimeStatuses: () => new Map(),
        getOperation: () => undefined,
        isoNow: () => "2026-09-29T00:00:00.000Z",
        startupDeadline: () => 10_000,
        onAdmitted: () => {},
        onReady: () => {},
        failMissingOperation: () => {},
        runEnsure: async () => {},
      },
    });
    expect(events).toEqual(["prune", "retry:1500"]);
    expect(visitedPriorities).toEqual([2, 0]);
    expect(high.status).toBe("waiting");
    expect(low.status).toBe("waiting");
  });
});
