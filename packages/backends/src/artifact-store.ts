import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  artifactDownloadUrl,
  isStageableArtifact,
  type ArtifactDefinition,
} from "@larm/core";

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

export type StagedArtifact = {
  artifactId: string;
  revision: string;
  path: string;
  bytes: number;
  sha256: string;
};

type PreviousTarget =
  | { kind: "hardlink"; path: string }
  | { kind: "symlink"; path: string }
  | { kind: "none" };

export type ActivationRecord = {
  artifactId: string;
  revision: string;
  target: string;
  activePath: string;
  previous: PreviousTarget;
  activatedAt: string;
};

export type ArtifactJournalRecord = Record<string, unknown> & {
  id: string;
  status: string;
};

export type LocalArtifactStoreOptions = {
  stagingRoot: string;
  rollbackRoot: string;
  stateRoot: string;
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  downloadTimeoutMs?: number;
  now?: () => number;
  random?: () => string;
};

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const rejectAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", rejectAbort);
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ArtifactStoreError(
      "operation_cancelled",
      signal.reason instanceof Error ? signal.reason.message : "artifact operation cancelled",
    );
  }
}

async function hashFile(
  path: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  const file = Bun.file(path);
  const hasher = createHash("sha256");
  let bytes = 0;
  const reader = file.stream().getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const read = reader.read();
      const chunk = signal ? await withAbort(read, signal) : await read;
      if (chunk.done) {
        break;
      }
      bytes += chunk.value.byteLength;
      hasher.update(chunk.value);
    }
  } finally {
    if (signal?.aborted) {
      try {
        await reader.cancel(signal.reason);
      } catch {
        // The abort error remains the operation result even if stream cleanup fails.
      }
    }
  }
  return { bytes, sha256: hasher.digest("hex") };
}

export class LocalArtifactStore {
  constructor(private readonly options: LocalArtifactStoreOptions) {
    for (const [name, path] of Object.entries({
      stagingRoot: options.stagingRoot,
      rollbackRoot: options.rollbackRoot,
      stateRoot: options.stateRoot,
    })) {
      if (!isAbsolute(path)) {
        throw new ArtifactStoreError("unsafe_path", `${name} must be absolute`);
      }
      if (resolve(path) === "/") {
        throw new ArtifactStoreError("unsafe_path", `${name} must not be the filesystem root`);
      }
    }
  }

  async stage(artifact: ArtifactDefinition, signal?: AbortSignal): Promise<StagedArtifact> {
    throwIfAborted(signal);
    if (!isStageableArtifact(artifact)) {
      throw new ArtifactStoreError(
        "artifact_not_stageable",
        `artifact ${artifact.id} is not a checksummed single-file artifact`,
      );
    }
    if (basename(artifact.filename) !== artifact.filename) {
      throw new ArtifactStoreError("unsafe_filename", `artifact ${artifact.id} has an unsafe filename`);
    }
    const destination = this.stagedPath(artifact);
    await mkdir(dirname(destination), { recursive: true });
    if (await this.matches(destination, artifact.bytes, artifact.sha256, signal)) {
      return {
        artifactId: artifact.id,
        revision: artifact.revision,
        path: destination,
        bytes: artifact.bytes,
        sha256: artifact.sha256.toLowerCase(),
      };
    }

    const filesystem = await statfs(dirname(destination));
    const availableBytes = filesystem.bavail * filesystem.bsize;
    if (availableBytes < artifact.bytes) {
      throw new ArtifactStoreError(
        "disk_space_exhausted",
        `artifact ${artifact.id} needs ${artifact.bytes} bytes but only ${availableBytes} are available`,
      );
    }

    const temporary = `${destination}.part-${this.random()}`;
    const abort = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => abort.abort(signal?.reason);
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timeout = setTimeout(
      () => {
        timedOut = true;
        abort.abort(new Error("artifact download timeout"));
      },
      this.options.downloadTimeoutMs ?? 3_600_000,
    );
    timeout.unref?.();
    const cleanupAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    };
    let response: Response;
    try {
      response = await withAbort(
        (this.options.fetchImpl ?? fetch)(artifactDownloadUrl(artifact), {
          signal: abort.signal,
        }),
        abort.signal,
      );
    } catch (err) {
      cleanupAbort();
      throw new ArtifactStoreError(
        timedOut ? "download_timeout" : signal?.aborted ? "operation_cancelled" : "download_failed",
        err instanceof Error ? err.message : `artifact ${artifact.id} download failed`,
      );
    }
    if (!response.ok || !response.body) {
      cleanupAbort();
      throw new ArtifactStoreError(
        "download_failed",
        `artifact ${artifact.id} download failed with HTTP ${response.status}`,
      );
    }
    const responseLength = response.headers.get("content-length");
    if (responseLength && /^\d+$/.test(responseLength) && Number(responseLength) > artifact.bytes) {
      cleanupAbort();
      await response.body.cancel();
      throw new ArtifactStoreError(
        "size_mismatch",
        `artifact ${artifact.id} exceeds declared size ${artifact.bytes}`,
      );
    }

