import type { ServiceMemoryReservation } from "@larm/core";
import {
  activeAllocation,
  admittedAllocation,
  admitRuntimes,
  getRuntime,
  type Allocation,
  type Registry,
} from "@larm/core";

export function countActiveAllocations(allocations: readonly Allocation[]): number {
  return allocations.filter((allocation) => activeAllocation(allocation.status)).length;
}

export function countActiveAdmission(
  allocations: readonly Allocation[],
  leaseIds: Iterable<string>,
  legacyAllocationByLease: ReadonlyMap<string, string>,
): number {
  let directLegacyLeases = 0;
  for (const leaseId of leaseIds) {
    if (!legacyAllocationByLease.has(leaseId)) directLegacyLeases += 1;
  }
  return countActiveAllocations(allocations) + directLegacyLeases;
}

export function admittedAllocations(allocations: readonly Allocation[]): Allocation[] {
  return allocations.filter((allocation) => admittedAllocation(allocation.status));
}

export function allocationResourceKeys(
  registry: Registry,
  runtimeIds: readonly string[],
  exclusive: boolean,
): Set<string> {
  const keys = new Set<string>();
  for (const runtimeId of runtimeIds) {
    const runtime = getRuntime(registry, runtimeId);
    if (!exclusive) keys.add(`runtime:${runtimeId}`);
    if (exclusive && runtime?.resources.maxConcurrentAllocations === 1) {
      keys.add(`runtime:${runtimeId}`);
    }
    if (runtime?.policy.swapGroup) keys.add(`swap:${runtime.policy.swapGroup}`);
  }
  return keys;
}

export function hasAllocationResourceConflict(
  registry: Registry,
  allocations: readonly Allocation[],
  runtimeIds: readonly string[],
  predicate: (allocation: Allocation) => boolean,
  exclusive: boolean,
): boolean {
  const requested = allocationResourceKeys(registry, runtimeIds, exclusive);
  return allocations.some((allocation) => {
    if (!predicate(allocation)) return false;
    const existing = allocationResourceKeys(
      registry,
      allocation.bindings.map((binding) => binding.runtime),
      exclusive,
    );
    return [...requested].some((key) => existing.has(key));
  });
}

export function evaluateAllocationAdmission(input: {
  registry: Registry;
  state: Parameters<typeof admitRuntimes>[0]["state"];
  allocations: readonly Allocation[];
  candidateRuntimeIds: readonly string[];
  serviceReservations?: readonly ServiceMemoryReservation[];
  requireFreshTelemetry: boolean;
  telemetryMaxAgeMs: number;
  now?: number;
}) {
  return admitRuntimes({
    serviceReservations: input.serviceReservations,
    registry: input.registry,
    state: input.state,
    allocations: [...input.allocations],
    candidateRuntimeIds: [...new Set(input.candidateRuntimeIds)],
    ...(input.requireFreshTelemetry
      ? {
        liveTelemetry: {
          requiredForNonResident: true,
          maxAgeMs: input.telemetryMaxAgeMs,
          now: input.now ?? Date.now(),
        },
      }
      : {}),
  });
}
