import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  artifactFileDownloadUrl,
  isFileArtifact,
  isSnapshotArtifact,
  type ArtifactDefinition,
  type FileArtifactDefinition,
  type SnapshotArtifactDefinition,
  type SnapshotFileDefinition,
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
  kind: "file" | "snapshot";
  artifactId: string;
  revision: string;
  path: string;
  bytes: number;
  sha256: string;
};

type PreviousTarget =
  | { kind: "hardlink"; path: string }
  | { kind: "directory"; path: string }
  | { kind: "symlink"; path: string }
  | { kind: "none" };

export type ActivationRecord = {
  artifactKind: "file" | "snapshot";
  artifactDigest: string;
  phase: "prepared" | "active";
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
  incompleteSnapshotTtlMs?: number;
  availableBytes?: (path: string) => number | Promise<number>;
  now?: () => number;
  random?: () => string;
};

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function containsOrEquals(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === ""
    || (relativePath !== ".."
      && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(relativePath));
}

function pathsOverlap(left: string, right: string): boolean {
  return containsOrEquals(left, right) || containsOrEquals(right, left);
}

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
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as { code?: string }).code === "ELOOP") {
      throw new ArtifactStoreError("unsafe_target", `${path} must not be a symbolic link`);
    }
    throw err;
  }
  const hasher = createHash("sha256");
  let bytes = 0;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const before = await file.stat();
    if (!before.isFile()) {
      throw new ArtifactStoreError("unsafe_target", `${path} is not a regular file`);
    }
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      bytes += bytesRead;
      hasher.update(buffer.subarray(0, bytesRead));
    }
    throwIfAborted(signal);
    const after = await file.stat();
    const pathAfter = await lstat(path);
    if (
      !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new ArtifactStoreError(
        "artifact_changed",
        `${path} changed while it was being verified`,
      );
    }
  } finally {
    await file.close();
  }
  return { bytes, sha256: hasher.digest("hex") };
}

export class LocalArtifactStore {
  constructor(private readonly options: LocalArtifactStoreOptions) {
    const roots = Object.entries({
      stagingRoot: options.stagingRoot,
      rollbackRoot: options.rollbackRoot,
      stateRoot: options.stateRoot,
    });
    for (const [name, path] of roots) {
      if (!isAbsolute(path)) {
        throw new ArtifactStoreError("unsafe_path", `${name} must be absolute`);
      }
      if (resolve(path) === "/") {
        throw new ArtifactStoreError("unsafe_path", `${name} must not be the filesystem root`);
      }
    }
    for (const [index, [leftName, leftPath]] of roots.entries()) {
      for (const [rightName, rightPath] of roots.slice(index + 1)) {
        if (pathsOverlap(leftPath, rightPath)) {
          throw new ArtifactStoreError(
            "unsafe_path",
            `${leftName} and ${rightName} must not overlap`,
          );
        }
      }
    }
  }

