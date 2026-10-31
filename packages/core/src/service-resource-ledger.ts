import { runtimeMemoryGB } from "./prompt-retention";
import type { Allocation } from "./allocation";
import { admittedAllocation } from "./allocation";
import type { Registry } from "./registry";
import type { ClusterState } from "./schema";
import type { AdmissionResult, NodeAdmission } from "./admission";
import type { ServiceMemoryReservation } from "./local-service";

export type ServiceAdmissionInput = {
  registry: Registry; state: ClusterState; allocations: readonly Allocation[]; now: number; maxAgeMs: number;
  liveSafetyFloorBytes?: number; accelerator?: boolean;
};

export class ServiceMemoryAdmissionError extends Error {
  constructor(readonly admission: Exclude<AdmissionResult, { ok: true }>) { super(admission.reason); }
}

/** Runs synchronously with allocation admission/commit on the daemon's event loop. */
export class ServiceResourceLedger {
  private readonly entries = new Map<string, ServiceMemoryReservation>();
  reservations(): ServiceMemoryReservation[] { return [...this.entries.values()].map(v => ({ ...v })); }
  restore(id: string, node: string, bytes: number): void { this.entries.set(id, { node, bytes, pendingBytes: bytes }); }
  release(id: string): void { this.entries.delete(id); }
  reserve(id: string, nodeId: string, bytes: number, input: ServiceAdmissionInput): void {
    if (this.entries.has(id)) return;
    this.check(nodeId, bytes, input);
    this.restore(id, nodeId, bytes);
  }
  check(nodeId: string, bytes: number, input: ServiceAdmissionInput): void {
    const result = this.admission(nodeId, bytes, input);
    if (!result.ok) throw new ServiceMemoryAdmissionError(result);
  }
  admission(nodeId: string, bytes: number, input: ServiceAdmissionInput): AdmissionResult {
    const failure = (reason: "telemetry_unavailable" | "memory_exhausted" | "live_memory_exhausted", message: string, nodes: NodeAdmission[] = []): AdmissionResult =>
      ({ ok: false, reason, message, node: nodeId, nodes });
    const node = input.registry.nodes.find(n => n.id === nodeId);
    const t = input.state.node.id === nodeId ? input.state.node.telemetry : undefined;
    const observed = t ? Date.parse(t.observedAt) : NaN;
    if (!node || !t || t.status !== "available" || t.systemMemoryAvailableBytes === undefined
      || !Number.isFinite(observed) || observed > input.now || input.now - observed > input.maxAgeMs) {
      return failure("telemetry_unavailable", `fresh resource telemetry is unavailable for node ${nodeId}`);
    }
    const ids = new Set(input.allocations.filter(a => admittedAllocation(a.status)).flatMap(a => a.bindings.map(b => b.runtime)));
    for (const r of input.registry.runtimes) if (r.policy.class === "resident") ids.add(r.id);
    for (const r of input.state.runtimes) if (!["COLD", "FAILED"].includes(r.status)) ids.add(r.id);
    const ai = input.registry.runtimes.filter(r => r.node === nodeId && ids.has(r.id));
    const aiBytes = ai.reduce((n, r) => n + runtimeMemoryGB(r) * 1024 ** 3, 0);
    const existing = this.reservations().filter(r => r.node === nodeId);
    const gib = 1024 ** 3;
    const committedMemoryGB = (aiBytes + existing.reduce((n, r) => n + r.bytes, 0)) / gib;
    const usableMemoryGB = node.resources.memoryTotalGB - node.resources.reservedMemoryGB;
    const summary: NodeAdmission = { node: nodeId, usableMemoryGB, committedMemoryGB,
      incrementalMemoryGB: bytes / gib, availableMemoryGB: usableMemoryGB - committedMemoryGB };
    if (bytes / gib > summary.availableMemoryGB) {
      return failure("memory_exhausted", `node ${nodeId} needs ${bytes / gib} GiB but static headroom is ${summary.availableMemoryGB} GiB`, [summary]);
    }
    // Pending AI starts aren't yet reflected in MemAvailable. Account for them once.
    const pendingAi = ai.filter(r => !input.state.runtimes.some(s => s.id === r.id && ["HOT", "BUSY"].includes(s.status)))
      .reduce((n, r) => n + runtimeMemoryGB(r) * 1024 ** 3, 0);
    const liveBytes = input.accelerator && t.acceleratorMemoryAvailableBytes !== undefined
      ? Math.min(t.systemMemoryAvailableBytes, t.acceleratorMemoryAvailableBytes) : t.systemMemoryAvailableBytes;
    const pendingBytes = pendingAi + existing.reduce((n, r) => n + r.pendingBytes, 0);
    const availableBytes = Math.max(0, liveBytes - (input.liveSafetyFloorBytes ?? 0) - pendingBytes);
    summary.liveAvailableMemoryGB = availableBytes / gib;
    if (bytes > availableBytes) return failure("live_memory_exhausted",
      `node ${nodeId} needs ${bytes / gib} GiB but live headroom after safety floor and pending reservations is ${availableBytes / gib} GiB`, [summary]);
    return { ok: true, nodes: [summary] };
  }
  observe(id: string, usedBytes: number): void {
    const r = this.entries.get(id);
    if (r && Number.isSafeInteger(usedBytes) && usedBytes >= 0) r.pendingBytes = Math.max(0, r.bytes - usedBytes);
  }
}
