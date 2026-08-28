import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type RuntimeDeploymentRecord = {
  runtime: string;
  activeRelease: string | null;
  previousRelease: string | null;
  updatedAt: string;
  pending?: {
    kind: "activate" | "rollback";
    targetRelease: string;
    originalActiveRelease: string | null;
    originalPreviousRelease: string | null;
    startedAt: string;
  };
};

export type RuntimeReleaseState = {
  version: 1;
  catalogRevision: string;
  deployments: RuntimeDeploymentRecord[];
};

export class ReleaseStateStoreError extends Error {
  constructor(readonly code: "unsafe_state_root" | "state_corrupt" | "state_write_failed", message: string) {
    super(message);
    this.name = "ReleaseStateStoreError";
  }
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,191}$/.test(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseState(input: unknown): RuntimeReleaseState {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ReleaseStateStoreError("state_corrupt", "runtime release state must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    value.version !== 1
    || typeof value.catalogRevision !== "string"
    || !/^[a-f0-9]{64}$/.test(value.catalogRevision)
    || !Array.isArray(value.deployments)
  ) {
    throw new ReleaseStateStoreError("state_corrupt", "runtime release state header is invalid");
  }
  const seen = new Set<string>();
  const deployments: RuntimeDeploymentRecord[] = value.deployments.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ReleaseStateStoreError("state_corrupt", "runtime deployment record is invalid");
    }
    const record = item as Record<string, unknown>;
    if (
      !safeIdentifier(record.runtime)
      || (record.activeRelease !== null && !safeIdentifier(record.activeRelease))
      || (record.previousRelease !== null && !safeIdentifier(record.previousRelease))
      || !canonicalTimestamp(record.updatedAt)
      || Object.keys(record).some((key) => !["runtime", "activeRelease", "previousRelease", "updatedAt", "pending"].includes(key))
    ) {
      throw new ReleaseStateStoreError("state_corrupt", "runtime deployment record fields are invalid");
    }
    if (seen.has(record.runtime)) {
      throw new ReleaseStateStoreError("state_corrupt", `duplicate runtime deployment ${record.runtime}`);
    }
    seen.add(record.runtime);
    if (record.pending !== undefined) {
      if (typeof record.pending !== "object" || record.pending === null || Array.isArray(record.pending)) {
        throw new ReleaseStateStoreError("state_corrupt", "runtime deployment pending state is invalid");
      }
      const pending = record.pending as Record<string, unknown>;
      if (
        (pending.kind !== "activate" && pending.kind !== "rollback")
        || !safeIdentifier(pending.targetRelease)
        || (pending.originalActiveRelease !== null && !safeIdentifier(pending.originalActiveRelease))
        || (pending.originalPreviousRelease !== null && !safeIdentifier(pending.originalPreviousRelease))
        || !canonicalTimestamp(pending.startedAt)
        || Object.keys(pending).some((key) => ![
          "kind",
          "targetRelease",
          "originalActiveRelease",
          "originalPreviousRelease",
          "startedAt",
        ].includes(key))
      ) {
        throw new ReleaseStateStoreError("state_corrupt", "runtime deployment pending fields are invalid");
      }
    }
    return record as RuntimeDeploymentRecord;
  });
  if (Object.keys(value).some((key) => !["version", "catalogRevision", "deployments"].includes(key))) {
    throw new ReleaseStateStoreError("state_corrupt", "runtime release state has unknown fields");
  }
  return { version: 1, catalogRevision: value.catalogRevision, deployments };
}

export class LocalRuntimeReleaseStateStore {
  private readonly root: string;
  private readonly path: string;

  constructor(root: string) {
    this.root = resolve(root);
    if (this.root === dirname(this.root)) {
      throw new ReleaseStateStoreError("unsafe_state_root", "runtime release state root must not be a filesystem root");
    }
    this.path = join(this.root, "runtime-releases.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ReleaseStateStoreError("unsafe_state_root", "runtime release state root must be a real directory");
    }
    const canonical = await realpath(this.root);
    if (canonical !== this.root) {
      throw new ReleaseStateStoreError("unsafe_state_root", "runtime release state root must be canonical");
    }
  }

  async load(): Promise<RuntimeReleaseState | undefined> {
    await this.initialize();
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
        throw new ReleaseStateStoreError("state_corrupt", "runtime release state file is unsafe");
      }
      return parseState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      if (error instanceof ReleaseStateStoreError) {
        throw error;
      }
      throw new ReleaseStateStoreError(
        "state_corrupt",
        `failed to read runtime release state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async save(state: RuntimeReleaseState): Promise<void> {
    await this.initialize();
    const normalized = parseState(state);
    const temporary = join(this.root, `.runtime-releases.${crypto.randomUUID()}.tmp`);
    try {
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      const stored = await stat(this.path);
      if (!stored.isFile()) {
        throw new Error("stored release state is not a regular file");
      }
    } catch (error) {
      await Bun.file(temporary).delete().catch(() => undefined);
      if (error instanceof ReleaseStateStoreError) {
        throw error;
      }
      throw new ReleaseStateStoreError(
        "state_write_failed",
        `failed to write runtime release state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
