/** A screen lease never changes credential expiry or records inference activity. */
export const OWNERSHIP_TTL_MS = 90_000;
export const OWNERSHIP_HEARTBEAT_SECONDS = 30;

export class ConnectionOwnership {
  private deadline: number;
  private sequence = 0;
  private released = false;
  constructor(readonly id: string, private readonly now: () => number = Date.now) {
    this.deadline = now() + OWNERSHIP_TTL_MS;
  }
  get active(): boolean { return !this.released && this.now() < this.deadline; }
  refresh(sequence: number): "updated" | "inactive" | "stale" {
    if (!this.active) return "inactive";
    if (sequence <= this.sequence) return "stale";
    this.sequence = sequence;
    this.deadline = this.now() + OWNERSHIP_TTL_MS;
    return "updated";
  }
  release(): void { this.released = true; }
  snapshot() {
    return {
      id: this.id,
      state: this.released ? "released" as const : this.active ? "active" as const : "expired" as const,
      sequence: this.sequence,
      expiresAt: new Date(this.deadline).toISOString(),
      heartbeatSeconds: 30 as const,
      ttlSeconds: 90 as const,
    };
  }
}

/** Bounds acquisition tombstones without permitting a delayed acquisition to revive. */
export class ConnectionOwnershipRegistry {
  private readonly acquisitions = new Map<string, { until: number; lease: ConnectionOwnership }>();
  constructor(private readonly limit: number, private readonly now: () => number = Date.now) {}
  acquire(id: string, issuedAt: number): ConnectionOwnership | "expired" | "conflict" | "capacity" {
    const now = this.now();
    if (!Number.isFinite(issuedAt) || issuedAt > now || issuedAt + OWNERSHIP_TTL_MS <= now) return "expired";
    for (const [key, entry] of this.acquisitions) {
      if (entry.until <= now && !entry.lease.active) this.acquisitions.delete(key);
    }
    if (this.acquisitions.has(id)) return "conflict";
    if (this.acquisitions.size >= this.limit) return "capacity";
    const lease = new ConnectionOwnership(id, this.now);
    this.acquisitions.set(id, { until: issuedAt + OWNERSHIP_TTL_MS, lease });
    return lease;
  }
}
