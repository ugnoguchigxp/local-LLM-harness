import {
  activeAllocation,
  type Allocation,
  type ClusterState,
} from "@larm/core";
import type { Operation } from "./controller";
import { AllocationLifecycleError } from "./allocation-lifecycle";
import {
  commitAllocationOperationTerminal,
  commitAllocationTerminal,
} from "./allocation-lifecycle-commit";
import type { ProviderInstanceManager } from "./provider-instance-manager";

export type AllocationApiLifecycleOptions = {
  allocations: Map<string, Allocation>;
  operations: Map<string, Operation>;
  allocationAborts: Map<string, AbortController>;
  allocationLifecycleAborts: Map<string, AbortController>;
  isDraining: () => boolean;
  expireDueAllocations: () => void;
  allocationLookupError: (id: string) => {
    status: 404 | 409;
    body: { error: { code: string; message: string } };
  };
  now: () => number;
  isoNow: () => string;
  hasFreshState: () => boolean;
  getState: () => ClusterState;
  scheduleAllocationExpiry: (allocation: Allocation) => void;
  clearAllocationTimer: (id: string) => void;
  detachLegacyAllocation: (id: string) => void;
  providerInstances: Pick<ProviderInstanceManager, "releaseAllocation">;
  foregroundPriorityThreshold: () => number;
  holdForegroundProviders: (allocation: Allocation) => void;
  allocationLabels: (allocation: Allocation) => Record<string, string>;
  emit: (name: string, labels?: Record<string, string>) => void;
  enqueueWaitingPromotion: () => void;
  scheduleIdleReconcile: () => void;
  pruneHistory: () => void;
};

export class AllocationApiLifecycle {
  constructor(private readonly options: AllocationApiLifecycleOptions) {}

  renewAllocation(id: string, ttlSeconds: number) {
    const d = this.options;
    if (d.isDraining()) return draining();
    d.expireDueAllocations();
    const allocation = d.allocations.get(id);
    if (!allocation) return d.allocationLookupError(id);
    if (!activeAllocation(allocation.status)) {
      return {
        status: 409 as const,
        body: {
          error: {
            code: "allocation_inactive",
            message: `allocation ${id} is ${allocation.status}`,
          },
        },
      };
    }
    allocation.expiresAt = new Date(d.now() + ttlSeconds * 1000).toISOString();
    d.scheduleAllocationExpiry(allocation);
    return { status: 200 as const, body: allocation };
  }

  resolveAllocation(id: string, capability: string) {
    const d = this.options;
    if (d.isDraining()) return draining();
    d.expireDueAllocations();
    const allocation = d.allocations.get(id);
    if (!allocation) return d.allocationLookupError(id);
    if (allocation.status !== "ready") {
      return {
        status: activeAllocation(allocation.status) ? 503 as const : 409 as const,
        body: {
          error: allocation.error ?? {
            code: "allocation_not_ready",
            message: `allocation ${id} is ${allocation.status}`,
          },
        },
      };
    }
    const binding = allocation.bindings.find((item) => item.capability === capability);
    if (!binding) {
      return {
        status: 404 as const,
        body: {
          error: {
            code: "capability_not_allocated",
            message: `allocation ${id} does not bind ${capability}`,
          },
        },
      };
    }
    const state = d.getState();
    if (!d.hasFreshState()) {
      return {
        status: 503 as const,
        body: {
          error: {
            code: "stale_state",
            message: "runtime observation is stale; retry after the next observer tick",
          },
        },
      };
    }
    const snapshot = state.runtimes.find((runtime) => runtime.id === binding.runtime);
    if (!snapshot || (snapshot.status !== "HOT" && snapshot.status !== "BUSY")) {
      if (snapshot) binding.status = snapshot.status;
      return {
        status: 503 as const,
        body: {
          error: {
            code: "runtime_not_ready",
            message: `allocated runtime ${binding.runtime} is not ready`,
          },
        },
      };
    }
    binding.status = snapshot.status;
    return { status: 200 as const, body: binding };
  }

  async releaseAllocation(
    id: string,
    terminal: "released" | "expired" = "released",
    reason?: Error,
  ) {
    const d = this.options;
    const allocation = d.allocations.get(id);
    if (!allocation) return d.allocationLookupError(id);
    if (allocation.status === "released" || allocation.status === "expired") {
      return { status: 200 as const, body: allocation };
    }
    const { wasAdmitted } = commitAllocationTerminal({
      allocation,
      terminal,
      releasedAt: d.isoNow(),
      ...(reason instanceof AllocationLifecycleError
        ? { error: { code: reason.code, message: reason.message } }
        : {}),
    });
    d.clearAllocationTimer(id);
    const lifecycleReason = reason ?? new Error(`allocation ${terminal}`);
    d.allocationAborts.get(id)?.abort(lifecycleReason);
    d.allocationLifecycleAborts.get(id)?.abort(lifecycleReason);
    d.detachLegacyAllocation(id);
    d.providerInstances.releaseAllocation(id);
    if (wasAdmitted && (allocation.priority ?? 0) >= d.foregroundPriorityThreshold()) {
      d.holdForegroundProviders(allocation);
    }
    commitAllocationOperationTerminal({
      operation: allocation.operationId ? d.operations.get(allocation.operationId) : undefined,
      terminal,
      now: d.isoNow,
    });
    d.emit(`allocation_${terminal}`, d.allocationLabels(allocation));
    d.enqueueWaitingPromotion();
    d.scheduleIdleReconcile();
    d.pruneHistory();
    return { status: 200 as const, body: allocation };
  }

  async preemptAllocation(id: string, preemptingPriority: number) {
    const allocation = this.options.allocations.get(id);
    if (!allocation) return this.options.allocationLookupError(id);
    if (allocation.status === "released" || allocation.status === "expired") {
      return { status: 200 as const, body: allocation };
    }
    if ((allocation.priority ?? 0) >= preemptingPriority) {
      return {
        status: 409 as const,
        body: {
          error: {
            code: "allocation_priority_conflict",
            message: "allocation priority is not lower than the preempting request",
          },
        },
      };
    }
    this.options.emit("allocation_preempted", {
      allocation: allocation.id,
      client: allocation.client ?? "unknown",
      reason: "higher_priority_foreground_task",
      priority: String(allocation.priority ?? 0),
      preemptingPriority: String(preemptingPriority),
    });
    return await this.releaseAllocation(
      allocation.id,
      "released",
      new AllocationLifecycleError(
        "foreground_preempted",
        "request stopped because a higher-priority foreground task requires the provider",
      ),
    );
  }
}

function draining() {
  return {
    status: 503 as const,
    body: { error: { code: "draining", message: "control plane is draining" } },
  };
}
