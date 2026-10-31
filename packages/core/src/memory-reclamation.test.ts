import { expect, test } from "bun:test";
import { memoryReclamationCandidates } from "./memory-reclamation";
import type { Allocation } from "./allocation";
import type { Registry } from "./registry";
import type { ClusterState, RuntimeDefinition } from "./schema";

function runtime(id: string, memory: number, policy: RuntimeDefinition["policy"] = { class: "preferred" }): RuntimeDefinition {
  return { id, node: "node", policy, resources: { estimatedMemoryGB: memory } } as RuntimeDefinition;
}
const runtimes = [runtime("requested", 40), runtime("idle-small", 8), runtime("idle-large", 32),
  runtime("resident", 4, { class: "resident" }), runtime("warm-floor", 4, { class: "preferred", warm: { minInstances: 1, idleTtlSeconds: 60 } }),
  { ...runtime("remote", 64), node: "remote" }];
const registry = { runtimes } as Registry;
const state = { runtimes: runtimes.map(r => ({ id: r.id, status: "HOT" })) } as ClusterState;
function allocation(id: string, runtimeId: string, priority: number): Allocation {
  return { id, status: "ready", priority, bindings: [{ runtime: runtimeId }] } as Allocation;
}
const input = { registry, state, allocations: [] as Allocation[], admission: { ok: false, reason: "memory_exhausted", node: "node" },
  requestedRuntimeIds: ["requested"], protectedRuntimeIds: new Set<string>(), priority: 3000, foregroundPriorityThreshold: 3000 };

test("memory recovery prefers unused large runtimes on the pressured node and protects explicit warmth", () => {
  expect(memoryReclamationCandidates(input).map(v => v.runtime)).toEqual(["idle-large", "idle-small"]);
  expect(memoryReclamationCandidates({ ...input, protectedRuntimeIds: new Set(["idle-large"]) }).map(v => v.runtime)).toEqual(["idle-small"]);
});
test("non-memory errors and missing telemetry never justify stopping services", () => {
  for (const reason of ["telemetry_unavailable", "runtime_capacity", "swap_group_conflict"]) {
    expect(memoryReclamationCandidates({ ...input, admission: { ...input.admission, reason } })).toEqual([]);
  }
  expect(memoryReclamationCandidates({ ...input, admission: { ok: true } })).toEqual([]);
});
test("memory preemption respects priority across providers without requiring a swap-group conflict", () => {
  const allocations = [allocation("background", "idle-large", 1000)];
  expect(memoryReclamationCandidates({ ...input, allocations })).toEqual([
    { runtime: "idle-small", allocations: [] }, { runtime: "idle-large", allocations: ["background"] },
  ]);
  for (const priority of [0, 1000, 2999]) {
    expect(memoryReclamationCandidates({ ...input, allocations, priority }).map(v => v.runtime)).toEqual(["idle-small"]);
  }
  allocations.push(allocation("equal-priority", "idle-large", 3000));
  expect(memoryReclamationCandidates({ ...input, allocations }).map(v => v.runtime)).toEqual(["idle-small"]);
});
test("shared requested runtimes and unowned busy or transitioning processes are protected", () => {
  const shared = allocation("shared", "idle-large", 1000);
  shared.bindings.push({ runtime: "requested" } as Allocation["bindings"][number]);
  expect(memoryReclamationCandidates({ ...input, allocations: [shared] }).map(v => v.runtime)).toEqual(["idle-small"]);
  for (const status of ["BUSY", "STARTING", "STOPPING", "FAILED", "COLD"] as const) {
    const changed = { ...state, runtimes: state.runtimes.map(r => r.id.startsWith("idle-") ? { ...r, status } : r) };
    expect(memoryReclamationCandidates({ ...input, state: changed })).toEqual([]);
  }
});
