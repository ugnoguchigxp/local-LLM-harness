import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as secureRandomBytes,
} from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  statfs,
  unlink,
} from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  inferenceAuditExpired,
  inferenceAuditRecordSchema,
  type InferenceAuditPayload,
  type ParsedInferenceAuditRecord,
} from "@larm/core";

const ENCRYPTED_MAGIC = Buffer.from("LARMIA1\n", "ascii");
const MATERIALIZATION_RESERVATION_BYTES = 128 * 1024 * 1024;
const RECORD_OVERHEAD_RESERVATION_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_MATERIALIZATION_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_STORED_PAYLOAD_OVERHEAD_BYTES = 1024 * 1024;
const SAFE_REQUEST_ID = /^req_[a-zA-Z0-9._-]{1,186}$/;
const SAFE_TEMPORARY = /^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const PAYLOAD_FILES = {
  request: "request.json.gz.enc",
  prompt: "prompt.txt.gz.enc",
  tokens: "tokens.json.gz.enc",
  response: "response.bin.gz.enc",
} as const;

export type InferenceAuditPayloadKind = keyof typeof PAYLOAD_FILES;

function validTimeSegment(depth: number, value: string): boolean {
  if (depth === 0) return /^\d{4}$/.test(value);
  if (depth === 1) return /^(0[1-9]|1[0-2])$/.test(value);
  if (depth === 2) return /^(0[1-9]|[12]\d|3[01])$/.test(value);
  return /^(?:[01]\d|2[0-3])$/.test(value);
}

function payloadAad(recordIdentity: string, kind: InferenceAuditPayloadKind): Buffer {
  return Buffer.from(`LARMIA1\0${recordIdentity}\0${kind}`, "utf8");
}

export class InferenceAuditStoreError extends Error {
  constructor(
    readonly code:
      | "unsafe_audit_root"
      | "invalid_audit_key"
      | "audit_record_corrupt"
      | "audit_write_failed"
      | "audit_capacity_exhausted"
      | "audit_record_not_found"
      | "audit_payload_corrupt",
    message: string,
  ) {
    super(message);
    this.name = "InferenceAuditStoreError";
  }
}

export type InferenceAuditBeginInput = {
  requestId: string;
  allocationId: string;
  capability: string;
  route: string;
  runtime: string;
  runtimeRelease?: string;
  bootEpoch: string;
  configRevision: string;
  createdAt?: string;
};

export type LocalInferenceAuditStoreOptions = {
  root: string;
  key: Uint8Array;
  retentionMs?: number;
  maxBytes?: number;
  minFreeBytes?: number;
  maxResponseBytes?: number;
  partialGraceMs?: number;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  availableBytes?: (path: string) => number | Promise<number>;
};

export type InferenceAuditPruneResult = {
  expired: number;
  capacity: number;
  interrupted: number;
  remainingRecords: number;
  remainingBytes: number;
};

type StoredRecord = {
  path: string;
  metadata: ParsedInferenceAuditRecord;
  bytes: number;
  active: boolean;
};

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}

function canonicalTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new InferenceAuditStoreError("audit_record_corrupt", "audit timestamp must be canonical ISO-8601");
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalInferenceAuditSession {
  private responseChunks: Uint8Array[] = [];
  private capturedResponseBytes = 0;
  private totalResponseBytes = 0;
  private responseCaptureFailed = false;
  private finalized = false;

  constructor(
    private readonly store: LocalInferenceAuditStore,
    readonly path: string,
    private metadata: ParsedInferenceAuditRecord,
    private readonly maxResponseBytes: number,
    private readonly releaseReservation: () => void,
  ) {}

  get requestId(): string {
    return this.metadata.requestId;
  }

  async saveMaterialization(prompt: string, tokens: unknown[]): Promise<void> {
    if (this.finalized) return;
    const promptBytes = new TextEncoder().encode(prompt);
    const tokenBytes = new TextEncoder().encode(`${JSON.stringify(tokens)}\n`);
    this.metadata.payloads.prompt = await this.store.writePayload(this.path, "prompt", promptBytes);
    this.metadata.payloads.tokens = await this.store.writePayload(this.path, "tokens", tokenBytes);
    let promptCharacters = 0;
    for (const _character of prompt) promptCharacters += 1;
    this.metadata.promptCharacters = promptCharacters;
    this.metadata.promptTokens = tokens.length;
    delete this.metadata.materializationError;
    await this.store.writeMetadata(this.path, this.metadata);
  }

  async saveMaterializationError(message: string): Promise<void> {
    if (this.finalized) return;
    this.metadata.materializationError = message.slice(0, 256) || "unknown materialization error";
    await this.store.writeMetadata(this.path, this.metadata);
  }

  captureResponse(chunk: Uint8Array): void {
    if (this.finalized) return;
    this.totalResponseBytes += chunk.byteLength;
    if (this.responseCaptureFailed) return;
    const remaining = this.maxResponseBytes - this.capturedResponseBytes;
    if (remaining <= 0) {
      this.metadata.responseTruncated = true;
      return;
    }
    try {
      const captured = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      this.responseChunks.push(captured.slice());
      this.capturedResponseBytes += captured.byteLength;
      if (captured.byteLength !== chunk.byteLength) {
        this.metadata.responseTruncated = true;
      }
    } catch {
      this.responseCaptureFailed = true;
      this.metadata.responseTruncated = true;
    }
  }

  markResponseCaptureFailed(): void {
    if (this.finalized) return;
    this.responseCaptureFailed = true;
    this.metadata.responseTruncated = true;
  }

  async finalize(input: {
    outcome: string;
    upstreamStatus?: number;
    completedAt?: string;
    interrupted?: boolean;
  }): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    try {
      if (this.capturedResponseBytes > 0) {
        const response = new Uint8Array(this.capturedResponseBytes);
        let offset = 0;
        for (const chunk of this.responseChunks) {
          response.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.metadata.payloads.response = await this.store.writePayload(this.path, "response", response);
      }
      this.responseChunks = [];
      this.metadata.responseBytes = this.totalResponseBytes;
      this.metadata.outcome = input.outcome.slice(0, 128) || "unknown";
      if (input.upstreamStatus !== undefined) this.metadata.upstreamStatus = input.upstreamStatus;
      this.metadata.completedAt = canonicalTimestamp(
        input.completedAt ?? new Date(this.store.now()).toISOString(),
      );
      this.metadata.status = input.interrupted ? "interrupted" : "completed";
      await this.store.writeMetadata(this.path, this.metadata);
      await this.store.removeActiveMarker(this.path);
    } finally {
      this.releaseReservation();
    }
  }
}

export class LocalInferenceAuditStore {
  readonly root: string;
  readonly retentionMs: number;
  readonly maxBytes: number;
  readonly minFreeBytes: number;
  readonly maxResponseBytes: number;
  readonly partialGraceMs: number;
  private readonly key: Buffer;
  private readonly keyId: string;
  private readonly random: (size: number) => Uint8Array;
  private readonly available?: (path: string) => number | Promise<number>;
  private readonly activeRecordPaths = new Set<string>();
  private reservedBytes = 0;

  constructor(private readonly options: LocalInferenceAuditStoreOptions) {
    if (!isAbsolute(options.root)) {
      throw new InferenceAuditStoreError("unsafe_audit_root", "inference audit root must be absolute");
    }
    this.root = resolve(options.root);
    if (this.root === dirname(this.root)) {
      throw new InferenceAuditStoreError("unsafe_audit_root", "inference audit root must not be a filesystem root");
    }
    if (options.key.byteLength !== 32) {
      throw new InferenceAuditStoreError("invalid_audit_key", "inference audit key must contain exactly 32 bytes");
    }
    this.key = Buffer.from(options.key);
    this.keyId = createHash("sha256").update(this.key).digest("hex").slice(0, 16);
    this.retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024 * 1024;
    this.minFreeBytes = options.minFreeBytes ?? 20 * 1024 * 1024 * 1024;
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
    this.partialGraceMs = options.partialGraceMs ?? 60 * 60 * 1000;
    if (
      !Number.isSafeInteger(this.retentionMs)
      || this.retentionMs < 1
      || this.retentionMs > 7 * 24 * 60 * 60 * 1000
      || !Number.isSafeInteger(this.maxBytes)
      || this.maxBytes
        <= this.maxResponseBytes
          + MATERIALIZATION_RESERVATION_BYTES
          + RECORD_OVERHEAD_RESERVATION_BYTES
      || !Number.isSafeInteger(this.minFreeBytes)
      || this.minFreeBytes < 0
      || !Number.isSafeInteger(this.maxResponseBytes)
      || this.maxResponseBytes < 1
      || this.maxResponseBytes > 64 * 1024 * 1024
      || !Number.isSafeInteger(this.partialGraceMs)
      || this.partialGraceMs < 1
    ) {
      throw new InferenceAuditStoreError("unsafe_audit_root", "inference audit bounds are invalid");
    }
    this.random = options.randomBytes ?? ((size) => secureRandomBytes(size));
    this.available = options.availableBytes;
  }

