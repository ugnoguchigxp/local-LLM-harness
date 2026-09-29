import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  artifactFileDownloadUrl,
  type SnapshotArtifactDefinition,
  type SnapshotFileDefinition,
} from "@larm/core";
import { ArtifactStoreError } from "./artifact-store-errors";
import { hashArtifactFile, throwIfAborted, withAbort } from "./artifact-store-safety";
import type { StagedArtifact } from "./artifact-store-types";

export type SnapshotStagerOptions = {
  stagingRoot: string;
  downloadTimeoutMs?: number;
  incompleteSnapshotTtlMs?: number;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  availableBytes: (path: string) => number | Promise<number>;
  destinationIsActive: (artifact: SnapshotArtifactDefinition, destination: string) => Promise<boolean>;
  withinRoot: (root: string, candidate: string) => boolean;
  now: () => number;
  random: () => string;
};

export class ArtifactStoreSnapshotStager {
  constructor(private readonly options: SnapshotStagerOptions) {}

  async stage(
    artifact: SnapshotArtifactDefinition,
    destination: string,
    signal?: AbortSignal,
  ): Promise<StagedArtifact> {
    await mkdir(dirname(destination), { recursive: true });
    await this.cleanupIncompleteSnapshots(destination);
    if (await this.matches(destination, artifact, signal)) {
      return this.staged(artifact, destination);
    }
    if (await this.options.destinationIsActive(artifact, destination)) {
      throw new ArtifactStoreError(
        "active_artifact_invalid",
        `artifact ${artifact.id} active snapshot failed verification`,
      );
    }
    if (!this.options.withinRoot(this.options.stagingRoot, destination)) {
      throw new ArtifactStoreError("unsafe_path", `artifact ${artifact.id} has an unsafe staging path`);
    }
    await rm(destination, { recursive: true, force: true });

    const availableBytes = await this.options.availableBytes(dirname(destination));
    if (availableBytes < artifact.totalBytes) {
      throw new ArtifactStoreError(
        "disk_space_exhausted",
        `artifact ${artifact.id} needs ${artifact.totalBytes} bytes but only ${availableBytes} are available`,
      );
    }

    const temporary = `${destination}.part-${this.options.random()}`;
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
        if (!this.options.withinRoot(temporary, outputPath)) {
          throw new ArtifactStoreError(
            "unsafe_path",
            `artifact ${artifact.id} contains an unsafe snapshot path`,
          );
        }
        await mkdir(dirname(outputPath), { recursive: true });
        const realParent = await realpath(dirname(outputPath));
        const realTemporary = await realpath(temporary);
        if (realParent !== realTemporary && !this.options.withinRoot(realTemporary, realParent)) {
          throw new ArtifactStoreError(
            "unsafe_path",
            `artifact ${artifact.id} snapshot parent escaped its temporary root`,
          );
        }
        await this.downloadFile(artifact, file, outputPath, abort.signal);
      }
      if (!await this.matches(temporary, artifact, abort.signal)) {
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
    return this.staged(artifact, destination);
  }

  async matches(
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
            if (actualFiles.length > artifact.files.length) return false;
          } else {
            throw new ArtifactStoreError(
              "unsafe_snapshot",
              `artifact ${artifact.id} snapshot contains a non-regular entry`,
            );
          }
        }
        return true;
      };
      if (!await walk(path)) return false;
      actualFiles.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      const expectedPaths = artifact.files.map((file) => file.path);
      if (actualFiles.length !== expectedPaths.length
        || actualFiles.some((file, index) => file !== expectedPaths[index])) {
        return false;
      }
      for (const file of artifact.files) {
        const actual = await hashArtifactFile(join(path, file.path), signal);
        if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256.toLowerCase()) return false;
      }
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return false;
      throw err;
    }
  }

  private async cleanupIncompleteSnapshots(destination: string): Promise<void> {
    const directory = dirname(destination);
    const prefix = `${basename(destination)}.part-`;
    const cutoff = this.options.now() - (this.options.incompleteSnapshotTtlMs ?? 86_400_000);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) continue;
      const candidate = join(directory, entry.name);
      if (!this.options.withinRoot(this.options.stagingRoot, candidate)) {
        throw new ArtifactStoreError("unsafe_path", "incomplete snapshot path escaped staging root");
      }
      const stat = await lstat(candidate);
      if (stat.mtimeMs <= cutoff) await rm(candidate, { recursive: true, force: true });
    }
  }

  private async downloadFile(
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
      if (signal.aborted) throw signal.reason;
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
        if (chunk.done) break;
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
          if (bytesWritten <= 0) throw new Error("artifact staging write made no progress");
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

  private staged(artifact: SnapshotArtifactDefinition, path: string): StagedArtifact {
    return {
      kind: "snapshot",
      artifactId: artifact.id,
      revision: artifact.revision,
      path,
      bytes: artifact.totalBytes,
      sha256: artifact.snapshotDigest.toLowerCase(),
    };
  }
}
