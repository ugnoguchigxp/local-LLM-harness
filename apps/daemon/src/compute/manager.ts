import { createHash, randomUUID } from "node:crypto";
import {
  COMPUTE_LIMITS, COMPUTE_RESULT_RESERVATION, ComputeError, computeCanonicalJson, computeErrorCodeSchema,
  parseComputeRequest, type ComputeEnvironment, type ComputeExecutor, type ComputeJob,
} from "@larm/core";
import { ComputeStore, type ComputeRecord } from "./store";

export class ComputeManager {
  private readonly store: ComputeStore;
  private cachedEnvironment?: ComputeEnvironment;
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private closed = false;
  private faulted = false;
  private initialized = false;
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: { root: string; executor: ComputeExecutor; now?: () => number; maintenanceIntervalMs?: number }) {
    this.store = new ComputeStore(options.root, () => this.quarantine());
  }
  private quarantine(): void {
    this.faulted = true;
    this.active?.abort.abort(new ComputeError("unavailable", "Compute lane is unavailable", 503));
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  get available(): boolean { return Boolean(this.cachedEnvironment) && !this.closed && !this.faulted; }
  async initialize(): Promise<void> {
    if (this.closed) throw new ComputeError("unavailable", "Compute is closed", 503);
    if (this.initialized) return;
    this.initialized = true;
    for (const record of this.store.records()) {
      const job = JSON.parse(record.state) as ComputeJob;
      if (!record.deleted && job.status === "running") this.finish(job, "unavailable", "Calculation interrupted by daemon restart");
    }
    this.prune();
    try { this.cachedEnvironment = await this.options.executor.environment(); } catch { this.cachedEnvironment = undefined; }
    this.timer = setInterval(() => {
      if (!this.closed) try { this.prune(); this.schedule(); } catch { this.quarantine(); }
    }, this.options.maintenanceIntervalMs ?? 10_000);
    this.timer.unref();
    this.schedule();
  }
  environment(): ComputeEnvironment {
    if (!this.available) throw new ComputeError("unavailable", "CPU calculation environment is not ready", 503);
    return structuredClone(this.cachedEnvironment!);
  }
  submit(body: unknown, principal: string, key: string): { jobId: string } {
    if (this.closed) throw new ComputeError("unavailable", "Compute is draining", 503);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new ComputeError("invalid_request", "Idempotency-Key is required (1–128 ASCII identifier characters)");
    const request = parseComputeRequest(body);
    const hash = createHash("sha256").update(computeCanonicalJson(request)).digest("hex");
    this.prune();
    const replay = this.store.replay(principal, key);
    if (replay) {
      if (replay.hash !== hash) throw new ComputeError("request_conflict", "Idempotency-Key has a different request", 409);
      if (replay.deleted) throw new ComputeError("job_expired", "Calculation was deleted or expired", 410);
      return { jobId: replay.id };
    }
    const environment = this.environment();
    const records = this.store.summaries();
    const pending = records.filter(record => !record.deleted && ["queued", "running"].includes(record.status));
    const reserved = COMPUTE_RESULT_RESERVATION + Buffer.byteLength(JSON.stringify(request));
    if (pending.length >= COMPUTE_LIMITS.maxQueuedJobs + 1 || records.length >= 4096
      || records.reduce((sum, record) => sum + record.bytes + record.reserved, 0) + reserved > COMPUTE_LIMITS.maxStoreBytes) {
      throw new ComputeError("queue_full", "Compute queue or result storage is full", 429);
    }
    const job: ComputeJob = { jobId: randomUUID(), status: "queued", stage: "queued", queuedAt: new Date(this.now()).toISOString(),
      startedAt: null, finishedAt: null, expiresAt: null, resolvedAccelerator: "cpu", environmentRevision: environment.environmentRevision, cancelRequested: false };
    this.store.add(job, principal, key, hash, request, this.now(), reserved);
    this.schedule();
    return { jobId: job.jobId };
  }
  private find(id: string, principal: string): ComputeRecord {
    const record = this.store.record(id);
    if (!record || record.principal !== principal) throw new ComputeError("not_found", "Calculation was not found", 404);
    if (record.deleted) throw new ComputeError("job_expired", "Calculation was deleted or expired", 410);
    return record;
  }
  get(id: string, principal: string): ComputeJob { this.prune(); return JSON.parse(this.find(id, principal).state) as ComputeJob; }
  artifact(id: string, artifactId: string, principal: string) {
    const job = this.get(id, principal);
    if (job.status !== "completed") throw new ComputeError("artifact_not_ready", "Calculation has no completed artifacts", 409);
    const metadata = job.result?.artifacts.find(artifact => artifact.id === artifactId);
    const artifact = metadata && this.store.artifact(id, artifactId);
    if (!metadata || !artifact) throw new ComputeError("not_found", "Artifact was not found", 404);
    return { ...metadata, data: artifact.data };
  }
  async cancel(id: string, principal: string): Promise<ComputeJob> {
    const job = this.get(id, principal);
    if (job.status === "queued") { this.finish(job, "cancelled", "Calculation cancelled"); return this.get(id, principal); }
    if (job.status !== "running") return job;
    const active = this.active;
    if (!active || active.id !== id) { this.quarantine(); throw new ComputeError("unavailable", "Calculation execution state is inconsistent", 503); }
    job.cancelRequested = true; delete job.progress; this.store.save(job);
    active.abort.abort();
    await this.waitFor(active.done, 2000);
    return this.get(id, principal);
  }
  async delete(id: string, principal: string): Promise<ComputeJob | undefined> {
    const job = this.get(id, principal);
    if (job.status === "queued" || job.status === "running") return this.cancel(id, principal);
    this.store.remove(this.find(id, principal)); return undefined;
  }
  private finish(job: ComputeJob, code: string, message: string): void {
    const error = computeErrorCodeSchema.safeParse(code);
    job.status = code === "cancelled" ? "cancelled" : "failed"; job.stage = job.status;
    job.finishedAt = new Date(this.now()).toISOString(); job.expiresAt = new Date(this.now() + COMPUTE_LIMITS.retentionSec * 1000).toISOString();
    job.error = { code: error.success ? error.data : "unavailable", message: Buffer.from(message).subarray(-8192).toString("utf8") };
    job.cancelRequested = false; delete job.result; delete job.progress;
    this.store.save(job);
  }
  private schedule(): void {
    queueMicrotask(() => {
      try {
        if (!this.available || this.active) return;
        const record = this.store.nextQueued();
        if (!record) return;
        const abort = new AbortController();
        const done = this.run(record, abort.signal).catch(() => this.quarantine()).finally(() => { this.active = undefined; this.schedule(); });
        this.active = { id: record.id, abort, done };
      } catch { this.quarantine(); }
    });
  }
  private async run(record: ComputeRecord, signal: AbortSignal): Promise<void> {
    const job = JSON.parse(record.state) as ComputeJob;
    job.status = "running"; job.stage = "starting"; job.startedAt = new Date(this.now()).toISOString(); this.store.save(job);
    const update = (apply: (current: ComputeJob) => void) => {
      if (this.closed) return;
      const current = JSON.parse(this.store.record(job.jobId)!.state) as ComputeJob;
      if (current.status !== "running" || current.cancelRequested) return;
      apply(current); this.store.save(current);
    };
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = parseComputeRequest(JSON.parse(record.request!));
      const watchdog = new AbortController();
      deadline = setTimeout(() => watchdog.abort(new ComputeError("timeout", "Calculation exceeded its wall time limit")),
        Math.max(0, Date.parse(job.startedAt!) + request.timeoutSec * 1000 - this.now()));
      const executionSignal = AbortSignal.any([signal, watchdog.signal]);
      const environment = await this.options.executor.environment(executionSignal);
      if (environment.environmentRevision !== job.environmentRevision) throw new ComputeError("unavailable", "CPU environment changed after admission", 503);
      const result = await this.options.executor.execute(request, { signal: executionSignal,
        progress: progress => update(current => { current.progress = progress; }),
        stage: stage => update(current => { current.stage = stage; }),
      });
      const current = JSON.parse(this.store.record(job.jobId)!.state) as ComputeJob;
      if (current.cancelRequested) { this.finish(current, "cancelled", "Calculation cancelled"); return; }
      if (this.closed) throw new ComputeError("unavailable", "Compute stopped during calculation", 503);
      executionSignal.throwIfAborted();
      const artifacts = result.artifacts.map(item => ({ ...item, id: randomUUID() }));
      current.status = "completed"; current.stage = "completed"; current.finishedAt = new Date(this.now()).toISOString();
      current.expiresAt = new Date(this.now() + COMPUTE_LIMITS.retentionSec * 1000).toISOString();
      current.result = { ...result, artifacts: artifacts.map(({ data, ...item }) => ({ ...item, bytes: data.byteLength })) };
      this.store.complete(current, artifacts);
    } catch (error) {
      const current = JSON.parse(this.store.record(job.jobId)!.state) as ComputeJob;
      if (error instanceof ComputeError && error.executionUncertain) {
        this.quarantine(); this.finish(current, "unavailable", "Calculation termination could not be confirmed");
      } else if (current.cancelRequested) this.finish(current, "cancelled", "Calculation cancelled");
      else if (this.closed) this.finish(current, "unavailable", "Compute stopped during calculation");
      else {
        this.finish(current, error instanceof ComputeError ? error.code : "unavailable", error instanceof ComputeError ? error.message : "Calculation could not complete");
        if (!(error instanceof ComputeError) || error.code === "unavailable") this.quarantine();
      }
    } finally { if (deadline) clearTimeout(deadline); }
  }
  private prune(): void {
    for (const record of this.store.summaries()) {
      if (record.deleted) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) <= this.now()) this.store.remove(this.store.record(record.id)!);
      else if (record.status === "queued" && Date.parse(record.queuedAt) + COMPUTE_LIMITS.maxQueueWaitSec * 1000 <= this.now()) {
        this.finish(JSON.parse(this.store.record(record.id)!.state) as ComputeJob, "queue_timeout", "Calculation queue wait expired");
      }
    }
    this.store.pruneReceipts(this.now());
  }
  private async waitFor(done: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([done.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; if (this.timer) clearInterval(this.timer);
      this.active?.abort.abort();
      if (this.active && !await this.waitFor(this.active.done, 2500)) this.quarantine();
      try { this.store.close(); } catch { this.quarantine(); }
    })();
  }
}
