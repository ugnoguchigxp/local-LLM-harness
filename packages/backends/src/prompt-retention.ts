import { createHmac } from "node:crypto";
import { promptRetentionContextSchema, promptRetentionPolicySchema, type PromptRetentionPolicy } from "@larm/core";

type Target = { endpoint: string; instance: string; runtimeId: string; providerId?: string };
/** Private engine protocol. Never derive scope or quota identity from consumer headers. */
export class LlamaPromptRetention {
  private readonly targets = new Map<string, { bindings: Map<string, Target>; expires: number }>();
  private targetCount = 0;
  private readonly revoked = new Map<string, number>();
  private disabled = false;
  private readonly scopeSignals = new Map<string, { signal: AbortSignal; listener: () => void }>();
  constructor(private readonly key: string, private readonly fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
    private readonly isLive: (target: Target) => boolean = () => false) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("prompt retention key must be 32 random bytes encoded as hex");
  }
  private digest(kind: string, value: unknown): string {
    return createHmac("sha256", this.key).update(JSON.stringify([kind, value])).digest("hex");
  }
  scope(principal: string, connection: string, epoch: string, cacheKey?: string): string {
    return this.digest("scope", [principal, cacheKey === undefined ? ["connection", connection] : ["key", cacheKey], epoch]);
  }
  private forget(scope: string): void {
    this.targetCount -= this.targets.get(scope)?.bindings.size ?? 0;
    this.targets.delete(scope);
    const watched = this.scopeSignals.get(scope);
    watched?.signal.removeEventListener("abort", watched.listener);
    this.scopeSignals.delete(scope);
  }
  private prune(): void {
    const t = performance.now();
    for (const [scope, target] of this.targets) if (target.expires <= t) this.forget(scope);
    for (const [scope, expires] of this.revoked) if (expires <= t) this.revoked.delete(scope);
  }
  async headers(input: { principal: string; connection: string; epoch: string; instance: unknown; cacheKey?: string;
    expiresAt: number; now: number; requestId: string; endpoint: string; policy: PromptRetentionPolicy; signal: AbortSignal;
    runtimeId: string; providerId?: string; scopeSignal?: AbortSignal }): Promise<Headers> {
    this.prune();
    if (this.disabled) return new Headers();
    const endpoint = input.endpoint.replace(/\/+$/, "");
    // Check each binding before forwarding. A cached success cannot attest to a replaced engine.
    const response = await this.fetchImpl(`${endpoint}/props`, {
      headers: { "x-larm-cache-key": this.key }, redirect: "error", signal: input.signal,
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("prompt_retention_capability_unavailable"); }
    const props = await response.json() as { larm_prompt_cache?: { enabled?: boolean; authenticated?: boolean; policy?: unknown } };
    const policy = promptRetentionPolicySchema.safeParse(props.larm_prompt_cache?.policy);
    if (props.larm_prompt_cache?.enabled !== true || props.larm_prompt_cache.authenticated !== true || !policy.success
      || JSON.stringify(policy.data) !== JSON.stringify(input.policy)) throw new Error("prompt_retention_capability_mismatch");
    const context = promptRetentionContextSchema.parse({ owner: this.digest("owner", input.principal),
      scope: this.scope(input.principal, input.connection, input.epoch, input.cacheKey), instance: this.digest("instance", input.instance),
      correlation: this.digest("request", input.requestId), leaseMs: Math.min(300_000, Math.floor(input.expiresAt - input.now)) });
    this.prune();
    if (this.disabled) return new Headers();
    if (this.revoked.has(context.scope) || this.revoked.has(this.scope(input.principal, input.connection, input.epoch))
      || input.scopeSignal?.aborted) throw new Error("prompt_retention_scope_revoked");
    let target = this.targets.get(context.scope);
    if (!target) {
      if (this.targets.size >= 4096) return new Headers(); // Cold execution remains available.
      target = { bindings: new Map(), expires: performance.now() + 300_000 }; this.targets.set(context.scope, target);
    }
    const bindings = target.bindings;
    // Bounded by controller connection history; a connection cannot grow an unbounded runtime list.
    if (!bindings.has(context.instance)) {
      if (bindings.size >= 64 || this.targetCount >= 8192) return new Headers();
      this.targetCount++;
    }
    target.expires = performance.now() + 300_000;
    bindings.set(context.instance, { endpoint, instance: context.instance, runtimeId: input.runtimeId, providerId: input.providerId });
    // Explicit keys may be shared by several authorized Connections. Releasing
    // one revokes its credential/default scope, not the other Connections' key.
    // Keyed snapshots expire under the same bounded native TTL and byte budget.
    if (input.cacheKey === undefined && input.scopeSignal && !this.scopeSignals.has(context.scope)) {
      const { principal, connection, epoch } = input;
      const listener = () => { void this.invalidate(principal, connection, epoch).catch(() => undefined); };
      this.scopeSignals.set(context.scope, { signal: input.scopeSignal, listener });
      input.scopeSignal.addEventListener("abort", listener, { once: true });
      if (input.scopeSignal.aborted) { await this.invalidate(input.principal, input.connection, input.epoch); throw new Error("prompt_retention_scope_revoked"); }
    }
    return new Headers({ "x-larm-cache-key": this.key, "x-larm-cache-context": JSON.stringify(context) });
  }
  async invalidate(principal: string, connection: string, epoch: string): Promise<void> {
    const scope = this.scope(principal, connection, epoch);
    this.prune();
    if (this.revoked.size >= 16384) this.disabled = true;
    else this.revoked.set(scope, performance.now() + 300_000);
    const bindings = this.targets.get(scope)?.bindings;
    this.forget(scope);
    if (!bindings) return;
    const results = await Promise.allSettled([...bindings.values()].map(async target => {
      if (!this.isLive(target)) return; // Never wake a replaced or stopped Provider to prune a cache.
      const response = await this.fetchImpl(`${target.endpoint}/larm/cache/invalidate`, { method: "POST",
        headers: { "content-type": "application/json", "x-larm-cache-key": this.key },
        body: JSON.stringify({ scope, instance: target.instance }), redirect: "error", signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error("prompt_retention_invalidation_failed");
    }));
    if (results.some(r => r.status === "rejected")) throw new Error("prompt_retention_invalidation_failed");
  }
}
