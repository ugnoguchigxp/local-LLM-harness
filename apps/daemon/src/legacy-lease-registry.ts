import type { Lease } from "@larm/core";

/** Owns the compatibility lease index and its links to allocation-backed leases. */
export class LegacyLeaseRegistry {
  private readonly leases = new Map<string, Lease>();
  private readonly allocationByLease = new Map<string, string>();

  values(): Lease[] {
    return [...this.leases.values()];
  }

  ids(): IterableIterator<string> {
    return this.leases.keys();
  }

  has(id: string): boolean {
    return this.leases.has(id);
  }

  get(id: string): Lease | undefined {
    return this.leases.get(id);
  }

  add(lease: Lease, allocationId?: string): void {
    this.leases.set(lease.id, lease);
    if (allocationId) this.allocationByLease.set(lease.id, allocationId);
  }

  remove(id: string): { lease: Lease | undefined; allocationId: string | undefined } {
    const lease = this.leases.get(id);
    this.leases.delete(id);
    const allocationId = this.allocationByLease.get(id);
    this.allocationByLease.delete(id);
    return { lease, allocationId };
  }

  activeAdmissionIndex(): ReadonlyMap<string, string> {
    return this.allocationByLease;
  }

  detachAllocation(allocationId: string): string[] {
    const detached: string[] = [];
    for (const [leaseId, mappedAllocationId] of this.allocationByLease) {
      if (mappedAllocationId !== allocationId) continue;
      this.allocationByLease.delete(leaseId);
      this.leases.delete(leaseId);
      detached.push(leaseId);
    }
    return detached;
  }
}
