import {
  activeAllocation,
  getRuntime,
  type Allocation,
  type Lease,
  type Registry,
} from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import type { Observer } from "./observer";
import type { ProviderInstanceManager } from "./provider-instance-manager";

export async function reconcileOrphanedPreferredRuntimes(input: {
  draining: boolean;
  expireDueAllocations: () => void;
  observer: Observer;
  registry: Registry;
  allocations: Map<string, Allocation>;
  leases: Map<string, Lease>;
  providerInstances: Pick<ProviderInstanceManager, "hasRuntime">;
  backend: Pick<RuntimeBackend, "stop">;
  lifecycleReservations: Set<string>;
  isRuntimeMutating?: (runtimeId: string) => boolean;
  emit: (name: string, labels?: Record<string, string>) => void;
}): Promise<string[]> {
  if (input.draining) return [];
  input.expireDueAllocations();
  const state = await input.observer.tick();
  const allocated = new Set(
    [...input.allocations.values()]
      .filter((allocation) => activeAllocation(allocation.status))
      .flatMap((allocation) => allocation.bindings.map((binding) => binding.runtime)),
  );
  const legacyCapabilities = new Set(
    [...input.leases.values()].flatMap((lease) => lease.capabilities),
  );
  const stopped: string[] = [];
  for (const snapshot of state.runtimes) {
    const runtime = getRuntime(input.registry, snapshot.id);
    if (
      !runtime
      || runtime.policy.class !== "preferred"
      || snapshot.status !== "HOT"
      || allocated.has(runtime.id)
      || input.providerInstances.hasRuntime(runtime.id)
      || runtime.capability.some((capability) => legacyCapabilities.has(capability))
      || input.isRuntimeMutating?.(runtime.id)
    ) {
      continue;
    }
    input.lifecycleReservations.add(runtime.id);
    try {
      const inUse = [...input.allocations.values()].some(
        (allocation) => activeAllocation(allocation.status)
          && allocation.bindings.some((binding) => binding.runtime === runtime.id),
      );
      if (inUse || input.isRuntimeMutating?.(runtime.id)) continue;
      await input.backend.stop(runtime.id);
      stopped.push(runtime.id);
      input.emit("startup_reconciliation", { runtime: runtime.id, result: "stopped_orphan" });
    } finally {
      input.lifecycleReservations.delete(runtime.id);
    }
  }
  if (stopped.length > 0) await input.observer.tick();
  return stopped;
}
