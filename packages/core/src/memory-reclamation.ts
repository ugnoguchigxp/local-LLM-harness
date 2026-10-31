import { admittedAllocation, type Allocation } from "./allocation";
import { managedWarmPolicy } from "./provider-lifecycle";
import { runtimeMemoryGB } from "./prompt-retention";
import type { Registry } from "./registry";
import type { ClusterState } from "./schema";
import type { NodeAdmission } from "./admission";

export type MemoryPressure = { ok: boolean; reason?: string; node?: string; nodes?: readonly NodeAdmission[] };

export function isMemoryPressure(admission: MemoryPressure): boolean {
  return !admission.ok && (admission.reason === "memory_exhausted" || admission.reason === "live_memory_exhausted");
}

/** Choose one victim at a time; the caller must observe actual headroom after stopping it. */
export function memoryReclamationCandidates(input: {
  registry: Registry;
  state: ClusterState;
  allocations: readonly Allocation[];
  admission: MemoryPressure;
  requestedRuntimeIds: readonly string[];
  protectedRuntimeIds: ReadonlySet<string>;
  priority: number;
  foregroundPriorityThreshold: number;
}): { runtime: string; allocations: string[] }[] {
  if (!isMemoryPressure(input.admission) || !input.admission.node) return [];
  const requested = new Set(input.requestedRuntimeIds);
  const candidates = input.registry.runtimes.flatMap(runtime => {
    if (runtime.node !== input.admission.node || requested.has(runtime.id)
      || input.protectedRuntimeIds.has(runtime.id) || runtime.policy.class === "resident"
      || managedWarmPolicy(runtime).minInstances > 0) return [];
    const status = input.state.runtimes.find(s => s.id === runtime.id)?.status;
    const allocations = input.allocations.filter(a => admittedAllocation(a.status)
      && a.bindings.some(b => b.runtime === runtime.id));
    if (allocations.length === 0) {
      return status === "HOT" ? [{ runtime, allocations, priority: -Infinity }] : [];
    }
    if ((status !== "HOT" && status !== "BUSY") || input.priority < input.foregroundPriorityThreshold
      || allocations.some(a => (a.priority ?? 0) >= input.priority
        || a.bindings.some(b => requested.has(b.runtime)))) return [];
    return [{ runtime, allocations, priority: Math.max(...allocations.map(a => a.priority ?? 0)) }];
  });
  const node = input.admission.nodes?.find(node => node.node === input.admission.node);
  // Do not retire work if even reclaiming every eligible runtime cannot fit the request.
  if (node && node.incrementalMemoryGB > node.availableMemoryGB
    + candidates.reduce((total, candidate) => total + runtimeMemoryGB(candidate.runtime), 0)) return [];
  return candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority < b.priority ? -1 : 1;
    return runtimeMemoryGB(b.runtime) - runtimeMemoryGB(a.runtime) || a.runtime.id.localeCompare(b.runtime.id);
  }).map(candidate => ({ runtime: candidate.runtime.id, allocations: candidate.allocations.map(a => a.id) }));
}