  now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.validateDirectory(this.root);
    const metadata = await lstat(this.root);
    if ((metadata.mode & 0o077) !== 0) {
      throw new InferenceAuditStoreError(
        "unsafe_audit_root",
        "inference audit root must not grant group or other permissions",
      );
    }
    if (typeof process.geteuid === "function" && metadata.uid !== process.geteuid()) {
      throw new InferenceAuditStoreError(
        "unsafe_audit_root",
        "inference audit root must be owned by the daemon user",
      );
    }
  }

  async begin(input: InferenceAuditBeginInput, requestBody: Uint8Array): Promise<LocalInferenceAuditSession> {
    await this.initialize();
    if (!SAFE_REQUEST_ID.test(input.requestId)) {
      throw new InferenceAuditStoreError("audit_record_corrupt", "request id is unsafe");
    }
    if (requestBody.byteLength > MAX_REQUEST_BYTES) {
      throw new InferenceAuditStoreError(
        "audit_capacity_exhausted",
        "inference audit request exceeds the payload size limit",
      );
    }
    const reservation = requestBody.byteLength
      + this.maxResponseBytes
      + MATERIALIZATION_RESERVATION_BYTES
      + RECORD_OVERHEAD_RESERVATION_BYTES;
    if (reservation > this.maxBytes) {
      throw new InferenceAuditStoreError(
        "audit_capacity_exhausted",
        "inference audit request exceeds the store reservation limit",
      );
    }
    const pruned = await this.prune(reservation);
    const available = await this.availableBytes();
    if (
      pruned.remainingBytes + this.reservedBytes + reservation > this.maxBytes
      || available - this.reservedBytes - reservation < this.minFreeBytes
    ) {
      throw new InferenceAuditStoreError(
        "audit_capacity_exhausted",
        "inference audit store cannot reserve the request payload",
      );
    }
    this.reservedBytes += reservation;
    let released = false;
    const releaseReservation = () => {
      if (released) return;
      released = true;
      if (recordPath) this.activeRecordPaths.delete(recordPath);
      this.reservedBytes = Math.max(0, this.reservedBytes - reservation);
    };
    let recordPath: string | undefined;
    let recordCreated = false;
    try {
      const createdAt = canonicalTimestamp(input.createdAt ?? new Date(this.now()).toISOString());
      const date = new Date(createdAt);
      const segments = [
        String(date.getUTCFullYear()).padStart(4, "0"),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        String(date.getUTCDate()).padStart(2, "0"),
        String(date.getUTCHours()).padStart(2, "0"),
      ];
      let parent = this.root;
      for (const [depth, segment] of segments.entries()) {
        if (!validTimeSegment(depth, segment)) {
          throw new InferenceAuditStoreError("audit_record_corrupt", "audit time path is unsafe");
        }
        parent = join(parent, segment);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await this.validateDirectory(parent);
      }
      recordPath = join(parent, input.requestId);
      if (!isWithin(this.root, recordPath)) {
        throw new InferenceAuditStoreError("unsafe_audit_root", "audit record escaped its root");
      }
      try {
        await mkdir(recordPath, { mode: 0o700 });
        recordCreated = true;
      } catch (error) {
        throw new InferenceAuditStoreError(
          "audit_write_failed",
          `failed to create inference audit record: ${errorMessage(error)}`,
        );
      }
      await this.validateDirectory(recordPath);
      const metadata = inferenceAuditRecordSchema.parse({
        version: 1,
        requestId: input.requestId,
        allocationId: input.allocationId,
        protocol: "openai.chat-completions.v1",
        capability: input.capability,
        route: input.route,
        runtime: input.runtime,
        ...(input.runtimeRelease ? { runtimeRelease: input.runtimeRelease } : {}),
        bootEpoch: input.bootEpoch,
        configRevision: input.configRevision,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + this.retentionMs).toISOString(),
        status: "active",
        requestBytes: requestBody.byteLength,
        responseBytes: 0,
        responseTruncated: false,
        payloads: {},
      });
      await this.writeAtomic(join(recordPath, "active"), new Uint8Array());
      await this.writeMetadata(recordPath, metadata);
      metadata.payloads.request = await this.writePayload(recordPath, "request", requestBody);
      await this.writeMetadata(recordPath, metadata);
      this.activeRecordPaths.add(recordPath);
      return new LocalInferenceAuditSession(
        this,
        recordPath,
        metadata,
        this.maxResponseBytes,
        releaseReservation,
      );
    } catch (error) {
      releaseReservation();
      if (recordCreated && recordPath) {
        await rm(recordPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async writePayload(
    recordPath: string,
    kind: InferenceAuditPayloadKind,
    plain: Uint8Array,
  ): Promise<InferenceAuditPayload> {
    await this.validateRecordPath(recordPath);
    if (plain.byteLength > this.payloadPlainLimit(kind)) {
      throw new InferenceAuditStoreError(
        "audit_write_failed",
        `inference audit ${kind} payload exceeds its size limit`,
      );
    }
    const compressed = gzipSync(plain, { level: 6 });
    const nonce = Buffer.from(this.random(12));
    if (nonce.byteLength !== 12) {
      throw new InferenceAuditStoreError("audit_write_failed", "audit nonce source returned an invalid length");
    }
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(payloadAad(this.recordIdentity(recordPath), kind));
    const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const tag = cipher.getAuthTag();
    const stored = Buffer.concat([ENCRYPTED_MAGIC, nonce, tag, ciphertext]);
    const file = PAYLOAD_FILES[kind];
    await this.writeAtomic(join(recordPath, file), stored);
    return {
      file,
      plainBytes: plain.byteLength,
      storedBytes: stored.byteLength,
      sha256: createHash("sha256").update(plain).digest("hex"),
      encoding: "gzip+aes-256-gcm",
      keyId: this.keyId,
    };
  }

  async readPayload(record: ParsedInferenceAuditRecord, kind: InferenceAuditPayloadKind): Promise<Uint8Array> {
    const normalized = inferenceAuditRecordSchema.parse(record);
    if (inferenceAuditExpired(normalized, this.now())) {
      throw new InferenceAuditStoreError("audit_record_not_found", "inference audit record has expired");
    }
    const descriptor = normalized.payloads[kind];
    if (!descriptor || descriptor.file !== PAYLOAD_FILES[kind] || descriptor.keyId !== this.keyId) {
      throw new InferenceAuditStoreError("audit_payload_corrupt", `audit ${kind} payload descriptor is invalid`);
    }
    const maximumPlainBytes = this.payloadPlainLimit(kind);
    if (
      descriptor.plainBytes > maximumPlainBytes
      || descriptor.storedBytes > maximumPlainBytes + MAX_STORED_PAYLOAD_OVERHEAD_BYTES
    ) {
      throw new InferenceAuditStoreError(
        "audit_payload_corrupt",
        `audit ${kind} payload descriptor exceeds its size limit`,
      );
    }
    const recordPath = this.recordPath(normalized);
    await this.validateRecordPath(recordPath);
    try {
      const payloadPath = join(recordPath, descriptor.file);
      const handle = await open(payloadPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let stored: Buffer;
      try {
        const metadata = await handle.stat();
        this.validateOwnedFile(metadata, "encrypted audit payload");
        if (metadata.size !== descriptor.storedBytes) {
          throw new Error("encrypted payload file identity is invalid");
        }
        stored = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (
        stored.byteLength < ENCRYPTED_MAGIC.byteLength + 12 + 16
        || !stored.subarray(0, ENCRYPTED_MAGIC.byteLength).equals(ENCRYPTED_MAGIC)
      ) {
        throw new Error("invalid encrypted payload header");
      }
      const nonceStart = ENCRYPTED_MAGIC.byteLength;
      const tagStart = nonceStart + 12;
      const ciphertextStart = tagStart + 16;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        stored.subarray(nonceStart, tagStart),
      );
      decipher.setAAD(payloadAad(this.recordIdentity(recordPath), kind));
      decipher.setAuthTag(stored.subarray(tagStart, ciphertextStart));
      const compressed = Buffer.concat([
        decipher.update(stored.subarray(ciphertextStart)),
        decipher.final(),
      ]);
      const plain = gunzipSync(compressed, {
        maxOutputLength: Math.max(1, descriptor.plainBytes),
      });
      if (
        plain.byteLength !== descriptor.plainBytes
        || createHash("sha256").update(plain).digest("hex") !== descriptor.sha256
      ) {
        throw new Error("audit payload digest mismatch");
      }
      return plain;
    } catch (error) {
      if (error instanceof InferenceAuditStoreError) throw error;
      throw new InferenceAuditStoreError(
        "audit_payload_corrupt",
        `failed to decrypt audit ${kind} payload: ${errorMessage(error)}`,
      );
    }
  }

  async list(includeExpired = false): Promise<ParsedInferenceAuditRecord[]> {
    await this.initialize();
    const records = await this.scanRecords();
    return records
      .filter((record) => includeExpired || !inferenceAuditExpired(record.metadata, this.now()))
      .map((record) => record.metadata)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(requestId: string): Promise<ParsedInferenceAuditRecord> {
    await this.initialize();
    if (!SAFE_REQUEST_ID.test(requestId)) {
      throw new InferenceAuditStoreError("audit_record_not_found", "inference audit record was not found");
    }
    const record = (await this.scanRecords()).find((item) => item.metadata.requestId === requestId);
    if (!record || inferenceAuditExpired(record.metadata, this.now())) {
      throw new InferenceAuditStoreError("audit_record_not_found", "inference audit record was not found");
    }
    return record.metadata;
  }

  async prune(requiredBytes = 0): Promise<InferenceAuditPruneResult> {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
      throw new InferenceAuditStoreError("audit_capacity_exhausted", "audit reservation is invalid");
    }
    await this.initialize();
    let records = await this.scanRecords(true);
    let expired = 0;
    let capacity = 0;
    let interrupted = 0;
    const now = this.now();
    for (const record of records) {
      if (record.active && record.metadata.status !== "active") {
        await this.removeActiveMarker(record.path);
        record.active = false;
        continue;
      }
      if (
        record.active
        && !this.activeRecordPaths.has(record.path)
        && now - Date.parse(record.metadata.createdAt) >= this.partialGraceMs
      ) {
        const metadata = {
          ...record.metadata,
          status: "interrupted" as const,
          outcome: "daemon_interrupted",
          completedAt: new Date(now).toISOString(),
        };
        await this.writeMetadata(record.path, metadata);
        await this.removeActiveMarker(record.path);
        record.metadata = inferenceAuditRecordSchema.parse(metadata);
        record.active = false;
        interrupted += 1;
      }
    }
    for (const record of records) {
      if (!record.active && inferenceAuditExpired(record.metadata, now)) {
        await this.removeRecord(record.path);
        expired += 1;
      }
    }
    records = await this.scanRecords();
    let total = records.reduce((sum, record) => sum + record.bytes, 0);
    let available = await this.availableBytes();
    for (const record of records
      .filter((item) => !item.active)
      .sort((left, right) => left.metadata.createdAt.localeCompare(right.metadata.createdAt))) {
      if (
        total + this.reservedBytes + requiredBytes <= this.maxBytes
        && available - this.reservedBytes - requiredBytes >= this.minFreeBytes
      ) break;
      await this.removeRecord(record.path);
      total = Math.max(0, total - record.bytes);
      available = await this.availableBytes();
      capacity += 1;
    }
    const remaining = await this.scanRecords();
    return {
      expired,
      capacity,
      interrupted,
      remainingRecords: remaining.length,
      remainingBytes: remaining.reduce((sum, record) => sum + record.bytes, 0),
    };
  }

  async writeMetadata(path: string, metadata: ParsedInferenceAuditRecord): Promise<void> {
    await this.validateRecordPath(path);
    const normalized = inferenceAuditRecordSchema.parse(metadata);
    await this.writeAtomic(
      join(path, "metadata.json"),
      new TextEncoder().encode(`${JSON.stringify(normalized, null, 2)}\n`),
    );
  }

  async removeActiveMarker(path: string): Promise<void> {
    await this.validateRecordPath(path);
    try {
      const marker = join(path, "active");
      const metadata = await lstat(marker);
      this.validateOwnedFile(metadata, "audit active marker");
      if (metadata.size !== 0) throw new Error("audit active marker is not empty");
      await unlink(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async writeAtomic(path: string, data: Uint8Array): Promise<void> {
    if (!isWithin(this.root, path)) {
      throw new InferenceAuditStoreError("unsafe_audit_root", "audit write escaped its root");
    }
    const parent = dirname(path);
    await this.validateDirectory(parent);
    const temporary = join(parent, `.${crypto.randomUUID()}.tmp`);
    try {
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (error instanceof InferenceAuditStoreError) throw error;
      throw new InferenceAuditStoreError(
        "audit_write_failed",
        `failed to write inference audit data: ${errorMessage(error)}`,
      );
    }
  }

  private async scanRecords(cleanupOrphans = false): Promise<StoredRecord[]> {
    const records: StoredRecord[] = [];
    const walk = async (path: string, depth: number): Promise<void> => {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        try {
          if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
            throw new InferenceAuditStoreError("audit_record_corrupt", "audit root contains an unsafe entry");
          }
          const child = join(path, entry.name);
          if (depth < 4) {
            if (!entry.isDirectory() || !validTimeSegment(depth, entry.name)) {
              throw new InferenceAuditStoreError("audit_record_corrupt", "audit root contains an invalid time segment");
            }
            await this.validateDirectory(child);
            await walk(child, depth + 1);
            continue;
          }
          if (!entry.isDirectory() || !SAFE_REQUEST_ID.test(entry.name)) {
            throw new InferenceAuditStoreError("audit_record_corrupt", "audit hour contains an invalid record");
          }
          await this.validateRecordPath(child);
          let metadata: ParsedInferenceAuditRecord;
          try {
            metadata = await this.readMetadata(child);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              const directory = await lstat(child);
              if (cleanupOrphans && this.now() - directory.mtimeMs >= this.partialGraceMs) {
                await rm(child, { recursive: true, force: false });
                await this.removeEmptyTimeAncestors(child);
              }
              continue;
            }
            throw new InferenceAuditStoreError(
              "audit_record_corrupt",
              `failed to read inference audit metadata: ${errorMessage(error)}`,
            );
          }
          if (metadata.requestId !== entry.name || this.recordPath(metadata) !== child) {
            throw new InferenceAuditStoreError("audit_record_corrupt", "audit metadata path identity is invalid");
          }
          let active = false;
          try {
            const marker = await lstat(join(child, "active"));
            this.validateOwnedFile(marker, "audit active marker");
            if (marker.size !== 0) throw new Error("audit active marker is not empty");
            active = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw new InferenceAuditStoreError("audit_record_corrupt", errorMessage(error));
            }
          }
          records.push({
            path: child,
            metadata,
            bytes: await this.directoryBytes(child, cleanupOrphans),
            active,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
    };
    await walk(this.root, 0);
    return records;
  }

  private recordPath(record: Pick<ParsedInferenceAuditRecord, "createdAt" | "requestId">): string {
    const date = new Date(record.createdAt);
    return join(
      this.root,
      String(date.getUTCFullYear()).padStart(4, "0"),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
      String(date.getUTCHours()).padStart(2, "0"),
      record.requestId,
    );
  }

  private recordIdentity(recordPath: string): string {
    return relative(this.root, recordPath).split(sep).join("/");
  }

  private payloadPlainLimit(kind: InferenceAuditPayloadKind): number {
    if (kind === "request") return MAX_REQUEST_BYTES;
    if (kind === "response") return this.maxResponseBytes;
    return MAX_MATERIALIZATION_PAYLOAD_BYTES;
  }

  private async availableBytes(): Promise<number> {
    if (this.available) return await this.available(this.root);
    const fs = await statfs(this.root);
    return fs.bavail * fs.bsize;
  }

  private async validateDirectory(path: string): Promise<void> {
    if (!isWithin(this.root, path) && path !== this.root) {
      throw new InferenceAuditStoreError("unsafe_audit_root", "audit directory escaped its root");
    }
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new InferenceAuditStoreError("unsafe_audit_root", "audit path must be a real directory");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new InferenceAuditStoreError(
        "unsafe_audit_root",
        "audit directories must not grant group or other permissions",
      );
    }
    if (typeof process.geteuid === "function" && metadata.uid !== process.geteuid()) {
      throw new InferenceAuditStoreError(
        "unsafe_audit_root",
        "audit directories must be owned by the daemon user",
      );
    }
    if (await realpath(path) !== resolve(path)) {
      throw new InferenceAuditStoreError("unsafe_audit_root", "audit directory must be canonical");
    }
  }

  private async validateRecordPath(path: string): Promise<void> {
    const segments = relative(this.root, resolve(path)).split(sep);
    if (
      !isWithin(this.root, path)
      || segments.length !== 5
      || !segments.slice(0, 4).every((segment, depth) => validTimeSegment(depth, segment))
      || !SAFE_REQUEST_ID.test(segments[4] ?? "")
    ) {
      throw new InferenceAuditStoreError("unsafe_audit_root", "audit record path is unsafe");
    }
    await this.validateDirectory(path);
  }

  private async directoryBytes(path: string, cleanupTemporaries = false): Promise<number> {
    let bytes = 0;
    const allowed = new Set(["active", "metadata.json", ...Object.values(PAYLOAD_FILES)]);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        if (entry.isDirectory()) {
          throw new InferenceAuditStoreError("audit_record_corrupt", "audit record contains a nested directory");
        }
        throw new InferenceAuditStoreError("audit_record_corrupt", "audit record contains an unsafe file");
      }
      const metadata = await lstat(join(path, entry.name));
      this.validateOwnedFile(metadata, "audit record file");
      if (SAFE_TEMPORARY.test(entry.name)) {
        if (cleanupTemporaries && this.now() - metadata.mtimeMs >= this.partialGraceMs) {
          await unlink(join(path, entry.name));
          continue;
        }
      } else if (!allowed.has(entry.name)) {
        throw new InferenceAuditStoreError("audit_record_corrupt", "audit record contains an unknown file");
      }
      bytes += metadata.size;
    }
    return bytes;
  }

  private async removeRecord(path: string): Promise<void> {
    try {
      await this.validateRecordPath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      await lstat(join(path, "active"));
      throw new InferenceAuditStoreError("audit_record_corrupt", "active audit record cannot be removed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rm(path, { recursive: true, force: false });
      await this.removeEmptyTimeAncestors(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async readMetadata(recordPath: string): Promise<ParsedInferenceAuditRecord> {
    const handle = await open(
      join(recordPath, "metadata.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      this.validateOwnedFile(metadata, "audit metadata file");
      if (metadata.size > 1024 * 1024) throw new Error("audit metadata file is too large");
      return inferenceAuditRecordSchema.parse(JSON.parse(await handle.readFile("utf8")));
    } finally {
      await handle.close();
    }
  }

  private validateOwnedFile(metadata: import("node:fs").Stats, description: string): void {
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new InferenceAuditStoreError("audit_record_corrupt", `${description} identity is unsafe`);
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new InferenceAuditStoreError("audit_record_corrupt", `${description} permissions are unsafe`);
    }
    if (typeof process.geteuid === "function" && metadata.uid !== process.geteuid()) {
      throw new InferenceAuditStoreError("audit_record_corrupt", `${description} owner is unsafe`);
    }
  }

  private async removeEmptyTimeAncestors(recordPath: string): Promise<void> {
    let current = dirname(recordPath);
    while (current !== this.root && isWithin(this.root, current)) {
      const parent = dirname(current);
      try {
        await this.validateDirectory(current);
        await rmdir(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          current = parent;
          continue;
        }
        if (code === "ENOTEMPTY" || code === "EEXIST") return;
        throw error;
      }
      current = parent;
    }
  }
}
