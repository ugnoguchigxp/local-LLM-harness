import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { meshGenerationRequestSchema, meshJobSchema, meshAssetSchema, meshUrls, inspectMeshGlb,
  type MeshGenerationRequest, type MeshJob, type MeshAsset } from "@larm/core";
import { MeshStore, MeshError, durableJson, meshHash, safeFile } from "./mesh-store";
import type { MeshProvider } from "./mesh-provider";

const recordSchema = z.object({ key: z.string().uuid(), requestHash: z.string(), job: meshJobSchema,
  request: meshGenerationRequestSchema.optional(), sourceMimeType: z.enum(["image/png", "image/webp"]).optional(), sourceImageId: z.string().optional() });
type Record = z.infer<typeof recordSchema>;
const terminal = (job: MeshJob) => ["completed", "failed", "cancelled"].includes(job.status);
const uuid = () => randomUUID().replaceAll("-", "");
const reservation = 300 * 1024 ** 2;
export class MeshManager {
  private records = new Map<string, Record>();
  private keys = new Map<string, Record>();
  private listeners = new Map<string, Set<(job: MeshJob) => void>>();
  private workloads = new Map<string, { admit: () => void; begin: () => () => void }>();
  private controllers = new Map<string, AbortController>();
  private tail = Promise.resolve();
  private draining?: Promise<void>;
  private closed = false;
  private runningDone?: { id: string; promise: Promise<void>; resolve: () => void };
  private storageReady = false;
  private janitor?: ReturnType<typeof setInterval>;
  constructor(readonly store: MeshStore, readonly provider: MeshProvider, private readonly options: {
    copyImage: (id: string) => Promise<{ data: Buffer; mimeType: "image/png" | "image/webp" } | undefined>;
    beginWorkload?: () => () => void; admission?: () => void;
    captureWorkload?: () => { admit: () => void; begin: () => () => void };
    workerAvailable?: () => boolean;
    queueTimeoutMs?: number; runTimeoutMs?: number;
  }) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.tail.then(fn); this.tail = p.then(() => {}, () => {}); return p; }
  private recordPath(id: string) { return join(this.store.root, "jobs", `${id}.json`); }
  private workPath(id: string) { return join(this.store.root, "work", id); }
  async initialize() {
    try { await this.store.initialize(); this.storageReady = true; }
    catch { console.error("3D storage is unavailable; generation disabled"); return; }
    for (const file of await readdir(join(this.store.root, "jobs"))) {
      if (!/^meshjob_[a-f0-9]{32}\.json$/.test(file)) continue;
      try {
        const r = recordSchema.parse(JSON.parse((await safeFile(this.store.root, join(this.store.root, "jobs", file), 256 * 1024)).toString()));
        if (`${r.job.jobId}.json` !== file) continue;
        this.records.set(r.job.jobId, r); this.keys.set(r.key, r);
        const asset = [...this.store.assets.values()].find((a) => a.asset.jobId === r.job.jobId)?.asset;
        if (asset) r.job = { ...r.job, status: "completed", stage: "completed", assetId: asset.id, asset, error: undefined };
        else if (r.job.assetId || r.job.deleted || this.store.deletedJobs.has(r.job.jobId)) this.redact(r);
        else if (!terminal(r.job) || r.job.error?.code === "worker_stop_failed") {
          // Startup recovery runs only after main has stopped orphan workers.
          if (this.options.workerAvailable?.() === false) {
            r.job = { ...r.job, status: "failed", stage: "failed", error: { code: "worker_stop_failed", message: "worker stop is unconfirmed; saved output remains private" } };
          } else {
          const prepared = await safeFile(this.store.root, join(this.workPath(r.job.jobId), "prepared.json"), 128 * 1024).catch(() => undefined);
          if (prepared) {
            const saved = meshAssetSchema.parse(JSON.parse(prepared.toString()));
            if (saved.jobId !== r.job.jobId) throw new Error("invalid recovery job");
            const glb = await safeFile(this.store.root, join(this.workPath(r.job.jobId), "model.glb"), 256 * 1024 ** 2);
            inspectMeshGlb(glb); if (meshHash(glb) !== saved.sha256) throw new Error("invalid recovery hash");
            const published = await this.store.publish(this.workPath(r.job.jobId), saved);
            r.job = { ...r.job, status: "completed", stage: "completed", assetId: saved.id, asset: published, error: undefined };
          } else r.job = { ...r.job, status: "failed", stage: "failed", error: { code: "interrupted", message: "generation interrupted by restart; no automatic regeneration" } };
          }
        }
        if (r.job.error?.code !== "worker_stop_failed") await rm(this.workPath(r.job.jobId), { recursive: true, force: true });
        await this.save(r);
      } catch { console.warn("invalid or unrecoverable 3D job record retained privately"); }
    }
    this.janitor = setInterval(() => { void this.maintain().catch(() => console.warn("3D maintenance deferred: storage unavailable")); }, 300_000);
    this.janitor.unref?.();
    const protectedWork = new Set([...this.records.values()].filter((r) => r.job.error?.code === "worker_stop_failed").map((r) => r.job.jobId));
    for (const entry of await readdir(join(this.store.root, "work"))) if (!protectedWork.has(entry)) await rm(join(this.store.root, "work", entry), { recursive: true, force: true });
  }
  private async maintain() {
    await this.serial(async () => {
      for (const [id, r] of this.records) {
        if (!terminal(r.job) || r.job.error?.code === "worker_stop_failed") continue;
        await rm(this.workPath(id), { recursive: true, force: true });
        // Keep key/hash tombstones, while removing failed/cancelled prompt payloads after a day.
        if (r.job.status !== "completed" && Date.now() - Date.parse(r.job.updatedAt) > 86_400_000 && r.request) {
          r.request = undefined; r.sourceImageId = undefined; r.sourceMimeType = undefined; await this.save(r);
        }
      }
    });
  }
  private async save(r: Record) { await durableJson(this.recordPath(r.job.jobId), r); }
  private async update(r: Record, patch: Partial<MeshJob>) {
    await this.serial(async () => { if (r.job.deleted) return; r.job = meshJobSchema.parse({ ...r.job, ...patch, updatedAt: new Date().toISOString() }); await this.save(r); this.emit(r.job); });
  }
  private emit(job: MeshJob) { for (const fn of this.listeners.get(job.jobId) ?? []) fn(structuredClone(job)); }
  get(id: string) { const r = this.records.get(id); return r ? structuredClone(r.job) : undefined; }
  subscribe(id: string, fn: (job: MeshJob) => void) {
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(fn); this.listeners.set(id, listeners);
    return () => { listeners.delete(fn); if (!listeners.size) this.listeners.delete(id); };
  }
  async create(value: unknown, key: string) {
    const parsedKey = z.string().uuid().safeParse(key);
    if (!parsedKey.success) throw new MeshError("invalid_idempotency_key", 400, "Idempotency-Key must be a UUID");
    const workload = this.options.captureWorkload?.();
    const request = meshGenerationRequestSchema.parse(value), hash = meshHash(Buffer.from(JSON.stringify(request)));
    return this.serial(async () => {
      const previous = this.keys.get(key);
      if (previous) { if (previous.requestHash !== hash) throw new MeshError("idempotency_conflict", 409, "key already used for another request"); return structuredClone(previous.job); }
      if (!this.storageReady || this.closed || this.options.workerAvailable?.() === false) throw new MeshError("storage_unavailable", 503, "3D generation unavailable");
      this.options.admission?.();
      const reserved = [...this.records.values()].filter((r) => !terminal(r.job) || r.job.error?.code === "worker_stop_failed").length;
      if (reserved >= 4) throw new MeshError("queue_full", 429, "3D generation queue is full");
      await this.store.capacity((reserved + 1) * reservation);
      const id = `meshjob_${uuid()}`, now = new Date().toISOString();
      const r: Record = { key, requestHash: hash, request, job: { jobId: id, status: "queued", stage: "queued", createdAt: now, updatedAt: now,
        statusUrl: `/v1/3d/generations/${id}`, eventsUrl: `/v1/3d/generations/${id}/events` } };
      await mkdir(this.workPath(id), { mode: 0o700 });
      try {
        if (request.source.type === "image-artifact") await this.pinImage(r, request.source.id);
        await this.save(r); this.records.set(id, r); this.keys.set(key, r); if (workload) this.workloads.set(id, workload);
      } catch (e) { await rm(this.workPath(id), { recursive: true, force: true }); throw e; }
      queueMicrotask(() => this.startDrain());
      return structuredClone(r.job);
    });
  }
  private async pinImage(r: Record, id: string) {
    const source = await this.options.copyImage(id);
    if (!source || source.data.length > 20 * 1024 ** 2) throw new MeshError("invalid_source", 400, "image artifact unavailable or exceeds limits");
    const f = await open(join(this.workPath(r.job.jobId), "source.image"), "wx", 0o600);
    try { await f.writeFile(source.data); await f.sync(); } finally { await f.close(); }
    r.sourceMimeType = source.mimeType; r.sourceImageId = id;
  }
  private startDrain() {
    if (this.draining || this.closed) return;
    this.draining = this.drain().catch(() => { this.storageReady = false; this.closed = true; console.error("3D job persistence failed; new generation disabled"); }).finally(() => { this.draining = undefined; if (!this.closed && [...this.records.values()].some((r) => r.job.status === "queued")) this.startDrain(); });
  }
  private async drain() {
    while (!this.closed) {
      const r = [...this.records.values()].find((r) => r.job.status === "queued"); if (!r) return;
      let finishRunning!: () => void;
      this.runningDone = { id: r.job.jobId, promise: new Promise<void>((resolve) => { finishRunning = resolve; }), resolve: () => finishRunning() };
      const controller = new AbortController(); this.controllers.set(r.job.jobId, controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.runTimeoutMs ?? 1800_000)]);
      let finish: (() => void) | undefined, preserve = false;
      try {
        if (Date.now() - Date.parse(r.job.createdAt) > (this.options.queueTimeoutMs ?? 600_000)) throw new MeshError("queue_timeout", 503, "3D queue wait expired");
        const workload = this.workloads.get(r.job.jobId);
        workload?.admit();
        finish = workload ? workload.begin() : this.options.beginWorkload?.();
        const request = r.request!;
        await this.update(r, { status: "running", stage: request.source.type === "prompt" ? "image" : "waiting_gpu" });
        if (request.source.type === "prompt") { const image = await this.provider.image(request, signal); await this.pinImage(r, image); await this.save(r); }
        await this.provider.generate(r.job.jobId, request.seed, signal, async (stage) => {
          // Validation is persisted before releasing the worker, so a stop failure is recoverable.
          if (stage === "stopping") {
            const path = join(this.workPath(r.job.jobId), "model.glb");
            if (await stat(path).catch(() => undefined)) {
              await this.update(r, { stage: "validating" });
              const asset = await this.prepare(r); await durableJson(join(this.workPath(r.job.jobId), "prepared.json"), asset);
            }
          }
          await this.update(r, { stage });
        });
        signal.throwIfAborted();
        const prepared = meshAssetSchema.parse(JSON.parse(await readFile(join(this.workPath(r.job.jobId), "prepared.json"), "utf8")));
        const asset = await this.store.publish(this.workPath(r.job.jobId), prepared);
        await this.update(r, { status: "completed", stage: "completed", assetId: asset.id, asset });
      } catch (e) {
        const error = e instanceof MeshError ? e : new MeshError(signal.aborted ? "cancelled_or_timeout" : "generation_failed", 503, signal.aborted ? "generation cancelled or timed out" : "3D generation failed; inspect restricted logs");
        preserve = error.code === "worker_stop_failed";
        console.warn(`3D job ${r.job.jobId} failed: ${error.code}`);
        await this.update(r, { status: controller.signal.aborted && !preserve ? "cancelled" : "failed", stage: controller.signal.aborted && !preserve ? "cancelled" : "failed", error: { code: error.code, message: error.message } });
      } finally {
        this.controllers.delete(r.job.jobId); this.workloads.delete(r.job.jobId); finish?.();
        if (!preserve) await rm(this.workPath(r.job.jobId), { recursive: true, force: true });
        this.runningDone?.resolve(); this.runningDone = undefined;
      }
    }
  }
  private async prepare(r: Record): Promise<MeshAsset> {
    const path = this.workPath(r.job.jobId), request = r.request!;
    const glb = await safeFile(this.store.root, join(path, "model.glb"), 256 * 1024 ** 2);
    const source = await safeFile(this.store.root, join(path, "source.image"), 20 * 1024 ** 2);
    const geometry = inspectMeshGlb(glb), id = `mesh_${uuid()}`;
    return meshAssetSchema.parse({ id, jobId: r.job.jobId, createdAt: new Date().toISOString(), title: request.title, tags: request.tags,
      ...(request.source.type === "prompt" ? { prompt: request.source.prompt } : {}), sourceImageId: r.sourceImageId,
      model: request.model, resolution: request.resolution, seed: request.seed, steps: 12, bytes: glb.length, sha256: meshHash(glb), sourceSha256: meshHash(source),
      sourceMimeType: r.sourceMimeType, geometry, provenance: { engine: "trellis.cpp v0.8.1 Vulkan", engineCommit: "c0bed38c1578f7e36e3e50c8ff1e38fa0d47583f", weightsRevision: "a57397bd3d351599d9729fc144b3f87c3f87d65b", imported: false },
      warnings: ["Generated texture may be darker than the source image.", "Topology is unverified; inspect duplicate faces and non-manifold edges before editing or printing.", "Embedded WebP textures require EXT_texture_webp support (Blender 4.0+).", "DINOv3 weights have separate license terms."], ...meshUrls(id) });
  }
  async cancel(id: string) {
    await this.serial(async () => {
      const r = this.records.get(id); if (!r || terminal(r.job)) return;
      const controller = this.controllers.get(id);
      if (controller) { controller.abort(); return; }
      r.job = { ...r.job, status: "cancelled", stage: "cancelled", updatedAt: new Date().toISOString() };
      this.workloads.delete(id);
      await this.save(r); await rm(this.workPath(id), { recursive: true, force: true }); this.emit(r.job);
    });
    if (this.runningDone?.id === id) await this.runningDone.promise;
    return this.get(id);
  }
  private redact(r: Record) { r.request = undefined; r.sourceImageId = undefined; r.sourceMimeType = undefined;
    r.job = { jobId: r.job.jobId, createdAt: r.job.createdAt, updatedAt: new Date().toISOString(), status: "completed", stage: "deleted", deleted: true, statusUrl: r.job.statusUrl, eventsUrl: r.job.eventsUrl }; }
  async deleteAsset(id: string) {
    const jobId = this.store.get(id)?.jobId;
    return this.store.remove(id, () => this.serial(async () => { for (const r of this.records.values()) if (r.job.assetId === id || (jobId !== undefined && r.job.jobId === jobId)) { this.redact(r); await this.save(r); this.emit(r.job); } }));
  }
  async close() { this.closed = true; if (this.janitor) clearInterval(this.janitor); for (const c of this.controllers.values()) c.abort(); await this.draining; await this.tail; }
}
