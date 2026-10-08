import { z } from "zod";
import {
  serviceInstanceToken, legacyServiceInstanceToken, localServiceIdle, localServiceRevision, localServiceLeaseRequestSchema, localServiceRenewSchema, localServiceDefinitionSchema,
  type LocalServiceActivity, type LocalServiceDefinition, type LocalServiceLease, type LocalServiceBackend, type LocalServiceJournal,
} from "./local-service";
import type { ServiceResourceLedger } from "./service-resource-ledger";

export class LocalServiceError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503 = 409) { super(code); }
}
type Entry = {
  definition: LocalServiceDefinition; revision: string; generation: number;
  state: "stopped" | "starting" | "ready" | "draining" | "stopping" | "failed";
  instanceToken: string | null; appBootId?: string; drainToken?: string; activity?: LocalServiceActivity; error?: string; idleSince?: number;
  pending?: Promise<void>; nextPollAt?: number;
  startupFailures: number; nextStartAt: number;
};
type OwnedLease = LocalServiceLease & { principal: string };
const journalV1Schema = z.object({ version: z.literal(1), entries: z.array(z.object({
  id: z.string(), revision: z.string(), generation: z.number().int().nonnegative(), containerIds: z.array(z.string()).max(2),
  appBootId: z.string().optional(),
  drainToken: z.string().min(1).max(128).optional(),
  startupFailures: z.number().int().min(0).max(3).optional(), nextStartAt: z.number().finite().nonnegative().optional(),
}).strict()).max(64) }).strict();
const journalV2Schema = z.object({ version: z.literal(2), entries: z.array(z.object({
  id: z.string(), revision: z.string(), generation: z.number().int().nonnegative(), instanceToken: z.string().min(1).max(256).nullable(),
  appBootId: z.string().optional(), drainToken: z.string().min(1).max(128).optional(),
  startupFailures: z.number().int().min(0).max(3).optional(), nextStartAt: z.number().finite().nonnegative().optional(),
}).strict()).max(64) }).strict();
function parseJournal(value: unknown): z.infer<typeof journalV2Schema> {
  if (typeof value === "object" && value !== null && "version" in value && value.version === 1) {
    const old = journalV1Schema.parse(value);
    return { version: 2, entries: old.entries.map(({ containerIds, ...entry }) => ({ ...entry, instanceToken: legacyServiceInstanceToken(containerIds) })) };
  }
  return journalV2Schema.parse(value);
}
export class LocalServiceManager {
  private readonly entries = new Map<string, Entry>();
  private readonly leases = new Map<string, OwnedLease>();
  private readonly keys = new Map<string, { body: string; leaseId: string }>();
  private closing = false;
  private journalBlocked = false;
  private journalChain: Promise<void> = Promise.resolve();
  constructor(definitions: LocalServiceDefinition[], private readonly backend: LocalServiceBackend, private readonly options: {
    bootEpoch: string; journal: LocalServiceJournal; ledger: ServiceResourceLedger;
    reserve: (id: string, d: LocalServiceDefinition) => void;
    now?: () => number; sleep?: (ms: number) => Promise<void>; onEvent?: (name: string, service: string, reason?: string) => void;
  }) {
    if (definitions.length > 64) throw new Error("too_many_local_services");
    for (const source of definitions) {
      const definition = localServiceDefinitionSchema.parse(source);
      if (this.entries.has(definition.id)) throw new Error("duplicate_local_service");
      this.entries.set(definition.id, { definition, revision: localServiceRevision(definition), generation: 0, state: "stopped", instanceToken: null, startupFailures: 0, nextStartAt: 0 });
    }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private sleep(ms: number) { return this.options.sleep?.(ms) ?? new Promise<void>(resolve => setTimeout(resolve, ms)); }
  private entry(id: string) { const e = this.entries.get(id); if (!e) throw new LocalServiceError("service_not_found", 404); return e; }
  private event(e: Entry, reason?: string) { this.options.onEvent?.(`local_service_${e.state}`, e.definition.id, reason); }
  private fresh(e: Entry): boolean {
    const age = e.activity ? this.now() - Date.parse(e.activity.observedAt) : NaN;
    return !e.error && !!e.activity && !e.activity.draining && age >= 0 && age <= e.definition.activity.staleAfterSeconds * 1000;
  }
  private failLeases(e: Entry, reason: string): void {
    for (const l of this.leases.values()) if (l.serviceId === e.definition.id && l.generation === e.generation && ["starting", "ready"].includes(l.status)) {
      l.status = "failed"; l.error = reason;
    }
  }
  private reserveUnknown(e: Entry): void {
    this.options.ledger.restore(e.definition.id, e.definition.node, e.definition.resources.startupReservationBytes);
  }
  private confirmedStopped(e: Entry, o: Awaited<ReturnType<LocalServiceBackend["observe"]>>): boolean {
    return serviceInstanceToken(e.definition, o) === null && (o.state === "stopped" || o.state === "failed")
      && (e.definition.backend !== "systemd-process" || o.stopConfirmed === true);
  }
  private async stopped(e: Entry, reason: string): Promise<void> {
    this.failLeases(e, reason);
    e.state = "stopped"; e.instanceToken = null; e.appBootId = undefined; e.drainToken = undefined; e.activity = undefined; e.error = undefined; e.idleSince = undefined;
    this.options.ledger.release(e.definition.id); await this.save();
  }
  private save(): Promise<void> {
    if (this.journalBlocked) return Promise.reject(new Error("journal_recovery_required"));
    const value = { version: 2, entries: [...this.entries.values()].map(e => ({
      id: e.definition.id, revision: e.revision, generation: e.generation, instanceToken: e.instanceToken,
      ...(e.appBootId ? { appBootId: e.appBootId } : {}),
      ...(e.drainToken ? { drainToken: e.drainToken } : {}),
      startupFailures: e.startupFailures, nextStartAt: e.nextStartAt,
    })) };
    const task = this.journalChain.then(() => this.options.journal.save(value));
    this.journalChain = task.catch(() => {});
    return task;
  }
  async initialize(): Promise<void> {
    let saved: z.infer<typeof journalV2Schema> | undefined;
    let journalInvalid = false;
    try { const loaded = await this.options.journal.load(); if (loaded !== undefined) saved = parseJournal(loaded); }
    catch { journalInvalid = true; }
    for (const e of this.entries.values()) {
      const prior = saved?.entries.find(p => p.id === e.definition.id);
      e.generation = prior?.generation ?? 0;
      if (prior?.revision === e.revision) { e.startupFailures = prior.startupFailures ?? 0; e.nextStartAt = prior.nextStartAt ?? 0; }
      try {
        const o = await this.backend.observe(e.definition);
        if (this.confirmedStopped(e, o)) { this.options.ledger.release(e.definition.id); continue; }
        this.options.ledger.restore(e.definition.id, e.definition.node, e.definition.resources.startupReservationBytes);
        if (!prior || prior.generation < 1 || prior.revision !== e.revision || prior.instanceToken !== serviceInstanceToken(e.definition, o) || o.state !== "running") throw new Error("reconcile_quarantine");
        e.instanceToken = serviceInstanceToken(e.definition, o);
        e.appBootId = prior.appBootId;
        e.drainToken = prior.drainToken;
        const a = await this.backend.activity(e.definition);
        if (prior.appBootId !== a.bootId) throw new Error("app_generation_changed");
        if (a.draining) {
          if (!a.drainToken || a.drainToken !== e.drainToken) throw new Error("unowned_drain");
          await this.backend.resume(e.definition, a.drainToken);
        }
        e.activity = await this.backend.activity(e.definition);
        if (e.activity.bootId !== a.bootId || !this.fresh(e) || !await this.backend.ready(e.definition)) throw new Error("reconcile_unready");
        e.state = "ready";
        e.drainToken = undefined;
        this.options.ledger.observe(e.definition.id, o.memoryUsageBytes);
      } catch {
        // Unknown deployment must reserve its full budget until positively observed stopped.
        this.options.ledger.restore(e.definition.id, e.definition.node, e.definition.resources.startupReservationBytes);
        e.state = "failed"; e.error = "reconcile_quarantine";
      }
    }
    if (!journalInvalid) await this.save();
    else {
      this.journalBlocked = true;
      for (const e of this.entries.values()) { e.state = "failed"; e.error = "journal_recovery_required"; }
    } // Preserve corrupt/unsupported evidence; require administrator recovery.
  }
  list() { return [...this.entries.keys()].map(id => this.status(id)); }
  status(id: string) {
    const e = this.entry(id);
    return { id, revision: e.revision, generation: e.generation, state: e.state,
      busy: e.activity ? !localServiceIdle(e.activity) : null,
      activityFresh: this.fresh(e),
      ...(e.error ? { error: e.error } : {}) };
  }
  private owned(id: string, principal: string) {
    const l = this.leases.get(id); if (!l) throw new LocalServiceError("lease_not_found", 404);
    if (l.principal !== principal) throw new LocalServiceError("lease_not_owned", 403);
    if (!["released", "expired"].includes(l.status) && Date.parse(l.expiresAt) <= this.now()) l.status = "expired";
    return l;
  }
  get(id: string, principal: string): LocalServiceLease {
    const l = this.owned(id, principal), e = this.entry(l.serviceId);
    if (["starting", "ready"].includes(l.status)) {
      l.status = e.state === "ready" && this.fresh(e) && e.generation === l.generation ? "ready" : e.state === "failed" || e.generation !== l.generation ? "failed" : "starting";
      if (e.error) l.error = e.error; else delete l.error;
    }
    const { principal: _, endpoint: __, ...publicLease } = l;
    return { ...publicLease, ...(l.status === "ready" ? { endpoint: e.definition.deployment.publicEndpoint } : {}) };
  }
  async ensure(id: string, principal: string, key: string, raw: unknown): Promise<LocalServiceLease> {
    if (this.journalBlocked) throw new LocalServiceError("journal_recovery_required", 503);
    if (this.closing) throw new LocalServiceError("draining", 503);
    if (!key || key.length > 192) throw new LocalServiceError("idempotency_key_required", 400);
    const request = localServiceLeaseRequestSchema.parse(raw), e = this.entry(id);
    if (request.catalogRevision && request.catalogRevision !== e.revision) throw new LocalServiceError("catalog_changed");
    const token = JSON.stringify([principal, id, key]), body = JSON.stringify(request), previous = this.keys.get(token);
    if (previous) { if (previous.body !== body) throw new LocalServiceError("idempotency_conflict"); return this.get(previous.leaseId, principal); }
    if (this.leases.size >= 1000) {
      for (const [leaseId, l] of this.leases) if (Date.parse(l.expiresAt) <= this.now() || l.status === "released") {
        this.leases.delete(leaseId); for (const [k, v] of this.keys) if (v.leaseId === leaseId) this.keys.delete(k);
      }
      if (this.leases.size >= 1000) throw new LocalServiceError("lease_capacity", 429);
    }
    if (e.pending && !["starting", "ready", "draining"].includes(e.state)) {
      // Recheck idempotency, capacity, closing and state after the transition.
      await e.pending.catch(() => {});
      return this.ensure(id, principal, key, request);
    }
    if (e.state === "ready" && !this.fresh(e)) throw new LocalServiceError("readiness_unknown", 503);
    if (e.state === "failed") throw new LocalServiceError(e.error ?? "service_failed", 503);
    if (e.state === "stopped") {
      if (e.startupFailures >= 3) throw new LocalServiceError("startup_retry_limit");
      if (this.now() < e.nextStartAt) throw new LocalServiceError("startup_cooldown", 503);
      // No await between AI accounting, Service reservation, and marking STARTING.
      try { this.options.reserve(id, e.definition); } catch (err) { throw new LocalServiceError(err instanceof Error ? err.message : "resource_exhausted", 503); }
      e.generation++; e.state = "starting"; e.error = undefined; e.idleSince = undefined; e.nextPollAt = undefined; e.activity = undefined; e.appBootId = undefined; e.drainToken = undefined; e.instanceToken = null;
      const task = this.start(e); e.pending = task;
      void task.then(() => { if (e.pending === task) e.pending = undefined; }, () => { if (e.pending === task) e.pending = undefined; e.state = "failed"; e.error = "journal_failed"; });
    }
    e.idleSince = undefined;
    const leaseId = `slease_${crypto.randomUUID()}`;
    const l: OwnedLease = { id: leaseId, principal, serviceId: id, revision: e.revision, generation: e.generation,
      bootEpoch: this.options.bootEpoch, expiresAt: new Date(this.now() + Math.min(request.ttlSeconds ?? e.definition.lifecycle.leaseSeconds, e.definition.lifecycle.leaseSeconds) * 1000).toISOString(), status: "starting" };
    this.leases.set(leaseId, l); this.keys.set(token, { body, leaseId });
    return this.get(leaseId, principal);
  }
  private async start(e: Entry): Promise<void> {
    const deadline = this.now() + e.definition.readiness.timeoutSeconds * 1000;
    try {
      await this.save(); await this.backend.start(e.definition);
      do {
        if (this.now() > deadline) throw new Error("readiness_timeout");
        const o = await this.backend.observe(e.definition);
        if (o.state === "running" && serviceInstanceToken(e.definition, o) && await this.backend.ready(e.definition)) {
          e.instanceToken = serviceInstanceToken(e.definition, o); e.activity = await this.backend.activity(e.definition);
          if (!this.fresh(e) || this.now() > deadline) throw new Error("startup_activity_unknown");
          e.appBootId = e.activity.bootId;
          e.startupFailures = 0; e.nextStartAt = 0;
          await this.save(); this.options.ledger.observe(e.definition.id, o.memoryUsageBytes);
          e.state = "ready"; this.event(e); return;
        }
        if (o.state === "failed") throw new Error("instance_failed");
        await this.sleep(250);
      } while (this.now() < deadline);
      throw new Error("readiness_timeout");
    } catch {
      // Don't send SIGTERM to unobserved jobs. A failed start retains its reservation
      // until a positive stop observation or an administrator resolves quarantine.
      e.state = "failed"; e.error = "startup_failed"; this.event(e, e.error);
      e.startupFailures = Math.min(3, e.startupFailures + 1);
      e.nextStartAt = this.now() + 5000 * 2 ** (e.startupFailures - 1);
      this.failLeases(e, e.error); this.reserveUnknown(e);
      try { if (this.confirmedStopped(e, await this.backend.observe(e.definition))) { this.options.ledger.release(e.definition.id); e.state = "stopped"; } } catch {}
      await this.save();
    }
  }
  renew(id: string, principal: string, raw: unknown): LocalServiceLease {
    const r = localServiceRenewSchema.parse(raw), l = this.owned(id, principal), e = this.entry(l.serviceId);
    if (!['ready', 'starting'].includes(l.status) || r.bootEpoch !== l.bootEpoch || r.generation !== l.generation || e.generation !== l.generation || e.state === "failed") throw new LocalServiceError("stale_binding");
    l.expiresAt = new Date(this.now() + Math.min(r.ttlSeconds ?? e.definition.lifecycle.leaseSeconds, e.definition.lifecycle.leaseSeconds) * 1000).toISOString();
    e.idleSince = undefined; return this.get(id, principal);
  }
  release(id: string, principal: string): void { this.owned(id, principal).status = "released"; }
  private references(e: Entry) {
    return [...this.leases.values()].some(l => l.serviceId === e.definition.id && ['ready', 'starting'].includes(l.status) && Date.parse(l.expiresAt) > this.now());
  }
  async tick(): Promise<void> {
    if (this.closing || this.journalBlocked) return;
    await Promise.all([...this.entries.values()].map(async e => {
      if (e.pending || this.now() < (e.nextPollAt ?? 0)) return;
      e.nextPollAt = this.now() + e.definition.activity.pollSeconds * 1000;
      const task = this.poll(e); e.pending = task;
      try { await task; } finally { if (e.pending === task) e.pending = undefined; }
    }));
  }
  private async poll(e: Entry): Promise<void> {
    if (e.state === "failed") {
      try { if (this.confirmedStopped(e, await this.backend.observe(e.definition))) await this.stopped(e, "instance_stopped"); } catch {}
      return;
    }
    if (e.state !== "ready") return;
    const previous = e.activity;
    if (!this.fresh(e)) e.idleSince = undefined;
    try {
      const o = await this.backend.observe(e.definition);
      if (this.confirmedStopped(e, o)) { await this.stopped(e, "instance_stopped"); return; }
      if (o.state !== "running" || serviceInstanceToken(e.definition, o) !== e.instanceToken) {
        e.state = "failed"; this.failLeases(e, "instance_changed"); throw new Error("instance_changed");
      }
      this.options.ledger.observe(e.definition.id, o.memoryUsageBytes);
      if (!await this.backend.ready(e.definition)) throw new Error("readiness_lost");
      const a = await this.backend.activity(e.definition);
      if (a.draining || (e.activity && (a.bootId !== e.activity.bootId || a.sequence < e.activity.sequence))) {
        e.state = "failed"; this.failLeases(e, "activity_generation_changed"); throw new Error("activity_generation_changed");
      }
      e.activity = a; e.error = undefined;
      if (previous && a.sequence > previous.sequence + 1) e.idleSince = undefined;
      if (!localServiceIdle(a) || this.references(e)) { e.idleSince = undefined; return; }
      e.idleSince ??= this.now();
      if (this.now() - e.idleSince >= e.definition.lifecycle.idleSeconds * 1000) await this.drainAndStop(e);
    } catch { e.idleSince = undefined; e.error ??= "activity_unknown"; this.reserveUnknown(e); this.event(e, e.error); }
  }
  async stop(id: string): Promise<void> {
    const e = this.entry(id);
    if (e.pending) throw new LocalServiceError("transition_in_progress");
    if (e.state === "stopped") return;
    if (e.state !== "ready" || !e.instanceToken || !e.activity) throw new LocalServiceError("service_quarantined", 503);
    if (this.references(e)) throw new LocalServiceError("service_busy");
    const task = this.drainAndStop(e); e.pending = task;
    try { await task; } finally { if (e.pending === task) e.pending = undefined; }
  }
  private async drainAndStop(e: Entry): Promise<void> {
    let token: string | null = null;
    let drainRequested = false;
    try {
      e.state = "draining";
      const before = await this.backend.observe(e.definition), beforeActivity = await this.backend.activity(e.definition);
      if (before.state !== "running" || serviceInstanceToken(e.definition, before) !== e.instanceToken || beforeActivity.bootId !== e.activity?.bootId || beforeActivity.sequence < (e.activity?.sequence ?? 0) || beforeActivity.draining) throw new LocalServiceError("instance_changed");
      if (!localServiceIdle(beforeActivity) || this.references(e)) throw new LocalServiceError("service_busy");
      drainRequested = true;
      const a = await this.backend.drain(e.definition); token = a.drainToken;
      if (!a.draining || !token || a.sequence < beforeActivity.sequence || (e.activity && a.bootId !== e.activity.bootId)) throw new LocalServiceError("instance_changed");
      e.drainToken = token; await this.save();
      if (!localServiceIdle(a) || this.references(e)) throw new LocalServiceError("service_busy");
      const final = await this.backend.activity(e.definition);
      if (!final.draining || final.drainToken !== token || final.bootId !== a.bootId || final.sequence < a.sequence || !localServiceIdle(final) || this.references(e)) throw new LocalServiceError("service_busy");
      const o = await this.backend.observe(e.definition);
      if (o.state !== "running" || serviceInstanceToken(e.definition, o) !== e.instanceToken) throw new LocalServiceError("instance_changed");
      if (this.references(e)) throw new LocalServiceError("service_busy");
      e.state = "stopping"; this.event(e);
      await this.save(); await this.backend.stop(e.definition, { instanceToken: e.instanceToken!, appBootId: final.bootId, drainToken: token });
      const stopped = await this.backend.observe(e.definition);
      if (!this.confirmedStopped(e, stopped)) throw new LocalServiceError("stop_unconfirmed", 503);
      await this.stopped(e, "instance_stopped"); this.event(e);
    } catch (err) {
      this.reserveUnknown(e);
      if (e.state === "draining") {
        try {
          const o = await this.backend.observe(e.definition), a = await this.backend.activity(e.definition);
          if (o.state !== "running" || serviceInstanceToken(e.definition, o) !== e.instanceToken || a.bootId !== e.activity?.bootId || a.sequence < (e.activity?.sequence ?? 0) || (token && a.drainToken !== token)) throw new Error("resume_identity_changed");
          if (a.draining && a.drainToken) {
            if (!drainRequested) throw new Error("unowned_drain");
            await this.backend.resume(e.definition, a.drainToken);
          }
          e.activity = await this.backend.activity(e.definition); e.error = undefined;
          if (e.activity.bootId !== a.bootId || !this.fresh(e) || !await this.backend.ready(e.definition)) throw new Error("resume_unready");
          e.state = "ready";
          e.drainToken = undefined; await this.save();
        }
        catch { e.state = "failed"; e.error = "resume_failed"; }
      } else { e.state = "failed"; e.error = "stop_unconfirmed"; }
      if (e.state === "failed") this.failLeases(e, e.error ?? "service_failed");
      e.idleSince = undefined; this.event(e, e.error ?? "service_busy");
      throw err instanceof LocalServiceError ? err : new LocalServiceError("service_control_unavailable", 503);
    }
  }
  async close(): Promise<void> { this.closing = true; await Promise.allSettled([...this.entries.values()].map(e => e.pending)); await this.save(); }
  async flush(): Promise<void> { await Promise.all([...this.entries.values()].map(e => e.pending)); }
}