    let output;
    try {
      output = await open(temporary, "wx");
    } catch (err) {
      cleanupAbort();
      try {
        await response.body.cancel(err);
      } catch {
        // Preserve the staging-file error.
      }
      throw new ArtifactStoreError(
        "staging_failed",
        err instanceof Error ? err.message : `artifact ${artifact.id} staging failed`,
      );
    }
    const hasher = createHash("sha256");
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await withAbort(reader.read(), abort.signal);
        if (chunk.done) {
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > artifact.bytes) {
          throw new ArtifactStoreError(
            "size_mismatch",
            `artifact ${artifact.id} exceeds declared size ${artifact.bytes}`,
          );
        }
        hasher.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const { bytesWritten } = await output.write(
            chunk.value,
            offset,
            chunk.value.byteLength - offset,
          );
          if (bytesWritten <= 0) {
            throw new Error("artifact staging write made no progress");
          }
          offset += bytesWritten;
        }
      }
      await output.sync();
      if (abort.signal.aborted) {
        throw abort.signal.reason;
      }
    } catch (err) {
      cleanupAbort();
      try {
        await reader.cancel(err);
      } catch {
        // Preserve the original download or filesystem failure.
      }
      try {
        await output.close();
      } catch {
        // The temporary path is still removed below.
      }
      await rm(temporary, { force: true });
      if (abort.signal.aborted && !(err instanceof ArtifactStoreError)) {
        throw new ArtifactStoreError(
          timedOut ? "download_timeout" : "operation_cancelled",
          err instanceof Error ? err.message : `artifact ${artifact.id} download timed out`,
        );
      }
      if (err instanceof ArtifactStoreError) {
        throw err;
      }
      throw new ArtifactStoreError(
        "staging_failed",
        err instanceof Error ? err.message : `artifact ${artifact.id} staging failed`,
      );
    }
    try {
      await output.close();
    } catch (err) {
      cleanupAbort();
      await rm(temporary, { force: true });
      throw new ArtifactStoreError("staging_failed", this.errorMessage(artifact.id, err));
    }
    cleanupAbort();

    const sha256 = hasher.digest("hex");
    if (bytes !== artifact.bytes) {
      await rm(temporary, { force: true });
      throw new ArtifactStoreError(
        "size_mismatch",
        `artifact ${artifact.id} has ${bytes} bytes; expected ${artifact.bytes}`,
      );
    }
    if (sha256 !== artifact.sha256.toLowerCase()) {
      await rm(temporary, { force: true });
      throw new ArtifactStoreError(
        "checksum_mismatch",
        `artifact ${artifact.id} SHA-256 does not match the manifest`,
      );
    }
    try {
      throwIfAborted(signal);
      await rename(temporary, destination);
    } catch (err) {
      await rm(temporary, { force: true });
      if (err instanceof ArtifactStoreError) {
        throw err;
      }
      throw new ArtifactStoreError(
        "staging_failed",
        err instanceof Error ? err.message : `artifact ${artifact.id} staging failed`,
      );
    }
    return {
      artifactId: artifact.id,
      revision: artifact.revision,
      path: destination,
      bytes,
      sha256,
    };
  }

  async getStaged(
    artifact: ArtifactDefinition,
    signal?: AbortSignal,
  ): Promise<StagedArtifact | undefined> {
    if (!isStageableArtifact(artifact)) {
      return undefined;
    }
    const path = this.stagedPath(artifact);
    if (!await this.matches(path, artifact.bytes, artifact.sha256, signal)) {
      return undefined;
    }
    return {
      artifactId: artifact.id,
      revision: artifact.revision,
      path,
      bytes: artifact.bytes,
      sha256: artifact.sha256.toLowerCase(),
    };
  }

  async activate(
    artifact: ArtifactDefinition,
    staged: StagedArtifact,
    signal?: AbortSignal,
  ): Promise<ActivationRecord> {
    throwIfAborted(signal);
    if (!isStageableArtifact(artifact)) {
      throw new ArtifactStoreError(
        "artifact_not_stageable",
        `artifact ${artifact.id} is not a checksummed single-file artifact`,
      );
    }
    const expectedPath = this.stagedPath(artifact);
    if (
      artifact.id !== staged.artifactId
      || artifact.revision !== staged.revision
      || artifact.bytes !== staged.bytes
      || artifact.sha256?.toLowerCase() !== staged.sha256.toLowerCase()
      || resolve(staged.path) !== resolve(expectedPath)
    ) {
      throw new ArtifactStoreError("artifact_mismatch", "staged artifact does not match the manifest");
    }
    if (!await this.matches(staged.path, staged.bytes, staged.sha256, signal)) {
      throw new ArtifactStoreError("staged_invalid", `staged artifact ${artifact.id} failed verification`);
    }
    const target = resolve(artifact.path);
    await mkdir(dirname(target), { recursive: true });
    const rollbackDir = join(this.options.rollbackRoot, artifact.id);
    await mkdir(rollbackDir, { recursive: true });
    const previous = await this.backupTarget(target, rollbackDir);
    throwIfAborted(signal);
    const record: ActivationRecord = {
      artifactId: artifact.id,
      revision: staged.revision,
      target,
      activePath: staged.path,
      previous,
      activatedAt: new Date(this.now()).toISOString(),
    };
    await this.writeActivation(record);
    throwIfAborted(signal);

    const temporaryLink = `${target}.larm-next-${this.random()}`;
    await symlink(staged.path, temporaryLink);
    try {
      throwIfAborted(signal);
      await rename(temporaryLink, target);
    } catch (err) {
      await rm(temporaryLink, { force: true });
      throw err;
    }
    return record;
  }

  async rollback(artifact: ArtifactDefinition): Promise<ActivationRecord> {
    const record = await this.requireRollback(artifact);
    if (record.previous.kind === "none") {
      await rm(record.target, { force: true });
      return record;
    }
    const temporary = `${record.target}.larm-rollback-${this.random()}`;
    if (record.previous.kind === "symlink") {
      await symlink(record.previous.path, temporary);
    } else {
      try {
        await link(record.previous.path, temporary);
      } catch {
        await copyFile(record.previous.path, temporary);
      }
    }
    try {
      await rename(temporary, record.target);
    } catch (err) {
      await rm(temporary, { force: true });
      throw err;
    }
    return record;
  }

  async requireRollback(artifact: ArtifactDefinition): Promise<ActivationRecord> {
    const record = await this.readActivation(artifact.id);
    if (!record) {
      throw new ArtifactStoreError(
        "rollback_unavailable",
        `artifact ${artifact.id} has no activation record`,
      );
    }
    if (
      record.artifactId !== artifact.id
      || record.revision !== artifact.revision
      || resolve(record.target) !== resolve(artifact.path)
    ) {
      throw new ArtifactStoreError(
        "activation_journal_invalid",
        `artifact ${artifact.id} activation record does not match its target`,
      );
    }
    return record;
  }

  async activeMatches(artifact: ArtifactDefinition, signal?: AbortSignal): Promise<boolean> {
    if (!isStageableArtifact(artifact)) {
      return false;
    }
    return await this.matches(artifact.path, artifact.bytes, artifact.sha256, signal);
  }

  async writeOperation(record: ArtifactJournalRecord): Promise<void> {
    if (!SAFE_ID.test(record.id)) {
      throw new ArtifactStoreError("unsafe_operation_id", "operation id is not safe");
    }
    const directory = join(this.options.stateRoot, "operations");
    await mkdir(directory, { recursive: true });
    await this.writeJsonAtomic(join(directory, `${record.id}.json`), record);
  }

  async loadOperations(): Promise<ArtifactJournalRecord[]> {
    const directory = join(this.options.stateRoot, "operations");
    const glob = new Bun.Glob("*.json");
    const records: ArtifactJournalRecord[] = [];
    try {
      for await (const path of glob.scan({ cwd: directory, absolute: true })) {
        const record = JSON.parse(await readFile(path, "utf8")) as Partial<ArtifactJournalRecord>;
        if (
          typeof record.id !== "string"
          || !SAFE_ID.test(record.id)
          || typeof record.status !== "string"
          || basename(path) !== `${record.id}.json`
        ) {
          throw new ArtifactStoreError("journal_corrupt", `invalid operation journal ${path}`);
        }
        records.push(record as ArtifactJournalRecord);
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") {
        throw err;
      }
    }
    return records;
  }

  async deleteOperation(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) {
      throw new ArtifactStoreError("unsafe_operation_id", "operation id is not safe");
    }
    await rm(join(this.options.stateRoot, "operations", `${id}.json`), { force: true });
  }

  private async backupTarget(target: string, rollbackDir: string): Promise<PreviousTarget> {
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        return { kind: "symlink", path: await readlink(target) };
      }
      if (!stat.isFile()) {
        throw new ArtifactStoreError("unsafe_target", `${target} is not a regular file or symlink`);
      }
      const backup = join(rollbackDir, `${this.now()}-${basename(target)}`);
      try {
        await link(target, backup);
      } catch {
        await copyFile(target, backup);
      }
      return { kind: "hardlink", path: backup };
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return { kind: "none" };
      }
      throw err;
    }
  }

  private async matches(
    path: string,
    bytes: number,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const actual = await hashFile(path, signal);
      return actual.bytes === bytes && actual.sha256 === sha256.toLowerCase();
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  private async writeActivation(record: ActivationRecord): Promise<void> {
    const directory = join(this.options.stateRoot, "activations");
    await mkdir(directory, { recursive: true });
    await this.writeJsonAtomic(join(directory, `${record.artifactId}.json`), record);
  }

  private async readActivation(id: string): Promise<ActivationRecord | undefined> {
    try {
      const record = JSON.parse(
        await readFile(join(this.options.stateRoot, "activations", `${id}.json`), "utf8"),
      ) as Partial<ActivationRecord>;
      if (
        record.artifactId !== id
        || typeof record.revision !== "string"
        || typeof record.target !== "string"
        || !isAbsolute(record.target)
        || typeof record.activePath !== "string"
        || !this.withinRoot(this.options.stagingRoot, record.activePath)
        || !record.previous
        || !["hardlink", "symlink", "none"].includes(record.previous.kind)
        || (record.previous.kind !== "none" && typeof record.previous.path !== "string")
        || (record.previous.kind === "hardlink" && !this.withinRoot(
          this.options.rollbackRoot,
          record.previous.path,
        ))
        || typeof record.activatedAt !== "string"
      ) {
        throw new ArtifactStoreError("journal_corrupt", `invalid activation journal for ${id}`);
      }
      return record as ActivationRecord;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.tmp-${this.random()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx" });
      await rename(temporary, path);
    } catch (err) {
      await rm(temporary, { force: true });
      throw err;
    }
  }

  private stagedPath(artifact: ArtifactDefinition & { filename: string; revision: string }): string {
    if (
      !SAFE_ID.test(artifact.id)
      || artifact.revision.startsWith("/")
      || artifact.revision.split("/").includes("..")
      || basename(artifact.filename) !== artifact.filename
    ) {
      throw new ArtifactStoreError("unsafe_path", `artifact ${artifact.id} has an unsafe staging path`);
    }
    return join(
      this.options.stagingRoot,
      artifact.id,
      artifact.revision,
      artifact.filename,
    );
  }

  private withinRoot(root: string, path: string): boolean {
    if (!isAbsolute(path)) {
      return false;
    }
    const child = relative(resolve(root), resolve(path));
    return child !== "" && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(child);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private random(): string {
    return (this.options.random ?? (() => crypto.randomUUID()))();
  }

  private errorMessage(artifactId: string, err: unknown): string {
    return err instanceof Error ? err.message : `artifact ${artifactId} staging failed`;
  }
}
