import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, statfs } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { imageImportStatusSchema, storedImageArtifactMetadataSchema, type ImageArtifact, type ImageImportStatus } from "@larm/core";
import type { GeneratedImageArtifactRetention } from "@larm/backends";
import { ImageImportError, validateImportedWebp } from "./image-import-validation";

const receiptSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  result: imageImportStatusSchema,
  metadata: storedImageArtifactMetadataSchema.optional(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
// Receipts are retained indefinitely. Exhaustion rejects new keys, never evicts old keys.
export const IMAGE_IMPORT_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const RECEIPT_RESERVATION = 16 * 1024;

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function safeDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error("unsafe image import directory");
  }
  await syncDirectory(dirname(path));
}

async function durableWrite(path: string, bytes: string | Buffer): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

function publicArtifact(metadata: NonNullable<Receipt["metadata"]>): ImageArtifact {
  const { file: _file, ...artifact } = metadata;
  return { ...artifact, contentUrl: `/v1/image-artifacts/${metadata.id}/content` };
}

function storageError(error: unknown): ImageImportError {
  if (error instanceof ImageImportError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOSPC" || code === "EDQUOT"
    ? new ImageImportError("image_storage_full", "image storage has insufficient capacity", 507)
    : new ImageImportError("image_storage_failed", "image storage operation failed", 500);
}

/** Called inside ImageArtifactManager's mutation queue, shared with reads, deletion and pruning. */
export class ImageImportStore {
  private readonly root: string;
  private readonly staging: string;

  constructor(private readonly artifactRoot: string, private readonly retention: GeneratedImageArtifactRetention) {
    this.root = join(artifactRoot, ".image-imports");
    this.staging = join(this.root, "staging");
  }

  async initialize(): Promise<void> {
    // Validate the existing root through the same ownership/path checks as the library.
    await this.retention.list();
    await safeDirectory(this.root);
    await safeDirectory(this.staging);
    for (const entry of await readdir(this.root)) {
      if (/^[a-f0-9]{64}\.json$/.test(entry)) {
        const path = join(this.root, entry);
        const receipt = await this.read(path);
        if (receipt) await this.recover(path, receipt);
      } else if (/^[a-f0-9]{64}\.json\.tmp-[a-f0-9-]+$/.test(entry)) {
        await rm(join(this.root, entry), { force: true });
      }
    }
    // Staging is private and never appears in the image library.
    for (const entry of await readdir(this.staging)) {
      if (/^image_[a-f0-9]{32}$/.test(entry)) await rm(join(this.staging, entry), { recursive: true, force: true });
    }
  }

  private path(principal: string, requestId: string): string {
    const key = createHash("sha256").update(`${principal}\0${requestId}`).digest("hex");
    return join(this.root, `${key}.json`);
  }

  private artifactDirectory(metadata: NonNullable<Receipt["metadata"]>): string {
    return join(this.artifactRoot, metadata.createdAt.slice(0, 4), metadata.createdAt.slice(5, 7), metadata.id);
  }

  private async read(path: string): Promise<Receipt | undefined> {
    const info = await lstat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return undefined;
    if (!info.isFile() || info.isSymbolicLink() || info.size > RECEIPT_RESERVATION) throw new Error("invalid image import receipt");
    return receiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  }

  private async save(path: string, receipt: Receipt): Promise<void> {
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      await durableWrite(temporary, JSON.stringify(receiptSchema.parse(receipt)));
      await rename(temporary, path);
      await syncDirectory(this.root);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async recover(path: string, receipt: Receipt): Promise<Receipt> {
    if (receipt.result.status !== "pending") return receipt;
    let published = false;
    if (receipt.metadata) {
      const metadata = receipt.metadata;
      const directory = this.artifactDirectory(metadata);
      // Use the existing scanner's symlink/ownership checks before reading content.
      const stored = (await this.retention.list()).find((entry) => entry.artifactId === metadata.id);
      if (stored?.directory === directory) {
        const content = await readFile(join(directory, metadata.file));
        published = content.length === metadata.bytes
          && createHash("sha256").update(content).digest("hex") === metadata.sha256
          && JSON.stringify(storedImageArtifactMetadataSchema.parse(JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")))) === JSON.stringify(metadata);
        if (!published) throw new Error("published image import is inconsistent");
        await syncDirectory(directory);
        await syncDirectory(dirname(directory));
      }
      await rm(join(this.staging, metadata.id), { recursive: true, force: true });
    }
    receipt.result = published ? {
      ...receipt.result, status: "succeeded", updatedAt: new Date().toISOString(), artifact: publicArtifact(receipt.metadata!),
    } : {
      ...receipt.result, status: "failed", updatedAt: new Date().toISOString(),
      error: { code: "image_import_interrupted", message: "import interrupted before publication; use a new UUID to try again", httpStatus: 409 },
    };
    await this.save(path, receipt);
    return receipt;
  }

  async lookup(principal: string, requestId: string): Promise<ImageImportStatus | undefined> {
    try {
      const path = this.path(principal, requestId);
      let receipt = await this.read(path);
      if (!receipt) return undefined;
      receipt = await this.recover(path, receipt);
      if (receipt.result.status === "succeeded" && receipt.metadata
        && !(await this.retention.list()).some((entry) => entry.artifactId === receipt.metadata!.id)) {
        receipt.result = { ...receipt.result, status: "deleted", updatedAt: new Date().toISOString() };
        delete receipt.result.artifact;
        await this.save(path, receipt);
      }
      return receipt.result;
    } catch (error) { throw storageError(error); }
  }

  async import(principal: string, requestId: string, bytes: Buffer, mimeType: string): Promise<ImageArtifact> {
    const path = this.path(principal, requestId);
    const fingerprint = createHash("sha256").update(mimeType).update("\0").update(bytes).digest("hex");
    let receipt: Receipt | undefined;
    let stage: string | undefined;
    let published = false;
    let ownsReceipt = false;
    try {
      receipt = await this.read(path);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ImageImportError("idempotency_conflict", "Idempotency-Key was used with different image content or MIME type", 409);
        const result = (await this.lookup(principal, requestId))!;
        if (result.status === "succeeded") return result.artifact!;
        if (result.status === "deleted") throw new ImageImportError("image_artifact_deleted", "imported image has been deleted; this key cannot recreate it", 410);
        const error = result.error!;
        throw new ImageImportError(error.code, error.message, error.httpStatus as ImageImportError["status"]);
      }
      const journalBytes = (await Promise.all((await readdir(this.root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map(async (name) => (await lstat(join(this.root, name))).size))).reduce((sum, size) => sum + size, 0);
      if (journalBytes + RECEIPT_RESERVATION > IMAGE_IMPORT_JOURNAL_MAX_BYTES) {
        throw new ImageImportError("image_import_journal_full", "image import receipt storage is full", 507);
      }
      const now = new Date().toISOString();
      receipt = { fingerprint, result: { requestId, status: "pending", createdAt: now, updatedAt: now } };
      ownsReceipt = true;
      await this.save(path, receipt);
      const dimensions = await validateImportedWebp(bytes, mimeType);
      const metadata = storedImageArtifactMetadataSchema.parse({
        id: `image_${randomUUID().replaceAll("-", "")}`, createdAt: now,
        format: "webp", mimeType: "image/webp", file: "image.webp", ...dimensions,
        bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const metadataJson = JSON.stringify(metadata);
      const requiredBytes = bytes.length + Buffer.byteLength(metadataJson);
      const usedBytes = (await this.retention.list()).reduce((sum, entry) => sum + entry.bytes, 0);
      const disk = await statfs(this.artifactRoot);
      if (usedBytes + requiredBytes > this.retention.maxBytes || disk.bavail * disk.bsize < requiredBytes + RECEIPT_RESERVATION) {
        throw new ImageImportError("image_storage_full", "image storage has insufficient capacity", 507);
      }
      receipt.metadata = metadata;
      await this.save(path, receipt);
      stage = join(this.staging, metadata.id);
      await safeDirectory(stage);
      await durableWrite(join(stage, metadata.file), bytes);
      await durableWrite(join(stage, "metadata.json"), metadataJson);
      await syncDirectory(stage);
      const year = join(this.artifactRoot, now.slice(0, 4));
      const month = join(year, now.slice(5, 7));
      await safeDirectory(year);
      await safeDirectory(month);
      await rename(stage, this.artifactDirectory(metadata));
      published = true;
      await syncDirectory(month);
      await syncDirectory(this.staging);
      receipt.result = { ...receipt.result, status: "succeeded", updatedAt: new Date().toISOString(), artifact: publicArtifact(metadata) };
      await this.save(path, receipt);
      return receipt.result.artifact!;
    } catch (error) {
      const failure = storageError(error);
      // A published artifact with a pending receipt is recovered by lookup/startup.
      // Never remove it or repeat publication after an ambiguous response.
      if (ownsReceipt && receipt?.result.status === "pending" && !published) {
        if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        receipt.result = { ...receipt.result, status: "failed", updatedAt: new Date().toISOString(),
          error: { code: failure.code, message: failure.message, httpStatus: failure.status } };
        await this.save(path, receipt).catch(() => undefined);
      }
      throw failure;
    }
  }
}
