import { getRuntime, type Allocation, type Registry } from "@larm/core";
import type { Operation } from "./controller";

export type WaitingPromotionDecision =
  | { kind: "admit" }
  | { kind: "wait"; retryDelayMs?: number };

export type WaitingPromotionQueuePort = {
  draining: boolean;
  hasFreshState: () => boolean;
  tick: () => Promise<unknown>;
  allocations: () => Iterable<Allocation>;
  now: () => number;
  pollIntervalMs: number;
  scheduleRetry: (delayMs?: number) => void;
  pruneHistory: () => void;
};

export type WaitingPromotionAdmissionPort = {
  registry: Registry;
  providerSwitchHoldUntil: (runtimeIds: string[], priority: number) => number | undefined;
  isRuntimeBusy: (runtimeId: string) => boolean;
  hasHigherPriorityConflict: (allocation: Allocation, runtimeIds: string[]) => boolean;
  evaluateAdmission: (allocation: Allocation) => { ok: boolean };
  hasAdmittedResourceConflict: (runtimeIds: string[]) => boolean;
};

export type WaitingPromotionLifecyclePort = {
  runtimeStatuses: () => ReadonlyMap<string, Allocation["bindings"][number]["status"]>;
  getOperation: (allocation: Allocation) => Operation | undefined;
  isoNow: () => string;
  startupDeadline: (allocation: Allocation) => number;
  onAdmitted: (allocation: Allocation) => void;
  onReady: (allocation: Allocation) => void;
  failMissingOperation: (allocation: Allocation) => void;
  runEnsure: (allocation: Allocation, operation: Operation, deadline: number) => Promise<void>;
};

export async function promoteWaitingAllocationBatch(input: {
  queue: WaitingPromotionQueuePort;
  admission: WaitingPromotionAdmissionPort;
  lifecycle: WaitingPromotionLifecyclePort;
}): Promise<void> {
  const { queue, admission, lifecycle } = input;
  if (queue.draining) return;
  if (!queue.hasFreshState()) {
    try {
      await queue.tick();
    } catch {
      queue.scheduleRetry();
      return;
    }
    if (!queue.hasFreshState()) {
      queue.scheduleRetry();
      return;
    }
  }
  let retryDelayMs: number | undefined;
  const requestRetry = (delayMs = queue.pollIntervalMs) => {
    retryDelayMs = Math.min(retryDelayMs ?? Number.POSITIVE_INFINITY, delayMs);
  };
  for (const allocation of prioritizeWaitingAllocations(queue.allocations())) {
    if (allocation.status !== "waiting" || Date.parse(allocation.expiresAt) <= queue.now()) continue;
    const runtimeIds = [...new Set(allocation.bindings.map((binding) => binding.runtime))];
    const promotionDecision = evaluateWaitingPromotion({
      registry: admission.registry,
      runtimeIds,
      providerSwitchHoldUntil: admission.providerSwitchHoldUntil(runtimeIds, allocation.priority ?? 0),
      now: queue.now,
      pollIntervalMs: queue.pollIntervalMs,
      isRuntimeBusy: admission.isRuntimeBusy,
      hasHigherPriorityConflict: () => admission.hasHigherPriorityConflict(allocation, runtimeIds),
      evaluateAdmission: () => admission.evaluateAdmission(allocation),
      hasAdmittedResourceConflict: () => admission.hasAdmittedResourceConflict(runtimeIds),
    });
    if (promotionDecision.kind === "wait") {
      if (promotionDecision.retryDelayMs !== undefined) requestRetry(promotionDecision.retryDelayMs);
      continue;
    }
    await commitWaitingAllocationPromotion({
      allocation,
      runtimeStatuses: lifecycle.runtimeStatuses(),
      operation: lifecycle.getOperation(allocation),
      now: lifecycle.isoNow,
      startupDeadline: () => lifecycle.startupDeadline(allocation),
      onAdmitted: lifecycle.onAdmitted,
      onReady: lifecycle.onReady,
      failMissingOperation: lifecycle.failMissingOperation,
      runEnsure: lifecycle.runEnsure,
    });
  }
  queue.pruneHistory();
  if (retryDelayMs !== undefined) queue.scheduleRetry(retryDelayMs);
}

