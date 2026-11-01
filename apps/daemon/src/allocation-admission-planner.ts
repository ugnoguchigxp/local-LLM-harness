import type { ServiceMemoryReservation } from "@larm/core";
import {
  admittedAllocation,
  memoryResourceError,
  type Allocation,
  type ClusterState,
  type Registry,
} from "@larm/core";
import {
  admittedAllocations,
  evaluateAllocationAdmission,
  hasAllocationResourceConflict,
} from "./allocation-admission";

export type AllocationCapacityPlan =
  | { ok: true; waiting: boolean }
  | {
    ok: false;
    reason: string;
    result: {
      status: 409 | 503;
      body: {
        error: {
          code: "resource_exhausted";
          message: string;
          admission?: ReturnType<typeof evaluateAllocationAdmission>["nodes"];
          type?: string;
          resource?: "memory";
          reason?: "memory_exhausted" | "live_memory_exhausted";
          retry?: "after_capacity_change";
        };
      };
    };
  };

export function planAllocationCapacity(input: {
  registry: Registry;
  state: ClusterState;
  allocations: readonly Allocation[];
  runtimeIds: string[];
  priority: number;
  capacityPolicy: "wait" | "reject";
  conflictsWithAdmitted: boolean;
  transitioningRuntime?: string;
  providerSwitchHoldUntil?: number;
  serviceReservations?: readonly ServiceMemoryReservation[];
  requireFreshTelemetry: boolean;
  telemetryMaxAgeMs: number;
  now?: number;
}): AllocationCapacityPlan {
  const conflictsWithWaiter = hasAllocationResourceConflict(
    input.registry,
    input.allocations,
    input.runtimeIds,
    (allocation) => allocation.status === "waiting" && (allocation.priority ?? 0) >= input.priority,
    true,
  );
  const conflictsWithHigherPriority = hasAllocationResourceConflict(
    input.registry,
    input.allocations,
    input.runtimeIds,
    (allocation) => admittedAllocation(allocation.status) && (allocation.priority ?? 0) > input.priority,
    true,
  );
  const admission = evaluateAllocationAdmission({
    registry: input.registry,
    state: input.state,
    allocations: admittedAllocations([...input.allocations]),
    candidateRuntimeIds: input.runtimeIds,
    serviceReservations: input.serviceReservations,
    requireFreshTelemetry: input.requireFreshTelemetry,
    telemetryMaxAgeMs: input.telemetryMaxAgeMs,
    ...(input.requireFreshTelemetry ? { now: input.now } : {}),
  });
  // Swap-group exclusion is independent of memory capacity. Multiple leases
  // of the same multi-session runtime must remain shareable.
  const exclusiveConflict = hasAllocationResourceConflict(input.registry, input.allocations,
    input.runtimeIds, a => admittedAllocation(a.status), true);
  const capacityBlocked = exclusiveConflict || (!admission.ok && input.conflictsWithAdmitted);
  const waiting = input.capacityPolicy === "wait" && (
    conflictsWithWaiter
    || conflictsWithHigherPriority
    || (input.transitioningRuntime !== undefined && input.conflictsWithAdmitted)
    || capacityBlocked
    || input.providerSwitchHoldUntil !== undefined
  );
  if ((!admission.ok || exclusiveConflict || input.providerSwitchHoldUntil !== undefined || conflictsWithHigherPriority) && !waiting) {
    const held = input.providerSwitchHoldUntil !== undefined;
    const reason = conflictsWithHigherPriority
      ? "higher_priority_allocation_active"
      : held
      ? "provider_switch_hold"
      : admission.ok
      ? "resource_exhausted"
      : admission.reason;
    const message = conflictsWithHigherPriority
      ? "a higher-priority allocation currently reserves the requested provider"
      : held
      ? "provider switch is held for foreground reuse"
      : admission.ok
      ? "runtime resources are unavailable"
      : admission.message;
    const memoryError = memoryResourceError(reason, message, admission.nodes);
    return {
      ok: false,
      reason,
      result: {
        status: memoryError ? 503 : 409,
        body: {
          error: memoryError ?? {
            code: "resource_exhausted",
            message,
            admission: admission.nodes,
          },
        },
      },
    };
  }
  return { ok: true, waiting };
}
