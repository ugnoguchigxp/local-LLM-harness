import type { Allocation } from "./allocation";
import { admittedAllocation } from "./allocation";
import type { Registry } from "./registry";
import type { ClusterState } from "./schema";
import type { ServiceMemoryReservation } from "./local-service";

/** Runs synchronously with allocation admission/commit on the daemon's event loop. */
export class ServiceResourceLedger {
  private readonly entries = new Map<string, ServiceMemoryReservation>();
  reservations(): ServiceMemoryReservation[] { return [...this.entries.values()].map(v => ({ ...v })); }
  restore(id: string, node: string, bytes: number): void { this.entries.set(id, { node, bytes, pendingBytes: bytes }); }
  release(id: string): void { this.entries.delete(id); }
  reserve(id: string, nodeId: string, bytes: number, input: {
    registry: Registry; state: ClusterState; allocations: readonly Allocation[]; now: number; maxAgeMs: number;
  }): void {
    if (this.entries.has(id)) return;
    const node = input.registry.nodes.find(n => n.id === nodeId);
    const t = input.state.node.id === nodeId ? input.state.node.telemetry : undefined;
    const observed = t ? Date.parse(t.observedAt) : NaN;
    if (!node || !t || t.status !== "available" || t.systemMemoryAvailableBytes === undefined
      || !Number.isFinite(observed) || observed > input.now || input.now - observed > input.maxAgeMs) {
      throw new Error("telemetry_unavailable");
    }
    const ids = new Set(input.allocations.filter(a => admittedAllocation(a.status)).flatMap(a => a.bindings.map(b => b.runtime)));
    for (const r of input.registry.runtimes) if (r.policy.class === "resident") ids.add(r.id);
    for (const r of input.state.runtimes) if (!["COLD", "FAILED"].includes(r.status)) ids.add(r.id);
    const ai = input.registry.runtimes.filter(r => r.node === nodeId && ids.has(r.id));
    const aiBytes = ai.reduce((n, r) => n + r.resources.estimatedMemoryGB * 1024 ** 3, 0);
    const existing = this.reservations().filter(r => r.node === nodeId);
    if (aiBytes + existing.reduce((n, r) => n + r.bytes, 0) + bytes > (node.resources.memoryTotalGB - node.resources.reservedMemoryGB) * 1024 ** 3) {
      throw new Error("memory_exhausted");
    }
    // Pending AI starts aren't yet reflected in MemAvailable. Account for them once.
    const pendingAi = ai.filter(r => !input.state.runtimes.some(s => s.id === r.id && ["HOT", "BUSY"].includes(s.status)))
      .reduce((n, r) => n + r.resources.estimatedMemoryGB * 1024 ** 3, 0);
    if (bytes + pendingAi + existing.reduce((n, r) => n + r.pendingBytes, 0) > t.systemMemoryAvailableBytes) throw new Error("live_memory_exhausted");
    this.restore(id, nodeId, bytes);
  }
  observe(id: string, usedBytes: number): void {
    const r = this.entries.get(id);
    if (r && Number.isSafeInteger(usedBytes) && usedBytes >= 0) r.pendingBytes = Math.max(0, r.bytes - usedBytes);
  }
}
