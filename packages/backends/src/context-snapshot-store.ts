import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CONTEXT_SNAPSHOT_CHUNK_BYTES,
  contextSnapshotLookupKey,
  contextSnapshotManifestSchema,
  validateContextSnapshotIdentity,
  type ContextSnapshotChunk,
  type ContextSnapshotManifest,
} from "@larm/core";

const ENTRY_PATTERN = /^ctxsnap-[a-f0-9]{64}$/;
const PENDING_PATTERN = /^pending-[a-f0-9-]{36}\.bin$/;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const require = createRequire(import.meta.url);
let crc32cImplementation: ((value: Buffer) => number) | undefined;

function nativeCrc32c(value: Buffer): number {
  if (!crc32cImplementation) {
    try {
      const loaded = require("@node-rs/crc32") as { crc32c?: (input: Buffer) => number };
      if (typeof loaded.crc32c !== "function") throw new Error("crc32c export is missing");
      crc32cImplementation = loaded.crc32c;
    } catch (error) {
      throw new ContextSnapshotStoreError(
        "snapshot_io_failed",
        `native CRC32C is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return crc32cImplementation(value);
}

export class ContextSnapshotStoreError extends Error {
  constructor(
    readonly code:
      | "snapshot_root_unsafe"
      | "snapshot_manifest_invalid"
      | "snapshot_file_unsafe"
      | "snapshot_crc_mismatch"
      | "snapshot_identity_mismatch"
      | "snapshot_quota_exceeded"
      | "snapshot_free_floor"
      | "snapshot_io_failed",
    message: string,
  ) {
    super(message);
    this.name = "ContextSnapshotStoreError";
  }
}

type SnapshotIdentity = {
  dev: number;
  ino: number;
  size: number;
  ctimeMs: number;
};

function safeRoot(input: string): string {
  if (!input.startsWith("/")) {
    throw new ContextSnapshotStoreError("snapshot_root_unsafe", "snapshot root must be absolute");
  }
  const root = resolve(input);
  if (root === dirname(root)) {
    throw new ContextSnapshotStoreError("snapshot_root_unsafe", "snapshot root must not be a filesystem root");
  }
  return root;
}

function crcHex(bytes: Uint8Array): string {
  return nativeCrc32c(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    .toString(16)
    .padStart(8, "0");
}

function fileIdentity(value: { dev: number; ino: number; size: number; ctimeMs: number }): SnapshotIdentity {
  return { dev: value.dev, ino: value.ino, size: value.size, ctimeMs: value.ctimeMs };
}

function sameIdentity(left: SnapshotIdentity, right: SnapshotIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.ctimeMs === right.ctimeMs;
}

export type SnapshotExpectation = {
  principalScope: string;
  runtime: string;
  release: string;
  compatibilityKey: string;
  viewDigest: string;
  maxBytes: number;
};

export type SnapshotCommitInput = Omit<SnapshotExpectation, "maxBytes"> & {
  tokenCount: number;
  createdAt?: string;
};

export class LocalContextSnapshotStore {
  readonly root: string;
  private readonly manifests = new Map<string, ContextSnapshotManifest>();
  private readonly verified = new Map<string, SnapshotIdentity>();
  private initialized = false;
  private invalidEntries = 0;

  constructor(
    root: string,
    private readonly options: {
      maxBytes: number;
      freeFloorBytes: number;
      highWatermark?: number;
      lowWatermark?: number;
      perPrincipalMaxBytes?: number;
      now?: () => number;
    },
  ) {
    this.root = safeRoot(root);
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1
      || !Number.isSafeInteger(options.freeFloorBytes) || options.freeFloorBytes < 0
      || (options.perPrincipalMaxBytes !== undefined
        && (!Number.isSafeInteger(options.perPrincipalMaxBytes)
          || options.perPrincipalMaxBytes < 1
          || options.perPrincipalMaxBytes > options.maxBytes))) {
      throw new ContextSnapshotStoreError("snapshot_quota_exceeded", "snapshot quota options are invalid");
    }
    const high = options.highWatermark ?? 0.9;
    const low = options.lowWatermark ?? 0.8;
    if (!(low > 0 && low < high && high <= 1)) {
      throw new ContextSnapshotStoreError("snapshot_quota_exceeded", "snapshot watermarks are invalid");
    }
    if (crcHex(Buffer.from("123456789")) !== "e3069283") {
      throw new ContextSnapshotStoreError("snapshot_io_failed", "native CRC32C self-test failed");
    }
  }

  principalScope(principal: string): string {
    return createHash("sha256").update(principal).digest("hex");
  }

  pendingFilename(): string {
    return `pending-${crypto.randomUUID()}.bin`;
  }

  filename(entryId: string): string {
    if (!ENTRY_PATTERN.test(entryId)) {
      throw new ContextSnapshotStoreError("snapshot_file_unsafe", "snapshot entry ID is unsafe");
    }
    return `${entryId}.bin`;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootMetadata = await lstat(this.root);
    if (
      !rootMetadata.isDirectory()
      || rootMetadata.isSymbolicLink()
      || await realpath(this.root) !== this.root
      || (rootMetadata.mode & 0o077) !== 0
    ) {
      throw new ContextSnapshotStoreError("snapshot_root_unsafe", "snapshot root must be a private real directory");
    }
    const entries = await readdir(this.root, { withFileTypes: true });
    const committedFiles = new Set<string>();
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        this.invalidEntries += 1;
        continue;
      }
      if (PENDING_PATTERN.test(entry.name)) {
        await unlink(join(this.root, entry.name));
        continue;
      }
      if (/^\.ctxsnap-[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
        await unlink(join(this.root, entry.name));
        continue;
      }
      if (!/^ctxsnap-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      try {
        const manifest = await this.readManifest(join(this.root, entry.name));
        if (`${manifest.entryId}.json` !== entry.name) throw new Error("manifest filename mismatch");
        const expectedEntryId = `ctxsnap-${createHash("sha256")
          .update(contextSnapshotLookupKey(manifest))
          .digest("hex")}`;
        if (manifest.entryId !== expectedEntryId) throw new Error("manifest entry ID mismatch");
        const snapshot = await lstat(join(this.root, this.filename(manifest.entryId)));
        if (!snapshot.isFile() || snapshot.isSymbolicLink() || snapshot.size !== manifest.snapshotBytes) {
          throw new Error("snapshot file identity is invalid");
        }
        this.manifests.set(contextSnapshotLookupKey(manifest), manifest);
        committedFiles.add(this.filename(manifest.entryId));
      } catch {
        this.invalidEntries += 1;
        await unlink(join(this.root, entry.name)).catch(() => undefined);
      }
    }
    for (const entry of entries) {
      if (!/^ctxsnap-[a-f0-9]{64}\.bin$/.test(entry.name) || committedFiles.has(entry.name)) continue;
      await unlink(join(this.root, entry.name)).catch(() => undefined);
      this.invalidEntries += 1;
    }
    this.initialized = true;
  }

  stats(): { entries: number; invalidEntries: number; verifiedEntries: number } {
    return {
      entries: this.manifests.size,
      invalidEntries: this.invalidEntries,
      verifiedEntries: this.verified.size,
    };
  }

  async usageBytes(): Promise<number> {
    await this.initialize();
    let total = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (
        !entry.isFile()
        || entry.isSymbolicLink()
        || !(
          PENDING_PATTERN.test(entry.name)
          || /^ctxsnap-[a-f0-9]{64}\.bin(?:\.quarantine-[a-f0-9-]{36})?$/.test(entry.name)
        )
      ) continue;
      const metadata = await lstat(join(this.root, entry.name));
      if (metadata.isFile() && !metadata.isSymbolicLink()) total += metadata.size;
    }
    return total;
  }

  async preflight(expectedWriteBytes: number, principalScope?: string): Promise<void> {
    await this.initialize();
    if (!Number.isSafeInteger(expectedWriteBytes) || expectedWriteBytes < 1) {
      throw new ContextSnapshotStoreError("snapshot_quota_exceeded", "expected snapshot size is invalid");
    }
    const principalLimit = this.options.perPrincipalMaxBytes ?? this.options.maxBytes;
    if (expectedWriteBytes > this.options.maxBytes || expectedWriteBytes > principalLimit) {
      throw new ContextSnapshotStoreError("snapshot_quota_exceeded", "expected snapshot cannot fit the configured quota");
    }
    let usage = await this.usageBytes();
    const highBytes = Math.floor(this.options.maxBytes * (this.options.highWatermark ?? 0.9));
    if (usage + expectedWriteBytes > highBytes) {
      await this.prune(Math.max(0, Math.floor(this.options.maxBytes * (this.options.lowWatermark ?? 0.8)) - expectedWriteBytes));
      usage = await this.usageBytes();
    }
    if (usage + expectedWriteBytes > this.options.maxBytes) {
      throw new ContextSnapshotStoreError("snapshot_quota_exceeded", "snapshot write would exceed quota");
    }
    const principalUsage = principalScope === undefined ? 0 : [...this.manifests.values()]
      .filter((manifest) => manifest.principalScope === principalScope)
      .reduce((total, manifest) => total + manifest.snapshotBytes, 0);
    if (principalScope !== undefined && principalUsage + expectedWriteBytes > principalLimit) {
      throw new ContextSnapshotStoreError("snapshot_quota_exceeded", "principal snapshot quota would be exceeded");
    }
    const filesystem = await statfs(this.root);
    const available = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (available - expectedWriteBytes < this.options.freeFloorBytes) {
      throw new ContextSnapshotStoreError("snapshot_free_floor", "snapshot write would cross free floor");
    }
  }

  async prune(targetBytes: number): Promise<{ removedEntries: number; removedBytes: number }> {
    await this.initialize();
    if (!Number.isSafeInteger(targetBytes) || targetBytes < 0) {
      throw new ContextSnapshotStoreError("snapshot_quota_exceeded", "snapshot prune target is invalid");
    }
    let usage = await this.usageBytes();
    let removedEntries = 0;
    let removedBytes = 0;
    const candidates = [...this.manifests.values()].sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.entryId.localeCompare(right.entryId)
    );
    for (const manifest of candidates) {
      if (usage <= targetBytes) break;
      await unlink(join(this.root, this.filename(manifest.entryId))).catch(() => undefined);
      await unlink(join(this.root, `${manifest.entryId}.json`)).catch(() => undefined);
      this.manifests.delete(contextSnapshotLookupKey(manifest));
      this.verified.delete(manifest.entryId);
      usage = Math.max(0, usage - manifest.snapshotBytes);
      removedEntries += 1;
      removedBytes += manifest.snapshotBytes;
    }
    if (usage > targetBytes) {
      const quarantined = await Promise.all((await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /^ctxsnap-[a-f0-9]{64}\.bin\.quarantine-[a-f0-9-]{36}$/.test(entry.name))
        .map(async (entry) => ({ entry, metadata: await lstat(join(this.root, entry.name)) })));
      quarantined.sort((left, right) => left.metadata.mtimeMs - right.metadata.mtimeMs);
      for (const { entry, metadata } of quarantined) {
        if (usage <= targetBytes) break;
        await unlink(join(this.root, entry.name)).catch(() => undefined);
        const pair = entry.name.replace(/\.bin(\.quarantine-[a-f0-9-]{36})$/, ".json$1");
        await unlink(join(this.root, pair)).catch(() => undefined);
        usage = Math.max(0, usage - metadata.size);
        removedEntries += 1;
        removedBytes += metadata.size;
      }
    }
    if (removedEntries > 0) {
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return { removedEntries, removedBytes };
  }

  async discardPending(pendingFilename: string): Promise<void> {
    if (!PENDING_PATTERN.test(pendingFilename)) return;
    await unlink(join(this.root, pendingFilename)).catch(() => undefined);
  }

  async invalidate(manifest: ContextSnapshotManifest): Promise<void> {
    await this.initialize();
    await this.quarantine(manifest);
  }

  async commitPending(
    pendingFilename: string,
    input: SnapshotCommitInput,
    signal?: AbortSignal,
  ): Promise<ContextSnapshotManifest> {
    await this.initialize();
    if (!PENDING_PATTERN.test(pendingFilename)) {
      throw new ContextSnapshotStoreError("snapshot_file_unsafe", "pending snapshot filename is unsafe");
    }
    const pendingPath = join(this.root, pendingFilename);
    const pendingMetadata = await lstat(pendingPath).catch((error: NodeJS.ErrnoException) => {
      throw new ContextSnapshotStoreError("snapshot_io_failed", `pending snapshot is unavailable: ${error.code}`);
    });
    if (!pendingMetadata.isFile() || pendingMetadata.isSymbolicLink() || pendingMetadata.size < 1) {
      throw new ContextSnapshotStoreError("snapshot_file_unsafe", "pending snapshot is not a regular file");
    }
    const pendingIdentity = fileIdentity(pendingMetadata);
    const currentUsage = await this.usageBytes();
    if (currentUsage > this.options.maxBytes) {
      throw new ContextSnapshotStoreError("snapshot_quota_exceeded", "snapshot quota is exhausted");
    }
    const filesystem = await statfs(this.root);
    const available = Number(filesystem.bavail) * Number(filesystem.bsize);
    if (available < this.options.freeFloorBytes) {
      throw new ContextSnapshotStoreError("snapshot_free_floor", "snapshot filesystem free floor is not met");
    }
    const entryId = `ctxsnap-${createHash("sha256").update(contextSnapshotLookupKey(input)).digest("hex")}`;
    const finalPath = join(this.root, this.filename(entryId));
    const chunks = await this.checksumFile(pendingPath, signal);
    const checksummedIdentity = await this.openIdentity(pendingPath);
    if (!sameIdentity(pendingIdentity, checksummedIdentity)) {
      throw new ContextSnapshotStoreError("snapshot_file_unsafe", "snapshot changed during checksum");
    }
    const snapshotBytes = chunks.reduce((total, chunk) => total + chunk.bytes, 0);
    if (snapshotBytes !== pendingMetadata.size) {
      throw new ContextSnapshotStoreError("snapshot_file_unsafe", "snapshot size changed during checksum");
    }
    const manifest = contextSnapshotManifestSchema.parse({
      schemaVersion: 1,
      algorithm: "crc32c",
      entryId,
      principalScope: input.principalScope,
      runtime: input.runtime,
      release: input.release,
      compatibilityKey: input.compatibilityKey,
      viewDigest: input.viewDigest,
      tokenCount: input.tokenCount,
      snapshotBytes,
      chunkBytes: CONTEXT_SNAPSHOT_CHUNK_BYTES,
      chunks,
      state: "committed",
      createdAt: input.createdAt ?? new Date(this.options.now?.() ?? Date.now()).toISOString(),
    });
    const existing = this.manifests.get(contextSnapshotLookupKey(manifest));
    if (existing) {
      const verified = await this.findAndVerify({
        principalScope: manifest.principalScope,
        runtime: manifest.runtime,
        release: manifest.release,
        compatibilityKey: manifest.compatibilityKey,
        viewDigest: manifest.viewDigest,
        maxBytes: this.options.maxBytes,
      }, signal);
      if (verified.hit) {
        await unlink(pendingPath);
        return existing;
      }
    }
    const handle = await open(pendingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(pendingPath, finalPath);
    try {
      await this.writeManifest(manifest);
    } catch (error) {
      await unlink(finalPath).catch(() => undefined);
      throw error;
    }
    this.manifests.set(contextSnapshotLookupKey(manifest), manifest);
    this.verified.set(manifest.entryId, await this.openIdentity(finalPath));
    return manifest;
  }

  async findAndVerify(
    expected: SnapshotExpectation,
    signal?: AbortSignal,
  ): Promise<{
    hit: true;
    filename: string;
    manifest: ContextSnapshotManifest;
    cached: boolean;
    verificationMs: number;
  } | { hit: false; reason: string }> {
    await this.initialize();
    const manifest = this.manifests.get(contextSnapshotLookupKey(expected));
    if (!manifest) return { hit: false, reason: "not_found" };
    const identity = validateContextSnapshotIdentity(manifest, expected);
    if (identity !== "ok") return { hit: false, reason: identity };
    const path = join(this.root, this.filename(manifest.entryId));
    let before: SnapshotIdentity;
    try {
      before = await this.openIdentity(path);
    } catch (error) {
      signal?.throwIfAborted();
      await this.quarantine(manifest);
      return { hit: false, reason: "snapshot_unavailable" };
    }
    const cached = this.verified.get(manifest.entryId);
    if (cached && sameIdentity(cached, before)) {
      return { hit: true, filename: this.filename(manifest.entryId), manifest, cached: true, verificationMs: 0 };
    }
    const started = performance.now();
    let actual: ContextSnapshotChunk[];
    let after: SnapshotIdentity;
    try {
      actual = await this.checksumFile(path, signal);
      after = await this.openIdentity(path);
    } catch (error) {
      signal?.throwIfAborted();
      await this.quarantine(manifest);
      return { hit: false, reason: "snapshot_unavailable" };
    }
    if (!sameIdentity(before, after)) {
      await this.quarantine(manifest);
      return { hit: false, reason: "file_identity_changed" };
    }
    if (
      actual.length !== manifest.chunks.length
      || actual.some((chunk, index) => {
        const expectedChunk = manifest.chunks[index];
        return !expectedChunk
          || chunk.index !== expectedChunk.index
          || chunk.bytes !== expectedChunk.bytes
          || chunk.crc32c !== expectedChunk.crc32c;
      })
    ) {
      await this.quarantine(manifest);
      return { hit: false, reason: "crc_mismatch" };
    }
    this.verified.set(manifest.entryId, after);
    return {
      hit: true,
      filename: this.filename(manifest.entryId),
      manifest,
      cached: false,
      verificationMs: performance.now() - started,
    };
  }

  private async checksumFile(path: string, signal?: AbortSignal): Promise<ContextSnapshotChunk[]> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const chunks: ContextSnapshotChunk[] = [];
    const buffer = Buffer.allocUnsafe(CONTEXT_SNAPSHOT_CHUNK_BYTES);
    try {
      let position = 0;
      for (let index = 0; ; index += 1) {
        signal?.throwIfAborted();
        let offset = 0;
        while (offset < buffer.byteLength) {
          const result = await handle.read(buffer, offset, buffer.byteLength - offset, position + offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        if (offset === 0) break;
        chunks.push({ index, bytes: offset, crc32c: crcHex(buffer.subarray(0, offset)) });
        position += offset;
        if (offset < buffer.byteLength) break;
      }
    } finally {
      await handle.close();
    }
    if (chunks.length === 0) {
      throw new ContextSnapshotStoreError("snapshot_file_unsafe", "snapshot must not be empty");
    }
    return chunks;
  }

  private async openIdentity(path: string): Promise<SnapshotIdentity> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new ContextSnapshotStoreError("snapshot_file_unsafe", "snapshot is not a regular file");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const identity = fileIdentity(opened);
      if (!sameIdentity(identity, fileIdentity(before))) {
        throw new ContextSnapshotStoreError("snapshot_file_unsafe", "snapshot changed while opening");
      }
      return identity;
    } finally {
      await handle.close();
    }
  }

  private async readManifest(path: string): Promise<ContextSnapshotManifest> {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MANIFEST_BYTES) {
      throw new ContextSnapshotStoreError("snapshot_manifest_invalid", "snapshot manifest is unsafe");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new ContextSnapshotStoreError("snapshot_manifest_invalid", "snapshot manifest changed while opening");
      }
      return contextSnapshotManifestSchema.parse(JSON.parse(await handle.readFile("utf8")));
    } catch (error) {
      if (error instanceof ContextSnapshotStoreError) throw error;
      throw new ContextSnapshotStoreError(
        "snapshot_manifest_invalid",
        `snapshot manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await handle.close();
    }
  }

  private async writeManifest(manifest: ContextSnapshotManifest): Promise<void> {
    const finalPath = join(this.root, `${manifest.entryId}.json`);
    const temporary = join(this.root, `.${manifest.entryId}.${crypto.randomUUID()}.tmp`);
    const bytes = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
    try {
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, finalPath);
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ContextSnapshotStoreError(
        "snapshot_io_failed",
        `snapshot manifest commit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async quarantine(manifest: ContextSnapshotManifest): Promise<void> {
    const suffix = `.quarantine-${crypto.randomUUID()}`;
    await rename(
      join(this.root, this.filename(manifest.entryId)),
      join(this.root, `${manifest.entryId}.bin${suffix}`),
    ).catch(() => undefined);
    await rename(
      join(this.root, `${manifest.entryId}.json`),
      join(this.root, `${manifest.entryId}.json${suffix}`),
    ).catch(() => undefined);
    this.manifests.delete(contextSnapshotLookupKey(manifest));
    this.verified.delete(manifest.entryId);
    this.invalidEntries += 1;
  }
}
