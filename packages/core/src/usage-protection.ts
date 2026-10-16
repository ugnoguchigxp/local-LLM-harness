/** Admission protection is separate from inference slots and retained model memory. */
export class UsageProtection {
  private owner?: string;
  private active = 0;
  private preparing = 0;
  private until = 0;
  private durationMs = 0;
  private generation = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  snapshot() {
    return {
      owner: this.owner,
      activeRequests: this.active,
      preparing: this.preparing,
      remainingMs: Math.max(0, this.until - this.now()),
      protected: this.preparing > 0 || this.active > 0 || this.now() < this.until,
    };
  }

  denied(owner?: string): boolean {
    return this.owner !== undefined && this.owner !== owner
      && (this.preparing > 0 || this.active > 0 || this.now() < this.until);
  }

  /** Caller must check admission before claiming; callbacks are idempotent. */
  prepare(owner: string, durationMs: number, refreshOnReady = true): (success: boolean) => void {
    if (this.denied(owner)) throw new Error("usage protection is owned by another consumer");
    if (this.owner !== owner) {
      this.generation++;
      this.owner = owner;
      this.active = 0;
      this.preparing = 0;
      this.until = 0;
    }
    this.durationMs = durationMs;
    this.preparing++;
    const generation = this.generation;
    let done = false;
    return (success) => {
      if (done || generation !== this.generation) return;
      done = true;
      this.preparing--;
      if (success && refreshOnReady) this.until = Math.max(this.until, this.now() + this.durationMs);
      else if (this.preparing === 0 && this.active === 0 && this.until === 0) this.clear();
    };
  }

  begin(owner?: string): (used?: boolean) => void {
    if (this.denied(owner)) throw new Error("usage protection is owned by another consumer");
    if (!owner || owner !== this.owner) return () => {};
    this.active++;
    const generation = this.generation;
    let done = false;
    return (used = true) => {
      if (done || generation !== this.generation) return;
      done = true;
      this.active--;
      if (used) this.until = this.now() + this.durationMs;
    };
  }

  /** Transfer is only allowed after protection has elapsed and requests have ended. */
  relinquish(owner?: string): boolean {
    if (this.denied(owner)) return false;
    if (this.owner !== owner) this.clear();
    return true;
  }

  private clear(): void {
    this.owner = undefined;
    this.active = 0;
    this.preparing = 0;
    this.until = 0;
    this.generation++;
  }
}