export function prioritizeWaitingAllocations(allocations: Iterable<Allocation>): Allocation[] {
  return [...allocations]
    .filter((allocation) => allocation.status === "waiting")
    .sort((left, right) => {
      const byPriority = (right.priority ?? 0) - (left.priority ?? 0);
      if (byPriority !== 0) return byPriority;
      const byCreated = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
    });
}

export function evaluateWaitingPromotion(input: {
  registry: Registry;
  runtimeIds: readonly string[];
  providerSwitchHoldUntil?: number;
  now: () => number;
  pollIntervalMs: number;
  isRuntimeBusy: (runtimeId: string) => boolean;
  hasHigherPriorityConflict: () => boolean;
  evaluateAdmission: () => { ok: boolean };
  hasAdmittedResourceConflict: () => boolean;
}): WaitingPromotionDecision {
  if (input.providerSwitchHoldUntil !== undefined) {
    return {
      kind: "wait",
      retryDelayMs: Math.max(1, input.providerSwitchHoldUntil - input.now()),
    };
  }

  const lifecycleRuntimeIds = new Set(input.runtimeIds);
  for (const runtimeId of input.runtimeIds) {
    const swapGroup = getRuntime(input.registry, runtimeId)?.policy.swapGroup;
    if (!swapGroup) continue;
    for (const peer of input.registry.runtimes) {
      if (peer.policy.swapGroup === swapGroup) lifecycleRuntimeIds.add(peer.id);
    }
  }
  if ([...lifecycleRuntimeIds].some(input.isRuntimeBusy)) {
    return { kind: "wait", retryDelayMs: input.pollIntervalMs };
  }
  if (input.hasHigherPriorityConflict()) {
    return { kind: "wait", retryDelayMs: input.pollIntervalMs };
  }

  const admission = input.evaluateAdmission();
  if (!admission.ok) {
    return input.hasAdmittedResourceConflict()
      ? { kind: "wait" }
      : { kind: "wait", retryDelayMs: input.pollIntervalMs };
  }
  return { kind: "admit" };
}

export async function commitWaitingAllocationPromotion(input: {
  allocation: Allocation;
  runtimeStatuses: ReadonlyMap<string, Allocation["bindings"][number]["status"]>;
  operation?: Operation;
  now: () => string;
  startupDeadline: () => number;
  onAdmitted: (allocation: Allocation) => void;
  onReady: (allocation: Allocation) => void;
  failMissingOperation: (allocation: Allocation) => void;
  runEnsure: (allocation: Allocation, operation: Operation, deadline: number) => Promise<void>;
}): Promise<void> {
  for (const binding of input.allocation.bindings) {
    const status = input.runtimeStatuses.get(binding.runtime);
    if (status) binding.status = status;
  }
  const ready = input.allocation.deploymentPolicy === "existing-only"
    && input.allocation.bindings.every((binding) => binding.status === "HOT" || binding.status === "BUSY");
  input.allocation.status = ready ? "ready" : "pending";
  input.onAdmitted(input.allocation);
  if (ready) {
    if (input.operation) {
      input.operation.status = "succeeded";
      input.operation.ready = true;
      input.operation.phase = "runtime-ready";
      input.operation.completedAt = input.now();
    }
    input.onReady(input.allocation);
    return;
  }
  if (!input.operation) {
    input.allocation.status = "failed";
    input.allocation.error = {
      code: "operation_missing",
      message: "waiting allocation lost its startup operation",
    };
    input.failMissingOperation(input.allocation);
    return;
  }
  const deadline = input.startupDeadline();
  input.operation.deadlineAt = new Date(deadline).toISOString();
  input.operation.phase = "scheduled";
  await input.runEnsure(input.allocation, input.operation, deadline);
}