  async stage(artifact: ArtifactDefinition, signal?: AbortSignal): Promise<StagedArtifact> {
    throwIfAborted(signal);
    if (isSnapshotArtifact(artifact)) {
      return await this.stageSnapshot(artifact, signal);
    }
    if (basename(artifact.filename) !== artifact.filename) {
      throw new ArtifactStoreError("unsafe_filename", `artifact ${artifact.id} has an unsafe filename`);
    }
    const destination = this.stagedPath(artifact);
    await mkdir(dirname(destination), { recursive: true });
    if (await this.matches(destination, artifact.bytes, artifact.sha256, signal)) {
      return {
        kind: "file",
        artifactId: artifact.id,
        revision: artifact.revision,
        path: destination,
        bytes: artifact.bytes,
        sha256: artifact.sha256.toLowerCase(),
      };
    }
    if (await this.destinationIsActive(artifact, destination)) {
      throw new ArtifactStoreError(
        "active_artifact_invalid",
        `artifact ${artifact.id} active staged file failed verification`,
      );
    }

    const availableBytes = await this.availableBytes(dirname(destination));
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
        (this.options.fetchImpl ?? fetch)(artifactFileDownloadUrl(artifact), {
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
      output = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
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
      kind: "file",
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
    if (isSnapshotArtifact(artifact)) {
      const path = this.stagedPath(artifact);
      if (!await this.matchesSnapshot(path, artifact, signal)) {
        return undefined;
      }
      return {
        kind: "snapshot",
        artifactId: artifact.id,
        revision: artifact.revision,
        path,
        bytes: artifact.totalBytes,
        sha256: artifact.snapshotDigest.toLowerCase(),
      };
    }
    if (!isFileArtifact(artifact)) {
      return undefined;
    }
    const path = this.stagedPath(artifact);
    if (!await this.matches(path, artifact.bytes, artifact.sha256, signal)) {
      return undefined;
    }
    return {
      kind: "file",
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
    const expectedPath = this.stagedPath(artifact);
    const expectedBytes = isFileArtifact(artifact) ? artifact.bytes : artifact.totalBytes;
    const expectedSha256 = isFileArtifact(artifact) ? artifact.sha256 : artifact.snapshotDigest;
    if (
      artifact.kind !== staged.kind
      ||
      artifact.id !== staged.artifactId
      || artifact.revision !== staged.revision
      || expectedBytes !== staged.bytes
      || expectedSha256.toLowerCase() !== staged.sha256.toLowerCase()
      || resolve(staged.path) !== resolve(expectedPath)
    ) {
      throw new ArtifactStoreError("artifact_mismatch", "staged artifact does not match the manifest");
    }
    const stagedValid = isFileArtifact(artifact)
      ? await this.matches(staged.path, staged.bytes, staged.sha256, signal)
      : await this.matchesSnapshot(staged.path, artifact, signal);
    if (!stagedValid) {
      throw new ArtifactStoreError("staged_invalid", `staged artifact ${artifact.id} failed verification`);
    }
    const target = resolve(artifact.path);
    await mkdir(dirname(target), { recursive: true });
    const rollbackDir = join(this.options.rollbackRoot, artifact.id);
    await mkdir(rollbackDir, { recursive: true });
    const previous = await this.backupTarget(target, rollbackDir, artifact.kind);
    const record: ActivationRecord = {
      artifactKind: artifact.kind,
      artifactDigest: expectedSha256.toLowerCase(),
      phase: "prepared",
      artifactId: artifact.id,
      revision: staged.revision,
      target,
      activePath: staged.path,
      previous,
      activatedAt: new Date(this.now()).toISOString(),
    };
    try {
      await this.writeActivation(record);
      if (previous.kind === "directory") {
        await rename(target, previous.path);
      }
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
      record.phase = "active";
      await this.writeActivation(record);
    } catch (err) {
      await this.restoreActivation(record);
      await rm(join(await this.activationDirectory(), `${record.artifactId}.json`), {
        force: true,
      });
      throw err;
    }
    return record;
  }

  async rollback(artifact: ArtifactDefinition): Promise<ActivationRecord> {
    const record = await this.requireRollback(artifact);
    await this.restoreActivation(record);
    return record;
  }

  async recoverPreparedActivations(artifacts: ArtifactDefinition[]): Promise<void> {
    for (const artifact of artifacts) {
      const record = await this.readActivation(artifact.id);
      if (!record || record.phase !== "prepared") continue;
      await this.requireRollback(artifact);
      await this.restoreActivation(record);
      await rm(join(await this.activationDirectory(), `${record.artifactId}.json`), {
        force: true,
      });
    }
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
      || record.artifactKind !== artifact.kind
      || record.artifactDigest !== (
        isFileArtifact(artifact) ? artifact.sha256 : artifact.snapshotDigest
      ).toLowerCase()
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
    return isFileArtifact(artifact)
      ? await this.matchesActiveFile(artifact, signal)
      : await this.matchesActiveSnapshot(artifact, signal);
  }

  async writeOperation(record: ArtifactJournalRecord): Promise<void> {
    if (!SAFE_ID.test(record.id)) {
      throw new ArtifactStoreError("unsafe_operation_id", "operation id is not safe");
    }
    const directory = await this.operationDirectory();
    await this.writeJsonAtomic(join(directory, `${record.id}.json`), record);
  }

  async loadOperations(): Promise<ArtifactJournalRecord[]> {
    const directory = await this.operationDirectory();
    const glob = new Bun.Glob("*.json");
    const records: ArtifactJournalRecord[] = [];
    try {
      for await (const path of glob.scan({ cwd: directory, absolute: true })) {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
          throw new ArtifactStoreError("journal_corrupt", `unsafe operation journal ${path}`);
        }
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
    const directory = await this.operationDirectory();
    await rm(join(directory, `${id}.json`), { force: true });
  }

  private async operationDirectory(): Promise<string> {
    return await this.stateDirectory("operations", "artifact operation");
  }

  private async activationDirectory(): Promise<string> {
    return await this.stateDirectory("activations", "artifact activation");
  }

  private async stateDirectory(name: "operations" | "activations", description: string): Promise<string> {
    const stateRoot = resolve(this.options.stateRoot);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const stateMetadata = await lstat(stateRoot);
    if (
      !stateMetadata.isDirectory()
      || stateMetadata.isSymbolicLink()
      || await realpath(stateRoot) !== stateRoot
    ) {
      throw new ArtifactStoreError("journal_corrupt", "artifact state root is unsafe");
    }
    const directory = join(stateRoot, name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new ArtifactStoreError("journal_corrupt", `${description} directory is unsafe`);
    }
    return directory;
  }

  private async stageSnapshot(
    artifact: SnapshotArtifactDefinition,
    signal?: AbortSignal,
  ): Promise<StagedArtifact> {
    const destination = this.stagedPath(artifact);
    await mkdir(dirname(destination), { recursive: true });
    await this.cleanupIncompleteSnapshots(destination);
    if (await this.matchesSnapshot(destination, artifact, signal)) {
      return this.snapshotStaged(artifact, destination);
    }
    if (await this.destinationIsActive(artifact, destination)) {
      throw new ArtifactStoreError(
        "active_artifact_invalid",
        `artifact ${artifact.id} active snapshot failed verification`,
      );
    }
    if (!this.withinRoot(this.options.stagingRoot, destination)) {
      throw new ArtifactStoreError("unsafe_path", `artifact ${artifact.id} has an unsafe staging path`);
    }
    await rm(destination, { recursive: true, force: true });

    const availableBytes = await this.availableBytes(dirname(destination));
    if (availableBytes < artifact.totalBytes) {
      throw new ArtifactStoreError(
        "disk_space_exhausted",
        `artifact ${artifact.id} needs ${artifact.totalBytes} bytes but only ${availableBytes} are available`,
      );
    }

    const temporary = `${destination}.part-${this.random()}`;
    await mkdir(temporary, { mode: 0o700 });
    const abort = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => abort.abort(signal?.reason);
    if (signal?.aborted) {
      abortFromCaller();
    } else {
      signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      abort.abort(new Error("artifact download timeout"));
    }, this.options.downloadTimeoutMs ?? 3_600_000);
    timeout.unref?.();
    const cleanupAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    };

    try {
      for (const file of artifact.files) {
        throwIfAborted(abort.signal);
        const outputPath = resolve(temporary, file.path);
        if (!this.withinRoot(temporary, outputPath)) {
          throw new ArtifactStoreError(
            "unsafe_path",
            `artifact ${artifact.id} contains an unsafe snapshot path`,
          );
        }
        await mkdir(dirname(outputPath), { recursive: true });
        const realParent = await realpath(dirname(outputPath));
        const realTemporary = await realpath(temporary);
        if (realParent !== realTemporary && !this.withinRoot(realTemporary, realParent)) {
          throw new ArtifactStoreError(
            "unsafe_path",
            `artifact ${artifact.id} snapshot parent escaped its temporary root`,
          );
        }
        await this.downloadSnapshotFile(artifact, file, outputPath, abort.signal);
      }
      if (!await this.matchesSnapshot(temporary, artifact, abort.signal)) {
        throw new ArtifactStoreError(
          "snapshot_mismatch",
          `artifact ${artifact.id} snapshot does not match the manifest`,
        );
      }
      throwIfAborted(abort.signal);
      await rename(temporary, destination);
    } catch (err) {
      await rm(temporary, { recursive: true, force: true });
      if (abort.signal.aborted) {
        throw new ArtifactStoreError(
          timedOut ? "download_timeout" : "operation_cancelled",
          err instanceof Error ? err.message : `artifact ${artifact.id} download was cancelled`,
        );
      }
      throw err;
    } finally {
      cleanupAbort();
    }
    return this.snapshotStaged(artifact, destination);
  }

  private async downloadSnapshotFile(
    artifact: SnapshotArtifactDefinition,
    file: SnapshotFileDefinition,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    let response: Response;
    try {
      response = await withAbort(
        (this.options.fetchImpl ?? fetch)(artifactFileDownloadUrl(artifact, file), { signal }),
        signal,
      );
    } catch (err) {
      if (signal.aborted) {
        throw signal.reason;
      }
      throw new ArtifactStoreError(
        "download_failed",
        err instanceof Error ? err.message : `artifact ${artifact.id} download failed`,
      );
    }
    if (!response.ok || !response.body) {
      throw new ArtifactStoreError(
        "download_failed",
        `artifact ${artifact.id} file ${file.path} failed with HTTP ${response.status}`,
      );
    }
    const responseLength = response.headers.get("content-length");
    if (responseLength && /^\d+$/.test(responseLength) && Number(responseLength) > file.bytes) {
      await response.body.cancel();
      throw new ArtifactStoreError(
        "size_mismatch",
        `artifact ${artifact.id} file ${file.path} exceeds declared size ${file.bytes}`,
      );
    }

    let output: Awaited<ReturnType<typeof open>>;
    try {
      output = await open(
        outputPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (err) {
      await response.body.cancel(err).catch(() => undefined);
      throw new ArtifactStoreError(
        "staging_failed",
        err instanceof Error ? err.message : `artifact ${artifact.id} staging failed`,
      );
    }
    const reader = response.body.getReader();
    const hasher = createHash("sha256");
    let bytes = 0;
    try {
      while (true) {
        const chunk = await withAbort(reader.read(), signal);
        if (chunk.done) {
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > file.bytes) {
          throw new ArtifactStoreError(
            "size_mismatch",
            `artifact ${artifact.id} file ${file.path} exceeds declared size ${file.bytes}`,
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
    } catch (err) {
      try {
        await reader.cancel(err);
      } catch {
        // Preserve the original stream or filesystem error.
      }
      throw err;
    } finally {
      await output.close();
    }
    const actualSha256 = hasher.digest("hex");
    if (bytes !== file.bytes) {
      throw new ArtifactStoreError(
        "size_mismatch",
        `artifact ${artifact.id} file ${file.path} has ${bytes} bytes; expected ${file.bytes}`,
      );
    }
    if (actualSha256 !== file.sha256.toLowerCase()) {
      throw new ArtifactStoreError(
        "checksum_mismatch",
        `artifact ${artifact.id} file ${file.path} SHA-256 does not match the manifest`,
      );
    }
  }

  private snapshotStaged(
    artifact: SnapshotArtifactDefinition,
    path: string,
  ): StagedArtifact {
    return {
      kind: "snapshot",
      artifactId: artifact.id,
      revision: artifact.revision,
      path,
      bytes: artifact.totalBytes,
      sha256: artifact.snapshotDigest.toLowerCase(),
    };
  }

  private async matchesSnapshot(
    path: string,
    artifact: SnapshotArtifactDefinition,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const rootStat = await lstat(path);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new ArtifactStoreError(
          "unsafe_snapshot",
          `artifact ${artifact.id} snapshot root must be a real directory`,
        );
      }
      const actualFiles: string[] = [];
      const allowedDirectories = new Set<string>();
      for (const file of artifact.files) {
        const segments = file.path.split("/");
        for (let index = 1; index < segments.length; index += 1) {
          allowedDirectories.add(segments.slice(0, index).join("/"));
        }
      }
      const walk = async (directory: string): Promise<boolean> => {
        throwIfAborted(signal);
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const entry of entries) {
          throwIfAborted(signal);
          const entryPath = join(directory, entry.name);
          const entryStat = await lstat(entryPath);
          if (entryStat.isSymbolicLink()) {
            throw new ArtifactStoreError(
              "unsafe_snapshot",
              `artifact ${artifact.id} snapshot contains a symbolic link`,
            );
          }
          if (entryStat.isDirectory()) {
            const relativeDirectory = relative(path, entryPath).split("\\").join("/");
            if (!allowedDirectories.has(relativeDirectory) || !await walk(entryPath)) {
              return false;
            }
          } else if (entryStat.isFile()) {
            actualFiles.push(relative(path, entryPath).split("\\").join("/"));
            if (actualFiles.length > artifact.files.length) {
              return false;
            }
          } else {
            throw new ArtifactStoreError(
              "unsafe_snapshot",
              `artifact ${artifact.id} snapshot contains a non-regular entry`,
            );
          }
        }
        return true;
      };
      if (!await walk(path)) {
        return false;
      }
      actualFiles.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      const expectedPaths = artifact.files.map((file) => file.path);
      if (actualFiles.length !== expectedPaths.length
        || actualFiles.some((file, index) => file !== expectedPaths[index])) {
        return false;
      }
      for (const file of artifact.files) {
        const actual = await hashFile(join(path, file.path), signal);
        if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256.toLowerCase()) {
          return false;
        }
      }
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  private async cleanupIncompleteSnapshots(destination: string): Promise<void> {
    const directory = dirname(destination);
    const prefix = `${basename(destination)}.part-`;
    const cutoff = this.now() - (this.options.incompleteSnapshotTtlMs ?? 86_400_000);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) {
        continue;
      }
      const candidate = join(directory, entry.name);
      if (!this.withinRoot(this.options.stagingRoot, candidate)) {
        throw new ArtifactStoreError("unsafe_path", "incomplete snapshot path escaped staging root");
      }
      const stat = await lstat(candidate);
      if (stat.mtimeMs <= cutoff) {
        await rm(candidate, { recursive: true, force: true });
      }
    }
  }

  private async destinationIsActive(
    artifact: ArtifactDefinition,
    destination: string,
  ): Promise<boolean> {
    try {
      const stat = await lstat(artifact.path);
      if (!stat.isSymbolicLink()) {
        return false;
      }
      const linked = await readlink(artifact.path);
      return resolve(dirname(artifact.path), linked) === resolve(destination);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  private async matchesActiveSnapshot(
    artifact: SnapshotArtifactDefinition,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const stat = await lstat(artifact.path);
      if (!stat.isSymbolicLink()) {
        return await this.matchesSnapshot(artifact.path, artifact, signal);
      }
      const linked = await readlink(artifact.path);
      const linkedPath = resolve(dirname(artifact.path), linked);
      if (linkedPath !== resolve(this.stagedPath(artifact))) {
        throw new ArtifactStoreError(
          "unsafe_snapshot",
          `artifact ${artifact.id} active link does not point to its pinned staged snapshot`,
        );
      }
      return await this.matchesSnapshot(linkedPath, artifact, signal);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  private async matchesActiveFile(
    artifact: FileArtifactDefinition,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const stat = await lstat(artifact.path);
      if (!stat.isSymbolicLink()) {
        return await this.matches(artifact.path, artifact.bytes, artifact.sha256, signal);
      }
      const linked = await readlink(artifact.path);
      const linkedPath = resolve(dirname(artifact.path), linked);
      if (linkedPath !== resolve(this.stagedPath(artifact))) {
        throw new ArtifactStoreError(
          "unsafe_target",
          `artifact ${artifact.id} active link does not point to its pinned staged file`,
        );
      }
      return await this.matches(linkedPath, artifact.bytes, artifact.sha256, signal);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  private async backupTarget(
    target: string,
    rollbackDir: string,
    artifactKind: ArtifactDefinition["kind"],
  ): Promise<PreviousTarget> {
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        return { kind: "symlink", path: await readlink(target) };
      }
      if (stat.isDirectory()) {
        if (artifactKind !== "snapshot") {
          throw new ArtifactStoreError("unsafe_target", `${target} is a directory for a file artifact`);
        }
        const backup = join(rollbackDir, `${this.now()}-${basename(target)}-${this.random()}`);
        return { kind: "directory", path: backup };
      }
      if (!stat.isFile()) {
        throw new ArtifactStoreError(
          "unsafe_target",
          `${target} is not a regular file, directory, or symlink`,
        );
      }
      if (artifactKind !== "file") {
        throw new ArtifactStoreError("unsafe_target", `${target} is a file for a snapshot artifact`);
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

  private async restoreActivation(record: ActivationRecord): Promise<void> {
    let targetKind: "missing" | "file" | "directory" | "symlink" = "missing";
    try {
      const stat = await lstat(record.target);
      targetKind = stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
        ? "directory"
        : stat.isFile()
        ? "file"
        : "missing";
      if (targetKind === "missing") {
        throw new ArtifactStoreError("active_target_changed", "active target is not a regular entry");
      }
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") {
        throw err;
      }
    }

    if (targetKind === "symlink") {
      const linked = await readlink(record.target);
      if (resolve(dirname(record.target), linked) === resolve(record.activePath)) {
        await rm(record.target, { force: true });
        targetKind = "missing";
      } else if (record.phase === "prepared"
        && record.previous.kind === "symlink"
        && linked === record.previous.path) {
        return;
      } else {
        throw new ArtifactStoreError(
          "active_target_changed",
          `artifact ${record.artifactId} active target points outside its activation record`,
        );
      }
    } else if (targetKind !== "missing") {
      if (record.phase === "prepared"
        && record.previous.kind === "directory"
        && targetKind === "directory"
        && !await this.exists(record.previous.path)) {
        return;
      }
      if (record.phase === "prepared"
        && record.previous.kind === "hardlink"
        && targetKind === "file") {
        return;
      }
      throw new ArtifactStoreError(
        "active_target_changed",
        `artifact ${record.artifactId} active target is no longer the managed symlink`,
      );
    }

    if (record.previous.kind === "none") {
      return;
    }
    if (record.previous.kind === "directory") {
      if (!await this.exists(record.previous.path)) {
        throw new ArtifactStoreError(
          "rollback_unavailable",
          `artifact ${record.artifactId} previous directory is missing`,
        );
      }
      await rename(record.previous.path, record.target);
      return;
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
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return false;
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
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ArtifactStoreError("unsafe_target", `${path} is not a regular file`);
      }
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
    const directory = await this.activationDirectory();
    await this.writeJsonAtomic(join(directory, `${record.artifactId}.json`), record);
  }

  private async readActivation(id: string): Promise<ActivationRecord | undefined> {
    try {
      const directory = await this.activationDirectory();
      const path = join(directory, `${id}.json`);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
        throw new ArtifactStoreError("journal_corrupt", `unsafe activation journal for ${id}`);
      }
      const record = JSON.parse(
        await readFile(path, "utf8"),
      ) as Partial<ActivationRecord>;
      if (
        record.artifactId !== id
        || !["file", "snapshot"].includes(record.artifactKind ?? "")
        || !["prepared", "active"].includes(record.phase ?? "")
        || typeof record.artifactDigest !== "string"
        || !/^[a-f0-9]{64}$/.test(record.artifactDigest)
        || typeof record.revision !== "string"
        || typeof record.target !== "string"
        || !isAbsolute(record.target)
        || typeof record.activePath !== "string"
        || !this.withinRoot(this.options.stagingRoot, record.activePath)
        || !record.previous
        || !["hardlink", "directory", "symlink", "none"].includes(record.previous.kind)
        || (record.previous.kind !== "none" && typeof record.previous.path !== "string")
        || ((record.previous.kind === "hardlink" || record.previous.kind === "directory")
          && !this.withinRoot(
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
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      output = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await output.writeFile(`${JSON.stringify(value)}\n`);
      await output.sync();
      await output.close();
      output = undefined;
      await rename(temporary, path);
      await this.syncDirectory(dirname(path));
    } catch (err) {
      await output?.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw err;
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private stagedPath(artifact: ArtifactDefinition): string {
    if (
      !SAFE_ID.test(artifact.id)
      || resolve(artifact.path) === "/"
      || [
        this.options.stagingRoot,
        this.options.rollbackRoot,
        this.options.stateRoot,
      ].some((root) => pathsOverlap(root, artifact.path))
      || artifact.revision.startsWith("/")
      || artifact.revision.includes("\\")
      || artifact.revision.split("/").some((segment) =>
        segment === "" || segment === "." || segment === ".."
      )
      || (isFileArtifact(artifact) && basename(artifact.filename) !== artifact.filename)
    ) {
      throw new ArtifactStoreError("unsafe_path", `artifact ${artifact.id} has an unsafe staging path`);
    }
    return join(
      this.options.stagingRoot,
      artifact.id,
      artifact.revision,
      isFileArtifact(artifact) ? artifact.filename : artifact.snapshotDigest.toLowerCase(),
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

  private async availableBytes(path: string): Promise<number> {
    if (this.options.availableBytes) {
      return await this.options.availableBytes(path);
    }
    const filesystem = await statfs(path);
    return filesystem.bavail * filesystem.bsize;
  }

  private random(): string {
    return (this.options.random ?? (() => crypto.randomUUID()))();
  }

  private errorMessage(artifactId: string, err: unknown): string {
    return err instanceof Error ? err.message : `artifact ${artifactId} staging failed`;
  }
}
