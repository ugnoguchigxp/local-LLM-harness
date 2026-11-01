import { admitLiveMemory } from "./live-memory";
import type { Allocation } from "./allocation";
import type { Registry } from "./registry";
import type { ClusterState } from "./schema";
import type { AdmissionResult } from "./admission";
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
  restore(id: string, node: string, bytes: number): void { this.entries.set(id, { node, bytes: 0, pendingBytes: 0 }); }
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
    // Compatibility ledger tracks uncertain service lifecycles, never capacity.
    const node = input.registry.nodes.find(n => n.id === nodeId);
    return admitLiveMemory({ state: input.state, node: nodeId, now: input.now, maxAgeMs: input.maxAgeMs,
      accelerator: input.accelerator,
      safetyFloorBytes: input.liveSafetyFloorBytes ?? (node?.resources.reservedMemoryGB ?? 0) * 1024 ** 3 });
  }

  observe(id: string, usedBytes: number): void {
    // Physical usage is already included in fresh OS/driver telemetry.
  }
}
