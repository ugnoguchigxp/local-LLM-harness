import {
  admittedAllocation,
  getRuntime,
  type Allocation,
  type AllocationRequest,
  type AllocationBinding,
  type ClusterState,
  type Registry,
  type RuntimeReleaseDefinition,
} from "@larm/core";
import {
  planAllocationCapacity,
  type AllocationCapacityPlan,
} from "./allocation-admission-planner";
import {
  resolveAllocationBindings,
  type AllocationBindingResolution,
} from "./allocation-binding-resolver";

type BindingFailure = Extract<AllocationBindingResolution, { ok: false }>;
type CapacityFailure = Extract<AllocationCapacityPlan, { ok: false }>;
type AdmissionFailure = BindingFailure | CapacityFailure | {
  ok: false;
  result: {
    status: 409;
    body: { error: { code: "runtime_transition_in_progress" | "deployment_in_progress"; message: string } };
  };
};

export type AllocationRequestAdmission =
  | AdmissionFailure
  | {
    ok: true;
    bindings: AllocationBinding[];
    capabilities: string[];
    runtimeIds: string[];
    waiting: boolean;
  };

export function planAllocationRequestAdmission(input: {
  registry: Registry;
  request: AllocationRequest;
  getState: () => ClusterState;
  getAllocations: () => Allocation[];
  isLifecycleReserved: (runtimeId: string) => boolean;
  isRuntimeMutating?: (runtimeId: string) => boolean | undefined;
  hasResourceConflict: (
    runtimeIds: string[],
    predicate: (allocation: Allocation) => boolean,
  ) => boolean;
  providerSwitchHoldUntil: (runtimeIds: string[], priority: number) => number | undefined;
  preemptLowerPriorityConflicts: (priority: number, runtimeIds: string[]) => void;
  getRuntimeRelease?: (runtimeId: string) => string | undefined;
  getRuntimeReleaseDefinition?: (runtimeId: string) => RuntimeReleaseDefinition | undefined;
  requireFreshTelemetry: boolean;
  telemetryMaxAgeMs: number;
  now: () => number;
  onRejected: (reason: string, route?: string) => void;
}): AllocationRequestAdmission {
  const bindingResolution = resolveAllocationBindings({
    registry: input.registry,
    state: input.getState(),
    request: input.request,
    getRuntimeRelease: input.getRuntimeRelease,
    getRuntimeReleaseDefinition: input.getRuntimeReleaseDefinition,
    onRejected: input.onRejected,
  });
  if (!bindingResolution.ok) return bindingResolution;

  const runtimeIds = [...new Set(bindingResolution.bindings.map((binding) => binding.runtime))];
  const lifecycleRuntimeIds = new Set(runtimeIds);
  for (const runtimeId of runtimeIds) {
    const swapGroup = getRuntime(input.registry, runtimeId)?.policy.swapGroup;
    if (!swapGroup) continue;
    for (const peer of input.registry.runtimes) {
      if (peer.policy.swapGroup === swapGroup) lifecycleRuntimeIds.add(peer.id);
    }
  }
  const transitioningRuntime = [...lifecycleRuntimeIds].find(input.isLifecycleReserved);
  const priority = input.request.priority ?? 0;
  const waitsForCapacity = input.request.capacityPolicy === "wait";
  const providerSwitchHoldUntil = input.providerSwitchHoldUntil(runtimeIds, priority);
  const conflictsWithAdmitted = input.hasResourceConflict(
    runtimeIds,
    (allocation) => admittedAllocation(allocation.status),
  );
  if (transitioningRuntime && !(waitsForCapacity && conflictsWithAdmitted)) {
    input.onRejected("runtime_transition_in_progress");
    return {
      ok: false,
      result: {
        status: 409,
        body: {
          error: {
            code: "runtime_transition_in_progress",
            message: `runtime ${transitioningRuntime} is changing lifecycle state`,
          },
        },
      },
    };
  }
  const mutatingRuntime = [...lifecycleRuntimeIds].find((runtimeId) =>
    input.isRuntimeMutating?.(runtimeId)
  );
  if (mutatingRuntime) {
    input.onRejected("deployment_in_progress");
    return {
      ok: false,
      result: {
        status: 409,
        body: {
          error: {
            code: "deployment_in_progress",
            message: `runtime ${mutatingRuntime} is being updated`,
          },
        },
      },
    };
  }

  input.preemptLowerPriorityConflicts(priority, runtimeIds);
  const capacityPlan = planAllocationCapacity({
    registry: input.registry,
    state: input.getState(),
    allocations: input.getAllocations(),
    runtimeIds,
    priority,
    capacityPolicy: waitsForCapacity ? "wait" : "reject",
    conflictsWithAdmitted,
    transitioningRuntime,
    providerSwitchHoldUntil,
    requireFreshTelemetry: input.requireFreshTelemetry,
    telemetryMaxAgeMs: input.telemetryMaxAgeMs,
    ...(input.requireFreshTelemetry ? { now: input.now() } : {}),
  });
  if (!capacityPlan.ok) {
    input.onRejected(capacityPlan.reason);
    return capacityPlan;
  }
  return {
    ok: true,
    bindings: bindingResolution.bindings,
    capabilities: bindingResolution.capabilities,
    runtimeIds,
    waiting: capacityPlan.waiting,
  };
}
