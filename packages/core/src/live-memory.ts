import type { AdmissionResult, NodeAdmission } from "./admission";
import type { ClusterState } from "./schema";

/** Physical headroom only. Limits, leases and historical estimates are not occupied RAM. */
export function admitLiveMemory(input: {
  state: ClusterState; node: string; now: number; maxAgeMs: number;
  safetyFloorBytes: number; accelerator?: boolean;
}): AdmissionResult {
  const t = input.state.node.id === input.node ? input.state.node.telemetry : undefined;
  const at = t ? Date.parse(t.observedAt) : NaN;
  if (!t || t.status !== "available" || t.systemMemoryAvailableBytes === undefined
    || !Number.isFinite(at) || at > input.now || input.now - at > input.maxAgeMs) {
    return { ok: false, reason: "telemetry_unavailable", node: input.node, nodes: [],
      message: `fresh resource telemetry is unavailable for node ${input.node}` };
  }
  const available = input.accelerator && t.acceleratorMemoryAvailableBytes !== undefined
    ? Math.min(t.systemMemoryAvailableBytes, t.acceleratorMemoryAvailableBytes) : t.systemMemoryAvailableBytes;
  const total = input.accelerator && t.acceleratorMemoryTotalBytes !== undefined
    ? Math.min(t.systemMemoryTotalBytes ?? t.acceleratorMemoryTotalBytes, t.acceleratorMemoryTotalBytes)
    : t.systemMemoryTotalBytes ?? input.state.node.resources.memoryTotalGB * 1024 ** 3;
  const headroom = Math.max(0, available - input.safetyFloorBytes) / 1024 ** 3;
  const summary: NodeAdmission = { node: input.node,
    usableMemoryGB: Math.max(0, total - input.safetyFloorBytes) / 1024 ** 3,
    committedMemoryGB: Math.max(0, total - available) / 1024 ** 3,
    incrementalMemoryGB: 0, availableMemoryGB: headroom,
    liveAvailableMemoryGB: available / 1024 ** 3, effectiveLiveAvailableMemoryGB: headroom };
  if (available <= input.safetyFloorBytes) return { ok: false, reason: "live_memory_exhausted",
    node: input.node, nodes: [summary], message: `node ${input.node} has no live headroom above the ${input.safetyFloorBytes / 1024 ** 3} GiB safety floor` };
  return { ok: true, nodes: [summary] };
}
