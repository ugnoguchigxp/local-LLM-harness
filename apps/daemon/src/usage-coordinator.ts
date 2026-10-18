import { AsyncLocalStorage } from "node:async_hooks";
import { UsageProtection } from "@larm/core";
import type { MetricsRegistry } from "./metrics";

export class UsageProtectionError extends Error {
  readonly code = "foreground_protected";
  readonly status = 409;
  constructor(readonly retryAfterSeconds: number, message = "another consumer is protected while active and for 600 seconds after its last request") {
    super(message);
  }
}

type UsageRequest = { owner?: string; finish: (used?: boolean) => void; claimed: boolean; check: () => void; run: <T>(fn: () => T) => T };
const requests = new WeakMap<Request, UsageRequest>();
export function claimUsageRequest(request: Request): UsageRequest | undefined {
  const usage = requests.get(request);
  if (usage) usage.claimed = true;
  return usage;
}

export class UsageCoordinator {
  readonly protection: UsageProtection;
  private readonly context = new AsyncLocalStorage<string | undefined>();
  private transitioning?: string;
  private profileKey?: string;
  private readonly recordDuration?: (seconds: number) => void;
  constructor(now?: () => number, private readonly metrics?: MetricsRegistry, readonly protectedOwner?: string) {
    this.protection = new UsageProtection(now);
    try { this.recordDuration = metrics?.durationRecorder?.("protection_check_seconds"); } catch { /* Fail open for metrics only. */ }
  }
  get persistsLegacyProtection(): boolean {
    return this.protection.snapshot().owner === this.protectedOwner && this.protectedOwner !== undefined;
  }
  get owner(): string | undefined { return this.context.getStore(); }
  get isTransitioning(): boolean { return this.transitioning !== undefined; }
  get canProtect(): boolean { return this.owner !== undefined && (this.protectedOwner === undefined || this.owner === this.protectedOwner); }
  run<T>(owner: string | undefined, fn: () => T): T { return this.context.run(owner, fn); }
  check(owner = this.owner): void {
    const denied = (this.transitioning !== undefined && this.transitioning !== owner) || this.protection.denied(owner);
    if (denied) {
        this.record({ name: "protection_rejections", labels: { reason: "foreground_protected" } });
        const state = this.protection.snapshot();
        throw new UsageProtectionError(
          state.activeRequests || state.preparing ? 1 : Math.max(1, Math.ceil(state.remainingMs / 1000)),
        );
    }
  }
  private record(event: Parameters<MetricsRegistry["record"]>[0]): void {
    try { this.metrics?.record(event); } catch { /* Telemetry cannot change admission. */ }
  }
  async transfer<T>(fn: () => Promise<T>): Promise<T> {
    this.check();
    if (this.isTransitioning) throw new UsageProtectionError(1);
    this.transitioning = this.owner ?? "(unscoped)";
    try { return await fn(); }
    finally { this.transitioning = undefined; }
  }
  prepare(durationMs: number, profileKey?: string): (success: boolean) => void {
    this.check();
    if (!this.canProtect) throw new Error("protected profile requires a consumer credential");
    const refresh = profileKey === undefined || profileKey !== this.profileKey || this.protection.snapshot().owner !== this.owner;
    const complete = this.protection.prepare(this.owner!, durationMs, refresh);
    let done = false;
    return success => {
      if (done) return;
      done = true;
      complete(success);
      if (success) this.profileKey = profileKey;
    };
  }
  request(request: Request, countAsActivity = true): UsageRequest {
    const owner = this.owner;
    const started = performance.now();
    this.check(owner);
    // Internal handover work may re-enter the control plane as its owner, but
    // new inference must not acquire references while that owner's model stops.
    if (this.isTransitioning) throw new UsageProtectionError(1);
    try { this.recordDuration?.((performance.now() - started) / 1000); } catch { /* Telemetry cannot change admission. */ }
    const release = countAsActivity ? this.protection.begin(owner) : () => {};
    const usage: UsageRequest = { owner, claimed: false, check: () => this.run(owner, () => this.check()), run: fn => this.run(owner, fn), finish: release };
    requests.set(request, usage);
    return usage;
  }
}
