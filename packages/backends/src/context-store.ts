import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  statfs,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  contextDescriptorSchema,
  type ContextDescriptor,
} from "@larm/core";
import { z } from "zod";

const metadataStateSchema = z.object({
  schemaVersion: z.literal(1),
  descriptors: z.array(contextDescriptorSchema).max(100_000),
}).strict();

const sourceTokenizationSchema = z.object({
  tokenizerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  tokenCount: z.number().int().positive().max(100_000_000),
}).strict();

const sourceAttestationSchema = z.object({
  schemaVersion: z.literal(1),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  tokenizations: z.array(sourceTokenizationSchema).min(1).max(16),
}).strict().refine(
  (value) => new Set(value.tokenizations.map((item) => item.tokenizerDigest)).size
    === value.tokenizations.length,
  { path: ["tokenizations"], message: "tokenizer digests must be unique" },
);

export type ContextMetadataState = z.infer<typeof metadataStateSchema>;

export class ContextStoreError extends Error {
  constructor(
    readonly code:
      | "unsafe_context_root"
      | "context_state_corrupt"
      | "context_state_write_failed"
      | "context_source_not_found"
      | "context_source_unsafe"
      | "context_source_too_large"
      | "context_source_digest_mismatch"
      | "context_source_invalid_utf8"
      | "context_source_attestation_invalid"
      | "context_source_quota_exceeded"
      | "context_source_free_floor"
      | "context_source_provision_busy",
    message: string,
  ) {
    super(message);
    this.name = "ContextStoreError";
  }
}

async function initializeRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ContextStoreError("unsafe_context_root", "context root must be a real directory");
  }
  const canonical = await realpath(root);
  if (canonical !== root) {
    throw new ContextStoreError("unsafe_context_root", "context root must be canonical");
  }
}

function safeRoot(root: string): string {
  if (!root.startsWith("/")) {
    throw new ContextStoreError("unsafe_context_root", "context root must be absolute");
  }
  const normalized = resolve(root);
  if (normalized === dirname(normalized)) {
    throw new ContextStoreError("unsafe_context_root", "context root must not be a filesystem root");
  }
  return normalized;
}

