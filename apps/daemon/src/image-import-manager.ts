import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, realpath, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { IMAGE_IMPORT_LIMITS, imageImportRequestIdSchema, imageImportReceiptSchema, storedImageArtifactMetadataSchema, type ImageImportReceipt } from "@larm/core";
import { ImageImportError, type ImageNormalizer } from "@larm/backends";
import type { ImageArtifactManager } from "./image-artifact-manager";
import { durableJson, safeFile, syncDirectory } from "./mesh-store";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const recordSchema = z.object({
  version: z.literal(1), principal: z.string().regex(/^[a-f0-9]{64}$/), requestId: imageImportRequestIdSchema,
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  status: z.enum(["pending", "succeeded", "failed"]), artifactId: z.string().regex(/^image_[a-f0-9]{32}$/),
  prepared: storedImageArtifactMetadataSchema.optional(), deleted: z.boolean().default(false),
  error: z.object({ code: z.string(), message: z.string(), status: z.number().int() }).optional(),
}).strict();
type Record = z.infer<typeof recordSchema>;

/** One local writer, durable receipts, private stages and atomic artifact publication. */
export class ImageImportManager {
  readonly root: string;
  ready = false;
  private closing = false;
  private records = new Map<string, Record>();
  private tail = Promise.resolve();
  private workTail = Promise.resolve();
  private tasks = new Map<string, Promise<void>>();
  constructor(private readonly images: ImageArtifactManager, private readonly normalize: ImageNormalizer,
    private readonly now: () => number = Date.now) { this.root = join(resolve(images.artifactRoot), ".imports"); }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(fn); this.tail = operation.then(() => {}, () => {}); return operation;
  }
  private key(principal: string, requestId: string) { return hash(`${principal}:${requestId}`); }
  private path(key: string) { return join(this.root, "receipts", `${key}.json`); }
  private async save(key: string, record: Record) {
    await durableJson(this.path(key), recordSchema.parse(record)); this.records.set(key, structuredClone(record));
  }
  async initialize() {
    try {
      for (const dir of [this.root, join(this.root, "receipts"), join(this.root, "work")]) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        if (await realpath(dir) !== dir) throw new Error("unsafe image import storage");
      }
      for (const dir of [join(this.root, "receipts"), join(this.root, "work"), this.root, resolve(this.images.artifactRoot)]) await syncDirectory(dir);
      for (const name of await readdir(join(this.root, "receipts"))) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) {
          if (name.endsWith(".tmp")) { await rm(join(this.root, "receipts", name), { force: true }); continue; }
          throw new Error("unknown receipt entry");
        }
        const record = recordSchema.parse(JSON.parse((await safeFile(this.root, join(this.root, "receipts", name), 64 * 1024)).toString()));
        const key = this.key(record.principal, record.requestId);
        if (name !== `${key}.json`) throw new Error("receipt identity mismatch");
        this.records.set(key, record);
      }
      // No pending import is re-executed after restart. A rename before a lost
      // final receipt is recovered only from an already published matching hash.
      for (const [key, record] of this.records) {
        if (record.deleted) await this.images.delete(record.artifactId);
        if (record.status !== "pending") continue;
        const content = await this.images.copyForMesh(record.artifactId);
        if (record.deleted || record.prepared && content && hash(content.data) === record.prepared.sha256) record.status = "succeeded";
        else { record.status = "failed"; record.error = { code: "image_import_interrupted", message: "image import was interrupted; use a new key only after confirming this failure", status: 503 }; }
        await this.save(key, record);
      }
      // Remove abandoned private bytes only after every receipt was readable.
      for (const name of await readdir(join(this.root, "work"))) await rm(join(this.root, "work", name), { recursive: true, force: true });
      this.ready = true;
    } catch { this.ready = false; /* Saved images remain available; never reset an unreadable journal. */ }
  }
  private requireReady() { if (!this.ready) throw new ImageImportError("image_import_unavailable", 503); }
  private principal(value: string) { return hash(value); }
  async receipt(principal: string, requestId: string): Promise<ImageImportReceipt> {
    this.requireReady(); requestId = imageImportRequestIdSchema.parse(requestId).toLowerCase();
    const record = this.records.get(this.key(this.principal(principal), requestId));
    if (!record) throw new ImageImportError("image_import_not_found", 404);
    return this.publicReceipt(record);
  }
  private async publicReceipt(record: Record): Promise<ImageImportReceipt> {
    if (this.now() >= Date.parse(record.expiresAt)) throw new ImageImportError("image_import_receipt_expired", 410);
    const base = { requestId: record.requestId, createdAt: record.createdAt, expiresAt: record.expiresAt, statusUrl: `/v1/image-imports/${record.requestId}` };
    if (record.status === "pending") return imageImportReceiptSchema.parse({ ...base, status: "pending" });
    if (record.status === "failed") return imageImportReceiptSchema.parse({ ...base, status: "failed", error: { code: record.error!.code, message: record.error!.message } });
    const artifact = record.deleted ? undefined : await this.images.get(record.artifactId);
    return imageImportReceiptSchema.parse(artifact ? { ...base, status: "succeeded", deleted: false, artifact }
      : { ...base, status: "succeeded", deleted: true, artifactId: record.artifactId });
  }
  async import(principal: string, requestId: string, data: Uint8Array, mimeType: string, waitMs = 1000): Promise<{ receipt: ImageImportReceipt; status: number }> {
    this.requireReady(); if (this.closing) throw new ImageImportError("image_import_draining", 503);
    requestId = imageImportRequestIdSchema.parse(requestId).toLowerCase();
    const owner = this.principal(principal), key = this.key(owner, requestId), digest = hash(data);
    const first = await this.serialized(async () => {
      this.requireReady();
      const existing = this.records.get(key);
      if (existing) {
        if (existing.sourceSha256 !== digest) throw new ImageImportError("idempotency_conflict", 409);
        if (this.now() >= Date.parse(existing.expiresAt)) throw new ImageImportError("image_import_receipt_expired", 410);
        return false;
      }
      if (data.length > IMAGE_IMPORT_LIMITS.inputBytes) throw new ImageImportError("image_input_too_large", 413);
      if (this.tasks.size >= 4) throw new ImageImportError("image_import_queue_full", 429);
      if (this.records.size >= 100_000) throw new ImageImportError("image_import_receipt_capacity", 507);
      const record: Record = { version: 1, principal: owner, requestId, sourceSha256: digest,
        createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + IMAGE_IMPORT_LIMITS.receiptTtlMs).toISOString(),
        status: "pending", artifactId: `image_${randomUUID().replaceAll("-", "")}`, deleted: false };
      try { await this.save(key, record); }
      catch (error) { this.ready = false; throw this.storageError(error); }
      const task = this.workTail.then(() => this.run(key, data, mimeType));
      this.workTail = task.catch(() => {});
      this.tasks.set(key, task);
      void task.finally(() => this.tasks.delete(key)).catch(() => {});
      return true;
    });
    const task = this.tasks.get(key);
    if (task && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([task, new Promise<void>(r => { timer = setTimeout(r, waitMs); })]); }
      finally { clearTimeout(timer); }
    }
    this.requireReady();
    const record = this.records.get(key)!;
    const receipt = await this.publicReceipt(record);
    return { receipt, status: record.status === "pending" ? 202 : record.status === "failed" ? record.error!.status : first ? 201 : 200 };
  }
  private storageError(error: unknown) {
    if (error instanceof ImageImportError) return error;
    return new ImageImportError(["ENOSPC", "EDQUOT"].includes((error as NodeJS.ErrnoException)?.code ?? "") ? "image_storage_full" : "image_import_storage_unavailable",
      ["ENOSPC", "EDQUOT"].includes((error as NodeJS.ErrnoException)?.code ?? "") ? 507 : 503);
  }
  private async run(key: string, data: Uint8Array, mimeType: string) {
    const stage = join(this.root, "work", key);
    try {
      await mkdir(stage, { mode: 0o700 });
      const output = join(stage, "normalized");
      const normalized = await this.normalize(data, mimeType, output);
      const bytes = await safeFile(this.root, output, IMAGE_IMPORT_LIMITS.storedBytes);
      if (bytes.length !== normalized.bytes) throw new ImageImportError("image_decoder_unavailable", 503);
      await rename(output, join(stage, `image.${normalized.format}`));
      await this.serialized(async () => {
        const record = structuredClone(this.records.get(key)!);
        record.prepared = storedImageArtifactMetadataSchema.parse({ id: record.artifactId, createdAt: record.createdAt,
          ...normalized, mimeType: `image/${normalized.format}`, file: `image.${normalized.format}`, sha256: hash(bytes) });
        await durableJson(join(stage, "metadata.json"), record.prepared); await syncDirectory(stage);
        await this.save(key, record); // Intent durable before rename.
        await this.images.publishImport(stage, record.prepared);
        record.status = "succeeded"; await this.save(key, record);
      });
    } catch (error) {
      const failure = this.storageError(error);
      try {
        await this.serialized(async () => {
          const record = structuredClone(this.records.get(key)!);
          // If publication succeeded but final persistence failed, preserve
          // pending intent for restart recovery instead of reporting failure.
          if (await this.images.get(record.artifactId)) { this.ready = false; return; }
          record.status = "failed"; record.error = { code: failure.code, message: failure.message, status: failure.status };
          await this.save(key, record);
        });
      } catch { this.ready = false; }
    } finally { await rm(stage, { recursive: true, force: true }).catch(() => {}); }
  }
  async removeArtifact(id: string): Promise<boolean> {
    return this.serialized(async () => {
      if (!await this.images.get(id)) return false;
      // Durable intent precedes physical deletion; replay and restart cannot resurrect it.
      for (const [key, value] of this.records) {
        if (value.artifactId === id && !value.deleted) await this.save(key, { ...value, deleted: true });
      }
      return this.images.delete(id);
    });
  }
  beginDrain() { this.closing = true; }
  async drain() { await this.workTail; }
}
