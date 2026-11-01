import { admitLiveMemory } from "./live-memory";
import type { ServiceMemoryReservation } from "./local-service";
import { admittedAllocation, type Allocation } from "./allocation";
import type { Registry } from "./registry";
import type { ClusterState, RuntimeDefinition } from "./schema";

export type NodeAdmission = {
  node: string;
  usableMemoryGB: number;
  committedMemoryGB: number;
  incrementalMemoryGB: number;
  availableMemoryGB: number;
  liveAvailableMemoryGB?: number;
  effectiveLiveAvailableMemoryGB?: number;
  reclaimableMemoryGB?: number;
};

export type AdmissionResult =
  | { ok: true; nodes: NodeAdmission[] }
  | {
      ok: false;
      reason:
        | "unknown_runtime"
        | "unknown_node"
        | "swap_group_conflict"
        | "memory_exhausted"
        | "runtime_capacity"
        | "telemetry_unavailable"
        | "live_memory_exhausted";
      message: string;
      runtime?: string;
      node?: string;
      nodes: NodeAdmission[];
    };

function uniqueActiveRuntimeIds(allocations: Allocation[]): Set<string> {
  const ids = new Set<string>();
  for (const allocation of allocations) {
    if (!admittedAllocation(allocation.status)) {
      continue;
    }
    for (const binding of allocation.bindings) {
      ids.add(binding.runtime);
    }
  }
  return ids;
}

function runtimeById(registry: Registry, id: string): RuntimeDefinition | undefined {
  return registry.runtimes.find((runtime) => runtime.id === id);
}

export function admitRuntimes(input: {
  registry: Registry;
  state: ClusterState;
  allocations: Allocation[];
  candidateRuntimeIds: string[];
  serviceReservations?: readonly ServiceMemoryReservation[];
  liveTelemetry?: {
    requiredForNonResident: boolean;
    maxAgeMs: number;
    now?: number;
  };
}): AdmissionResult {
  const activeIds = uniqueActiveRuntimeIds(input.allocations);

  const candidateIds = new Set(input.candidateRuntimeIds);
  const candidateBySwapGroup = new Map<string, string>();
  for (const id of candidateIds) {
    const runtime = runtimeById(input.registry, id);
    const swapGroup = runtime?.policy.swapGroup;
    if (!swapGroup) continue;
    const existing = candidateBySwapGroup.get(swapGroup);
    if (existing && existing !== id) {
      return {
        ok: false,
        reason: "swap_group_conflict",
        message: `runtimes ${existing} and ${id} cannot share allocation because swap group ${swapGroup} runs one member at a time`,
        runtime: id,
        node: runtime.node,
        nodes: [],
      };
    }
    candidateBySwapGroup.set(swapGroup, id);
  }

  for (const runtimeId of candidateIds) {
    const runtime = runtimeById(input.registry, runtimeId);
    const conflicting = runtime?.policy.swapGroup && [...activeIds].find(id => id !== runtimeId
      && runtimeById(input.registry, id)?.policy.swapGroup === runtime.policy.swapGroup);
    if (conflicting) return { ok: false, reason: "swap_group_conflict", runtime: runtimeId,
      node: runtime!.node, nodes: [], message: `runtime ${conflicting} holds the requested swap group` };
    if (!runtime?.resources.maxConcurrentAllocations) {
      continue;
    }
    const activeCount = input.allocations.filter(
      (allocation) =>
        admittedAllocation(allocation.status) &&
        allocation.bindings.some((binding) => binding.runtime === runtimeId),
    ).length;
    if (activeCount >= runtime.resources.maxConcurrentAllocations) {
      return {
        ok: false,
        reason: "runtime_capacity",
        message: `runtime ${runtimeId} reached allocation capacity ${runtime.resources.maxConcurrentAllocations}`,
        runtime: runtimeId,
        nodes: [],
      };
    }
  }

  const nodes: NodeAdmission[] = [];
  for (const id of candidateIds) {
    const runtime = runtimeById(input.registry, id);
    if (!runtime) return { ok: false, reason: "unknown_runtime", runtime: id,
      message: `runtime ${id} is not in the registry`, nodes };
    const node = input.registry.nodes.find(n => n.id === runtime.node);
    if (!node) return { ok: false, reason: "unknown_node", node: runtime.node,
      message: `node ${runtime.node} is not in the registry`, nodes };
    const running = input.state.runtimes.some(s => s.id === id && (s.status === "HOT" || s.status === "BUSY"));
    // Existing connections and cache limits do not reserve physical memory.
    // The common startup gate rechecks telemetry immediately before a cold load.
    if (running || runtime.policy.class === "resident" || !input.liveTelemetry?.requiredForNonResident) continue;
    if (nodes.some(n => n.node === node.id)) continue;
    const result = admitLiveMemory({ state: input.state, node: node.id,
      now: input.liveTelemetry.now ?? Date.now(), maxAgeMs: input.liveTelemetry.maxAgeMs,
      safetyFloorBytes: node.resources.reservedMemoryGB * 1024 ** 3, accelerator: true });
    if (!result.ok) return result;
    nodes.push(...result.nodes);
  }
  return { ok: true, nodes };
}