async function atomicWrite(root: string, target: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(root, `.context.${crypto.randomUUID()}.tmp`);
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
    await rename(temporary, target);
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class LocalContextMetadataStore {
  readonly root: string;
  private readonly path: string;

  constructor(root: string) {
    this.root = safeRoot(root);
    this.path = join(this.root, "contexts.json");
  }

  async initialize(): Promise<void> {
    await initializeRoot(this.root);
  }

  async load(): Promise<ContextDescriptor[]> {
    await this.initialize();
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 * 1024) {
        throw new ContextStoreError("context_state_corrupt", "context metadata file is unsafe");
      }
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let text: string;
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile()
          || opened.dev !== metadata.dev
          || opened.ino !== metadata.ino
          || opened.size > 64 * 1024 * 1024
        ) {
          throw new ContextStoreError("context_state_corrupt", "context metadata changed during open");
        }
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      return metadataStateSchema.parse(JSON.parse(text)).descriptors;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof ContextStoreError) throw error;
      throw new ContextStoreError(
        "context_state_corrupt",
        `failed to read context metadata: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async save(descriptors: ContextDescriptor[]): Promise<void> {
    await this.initialize();
    let state: ContextMetadataState;
    try {
      state = metadataStateSchema.parse({ schemaVersion: 1, descriptors });
    } catch (error) {
      throw new ContextStoreError(
        "context_state_corrupt",
        `invalid context metadata: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await atomicWrite(
        this.root,
        this.path,
        new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`),
      );
    } catch (error) {
      throw new ContextStoreError(
        "context_state_write_failed",
        `failed to write context metadata: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export type ContextSource = {
  content: string;
  bytes: number;
  digest: string;
  tokenizations: ContextSourceTokenization[];
};

export type ContextSourceTokenization = z.infer<typeof sourceTokenizationSchema>;

export interface ContextSourceProvider {
  read(
    principal: string,
    sourceHandle: string,
    expectedDigest: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<ContextSource>;
}

export class LocalContextSourceStore implements ContextSourceProvider {
  readonly root: string;

  constructor(root: string) {
    this.root = safeRoot(root);
  }

  async initialize(): Promise<void> {
    await initializeRoot(this.root);
  }

  async usageBytes(): Promise<number> {
    await this.initialize();
    let total = 0;
    for (const principal of await readdir(this.root, { withFileTypes: true })) {
      if (principal.name === ".provision.lock" && principal.isDirectory() && !principal.isSymbolicLink()) {
        continue;
      }
      if (!principal.isDirectory() || principal.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(principal.name)) {
        throw new ContextStoreError("context_source_unsafe", "context source root contains an unsafe entry");
      }
      const directory = join(this.root, principal.name);
      if (await realpath(directory) !== directory) {
        throw new ContextStoreError("context_source_unsafe", "context principal directory is unsafe");
      }
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (
          !entry.isFile()
          || entry.isSymbolicLink()
          || (!entry.name.endsWith(".txt") && !entry.name.endsWith(".txt.json"))
        ) {
          throw new ContextStoreError("context_source_unsafe", "context source directory contains an unsafe entry");
        }
        if (!entry.name.endsWith(".txt")) continue;
        const metadata = await lstat(join(directory, entry.name));
        if (metadata.isFile() && !metadata.isSymbolicLink()) total += metadata.size;
      }
    }
    return total;
  }

  async availableBytes(): Promise<number> {
    await this.initialize();
    const stats = await statfs(this.root);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  private principalDirectory(principal: string): string {
    const digest = createHash("sha256").update(principal).digest("hex");
    return join(this.root, digest);
  }

  private sourcePath(principal: string, sourceHandle: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sourceHandle)) {
      throw new ContextStoreError("context_source_unsafe", "source handle is invalid");
    }
    return join(this.principalDirectory(principal), `${sourceHandle}.txt`);
  }

  private attestationPath(principal: string, sourceHandle: string): string {
    return `${this.sourcePath(principal, sourceHandle)}.json`;
  }

  private async ensurePrincipalDirectory(principal: string, create: boolean): Promise<string> {
    const directory = this.principalDirectory(principal);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ContextStoreError("context_source_not_found", "principal source directory was not found");
      }
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new ContextStoreError("context_source_unsafe", "principal source directory is unsafe");
    }
    return directory;
  }

  async provision(
    principal: string,
    sourceHandle: string,
    content: string,
    maxBytes = 256 * 1024 * 1024,
    tokenizations: ContextSourceTokenization[] = [],
  ): Promise<{
    digest: string;
    bytes: number;
  }> {
    await this.initialize();
    const directory = await this.ensurePrincipalDirectory(principal, true);
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > maxBytes) {
      throw new ContextStoreError(
        "context_source_too_large",
        `context source exceeds ${maxBytes} bytes`,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const attestation = sourceAttestationSchema.parse({
      schemaVersion: 1,
      sourceDigest: digest,
      bytes: bytes.byteLength,
      tokenizations,
    });
    await atomicWrite(directory, this.sourcePath(principal, sourceHandle), bytes);
    await atomicWrite(
      directory,
      this.attestationPath(principal, sourceHandle),
      new TextEncoder().encode(`${JSON.stringify(attestation)}\n`),
    );
    return { digest, bytes: bytes.byteLength };
  }

  async provisionGuarded(
    principal: string,
    sourceHandle: string,
    content: string,
    options: {
      maxSourceBytes: number;
      maxTotalBytes: number;
      filesystemFreeFloorBytes: number;
      tokenizations: ContextSourceTokenization[];
    },
  ): Promise<{ digest: string; bytes: number }> {
    await this.initialize();
    const lock = join(this.root, ".provision.lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ContextStoreError(
          "context_source_provision_busy",
          "another context source provision is in progress",
        );
      }
      throw error;
    }
    try {
      const bytes = new TextEncoder().encode(content).byteLength;
      if (bytes > options.maxSourceBytes) {
        throw new ContextStoreError(
          "context_source_too_large",
          `context source exceeds ${options.maxSourceBytes} bytes`,
        );
      }
      if (await this.usageBytes() + bytes > options.maxTotalBytes) {
        throw new ContextStoreError(
          "context_source_quota_exceeded",
          `context source quota of ${options.maxTotalBytes} bytes would be exceeded`,
        );
      }
      if (await this.availableBytes() - bytes < options.filesystemFreeFloorBytes) {
        throw new ContextStoreError(
          "context_source_free_floor",
          `context source write would violate filesystem free floor ${options.filesystemFreeFloorBytes}`,
        );
      }
      return await this.provision(
        principal,
        sourceHandle,
        content,
        options.maxSourceBytes,
        options.tokenizations,
      );
    } finally {
      await rmdir(lock).catch(() => undefined);
    }
  }

  async read(
    principal: string,
    sourceHandle: string,
    expectedDigest: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<ContextSource> {
    await this.initialize();
    if (signal?.aborted) throw signal.reason ?? new Error("context source read cancelled");
    await this.ensurePrincipalDirectory(principal, false);
    const path = this.sourcePath(principal, sourceHandle);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ContextStoreError("context_source_not_found", "context source was not found");
      }
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ContextStoreError("context_source_unsafe", "context source must be a regular file");
    }
    if (metadata.size > maxBytes) {
      throw new ContextStoreError(
        "context_source_too_large",
        `context source exceeds ${maxBytes} bytes`,
      );
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Uint8Array;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw new ContextStoreError("context_source_unsafe", "context source changed during open");
      }
      bytes = new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
    if (signal?.aborted) throw signal.reason ?? new Error("context source read cancelled");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedDigest) {
      throw new ContextStoreError(
        "context_source_digest_mismatch",
        "context source digest does not match its descriptor",
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ContextStoreError("context_source_invalid_utf8", "context source must be valid UTF-8");
    }
    let attestation;
    try {
      const attestationPath = this.attestationPath(principal, sourceHandle);
      const metadata = await lstat(attestationPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
        throw new Error("unsafe attestation file");
      }
      const handle = await open(attestationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile()
          || opened.dev !== metadata.dev
          || opened.ino !== metadata.ino
          || opened.size > 64 * 1024
        ) throw new Error("attestation changed during open");
        attestation = sourceAttestationSchema.parse(JSON.parse(await handle.readFile("utf8")));
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw new ContextStoreError(
        "context_source_attestation_invalid",
        `context source attestation is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (attestation.sourceDigest !== digest || attestation.bytes !== bytes.byteLength) {
      throw new ContextStoreError(
        "context_source_attestation_invalid",
        "context source attestation does not match the source",
      );
    }
    return { content, bytes: bytes.byteLength, digest, tokenizations: attestation.tokenizations };
  }

  async delete(principal: string, sourceHandle: string): Promise<void> {
    try {
      await this.initialize();
      await this.ensurePrincipalDirectory(principal, false);
      const path = this.sourcePath(principal, sourceHandle);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new ContextStoreError("context_source_unsafe", "context source must be a regular file");
      }
      await unlink(path);
      await unlink(this.attestationPath(principal, sourceHandle)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
