import type { Allocation } from "./allocation";
import type { Registry } from "./registry";
import type { ClusterState, RuntimeDefinition } from "./schema";

const MEMORY_COMMITTED = new Set(["HOT", "BUSY", "STARTING", "STOPPING"]);

export type NodeAdmission = {
  node: string;
  usableMemoryGB: number;
  committedMemoryGB: number;
  incrementalMemoryGB: number;
  availableMemoryGB: number;
  liveAvailableMemoryGB?: number;
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
    if (allocation.status !== "pending" && allocation.status !== "ready") {
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
  liveTelemetry?: {
    requiredForNonResident: boolean;
    maxAgeMs: number;
    now?: number;
  };
}): AdmissionResult {
  const activeIds = uniqueActiveRuntimeIds(input.allocations);
  const committedIds = new Set(activeIds);
  for (const runtime of input.registry.runtimes) {
    if (runtime.policy.class === "resident") {
      committedIds.add(runtime.id);
    }
  }

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

  const replaceableIds = new Set<string>();
  for (const snapshot of input.state.runtimes) {
    if (MEMORY_COMMITTED.has(snapshot.status)) {
      const runtime = runtimeById(input.registry, snapshot.id);
      const selectedForGroup = runtime?.policy.swapGroup
        ? candidateBySwapGroup.get(runtime.policy.swapGroup)
        : undefined;
      if (
        runtime
        && snapshot.status === "HOT"
        && selectedForGroup !== undefined
        && selectedForGroup !== runtime.id
        && !activeIds.has(runtime.id)
      ) {
        replaceableIds.add(runtime.id);
        continue;
      }
      committedIds.add(snapshot.id);
    }
  }

  const nodeIds = new Set<string>();
  for (const id of [...committedIds, ...candidateIds]) {
    const runtime = runtimeById(input.registry, id);
    if (!runtime) {
      return {
        ok: false,
        reason: "unknown_runtime",
        message: `runtime ${id} is not in the registry`,
        runtime: id,
        nodes: [],
      };
    }
    nodeIds.add(runtime.node);
  }

  const nodes: NodeAdmission[] = [];
  for (const nodeId of [...nodeIds].sort()) {
    const node = input.registry.nodes.find((item) => item.id === nodeId);
    if (!node) {
      return {
        ok: false,
        reason: "unknown_node",
        message: `node ${nodeId} is not in the registry`,
        node: nodeId,
        nodes,
      };
    }
    const committedMemoryGB = [...committedIds]
      .map((id) => runtimeById(input.registry, id))
      .filter((runtime): runtime is RuntimeDefinition => runtime?.node === nodeId)
      .reduce((total, runtime) => total + runtime.resources.estimatedMemoryGB, 0);
    const incrementalMemoryGB = [...candidateIds]
      .filter((id) => !committedIds.has(id))
      .map((id) => runtimeById(input.registry, id))
      .filter((runtime): runtime is RuntimeDefinition => runtime?.node === nodeId)
      .reduce((total, runtime) => total + runtime.resources.estimatedMemoryGB, 0);
    const usableMemoryGB = node.resources.memoryTotalGB - node.resources.reservedMemoryGB;
    const availableMemoryGB = usableMemoryGB - committedMemoryGB;
    const reclaimableMemoryGB = [...replaceableIds]
      .map((id) => runtimeById(input.registry, id))
      .filter((runtime): runtime is RuntimeDefinition => runtime?.node === nodeId)
      .reduce((total, runtime) => total + runtime.resources.estimatedMemoryGB, 0);
    const summary: NodeAdmission = {
      node: nodeId,
      usableMemoryGB,
      committedMemoryGB,
      incrementalMemoryGB,
      availableMemoryGB,
      ...(reclaimableMemoryGB > 0 ? { reclaimableMemoryGB } : {}),
    };
    nodes.push(summary);
    if (incrementalMemoryGB > availableMemoryGB) {
      return {
        ok: false,
        reason: "memory_exhausted",
        message: `node ${nodeId} needs ${incrementalMemoryGB} GB but only ${availableMemoryGB} GB is available`,
        node: nodeId,
        nodes,
      };
    }
    const needsLiveTelemetry = input.liveTelemetry?.requiredForNonResident === true
      && [...candidateIds].some((id) => {
        const runtime = runtimeById(input.registry, id);
        return runtime?.node === nodeId
          && runtime.policy.class !== "resident"
          && !committedIds.has(id);
      });
    if (needsLiveTelemetry) {
      const telemetry = input.state.node.id === nodeId ? input.state.node.telemetry : undefined;
      const observedAt = telemetry ? Date.parse(telemetry.observedAt) : Number.NaN;
      const now = input.liveTelemetry?.now ?? Date.now();
      if (
        !telemetry
        || telemetry.status !== "available"
        || telemetry.systemMemoryAvailableBytes === undefined
        || !Number.isFinite(observedAt)
        || observedAt > now
        || now - observedAt > input.liveTelemetry!.maxAgeMs
      ) {
        return {
          ok: false,
          reason: "telemetry_unavailable",
          message: `fresh resource telemetry is unavailable for node ${nodeId}`,
          node: nodeId,
          nodes,
        };
      }
      const liveBytes = telemetry.acceleratorMemoryAvailableBytes === undefined
        ? telemetry.systemMemoryAvailableBytes
        : Math.min(
          telemetry.systemMemoryAvailableBytes,
          telemetry.acceleratorMemoryAvailableBytes,
        );
      // The static gate above already preserves node.reservedMemoryGB. MemAvailable and
      // accelerator available values are live headroom, so subtracting the reserve again
      // would double-count it and incorrectly reject unified-memory hosts.
      const liveAvailableMemoryGB = Math.max(0, liveBytes / (1024 ** 3));
      const effectiveLiveAvailableMemoryGB = liveAvailableMemoryGB + reclaimableMemoryGB;
      summary.liveAvailableMemoryGB = liveAvailableMemoryGB;
      if (incrementalMemoryGB > effectiveLiveAvailableMemoryGB) {
        return {
          ok: false,
          reason: "live_memory_exhausted",
          message: `node ${nodeId} needs ${incrementalMemoryGB} GB but live headroom plus reclaimable swap memory is ${effectiveLiveAvailableMemoryGB.toFixed(2)} GB`,
          node: nodeId,
          nodes,
        };
      }
    }
  }

  for (const runtimeId of candidateIds) {
    const runtime = runtimeById(input.registry, runtimeId);
    if (!runtime?.resources.maxConcurrentAllocations) {
      continue;
    }
    const activeCount = input.allocations.filter(
      (allocation) =>
        (allocation.status === "pending" || allocation.status === "ready") &&
        allocation.bindings.some((binding) => binding.runtime === runtimeId),
    ).length;
    if (activeCount >= runtime.resources.maxConcurrentAllocations) {
      return {
        ok: false,
        reason: "runtime_capacity",
        message: `runtime ${runtimeId} reached allocation capacity ${runtime.resources.maxConcurrentAllocations}`,
        runtime: runtimeId,
        nodes,
      };
    }
  }

  return { ok: true, nodes };
}
