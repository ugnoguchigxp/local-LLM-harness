import {
  lstat,
  mkdir,
  realpath,
  rm,
  statfs,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  isFileArtifact,
  isSnapshotArtifact,
  type ArtifactDefinition,
} from "@larm/core";
import { ArtifactStoreError } from "./artifact-store-errors";
import { ArtifactStoreActivation } from "./artifact-store-activation";
import { stageFileArtifact } from "./artifact-store-download";
import type { StagedArtifact } from "./artifact-store-types";
import { hashArtifactFile, pathsOverlap, SAFE_ARTIFACT_ID, throwIfAborted } from "./artifact-store-safety";
import {
  ArtifactStoreJournal,
  type ActivationRecord,
  type ArtifactJournalRecord,
} from "./artifact-store-journal";
import { ArtifactStoreSnapshotStager } from "./artifact-store-snapshot";
import { ArtifactStoreActiveVerifier } from "./artifact-store-active";

export type { ActivationRecord, ArtifactJournalRecord } from "./artifact-store-journal";
export type { StagedArtifact } from "./artifact-store-types";

export { ArtifactStoreError } from "./artifact-store-errors";

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

export class LocalArtifactStore {
  private readonly journal: ArtifactStoreJournal;
  private readonly activation: ArtifactStoreActivation;
  private readonly snapshots: ArtifactStoreSnapshotStager;
  private readonly activeVerifier: ArtifactStoreActiveVerifier;

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
    this.journal = new ArtifactStoreJournal({
      stateRoot: options.stateRoot,
      stagingRoot: options.stagingRoot,
      rollbackRoot: options.rollbackRoot,
      now: () => this.now(),
      random: () => this.random(),
    });
    this.snapshots = new ArtifactStoreSnapshotStager({
      stagingRoot: options.stagingRoot,
      downloadTimeoutMs: options.downloadTimeoutMs,
      incompleteSnapshotTtlMs: options.incompleteSnapshotTtlMs,
      fetchImpl: options.fetchImpl,
      availableBytes: (path) => this.availableBytes(path),
      destinationIsActive: (artifact, destination) => this.activeVerifier.destinationIsActive(artifact, destination),
      withinRoot: (root, candidate) => this.withinRoot(root, candidate),
      now: () => this.now(),
      random: () => this.random(),
    });
    this.activeVerifier = new ArtifactStoreActiveVerifier({
      snapshots: this.snapshots,
      stagedPath: (artifact) => this.stagedPath(artifact),
      matchesFile: (path, bytes, sha256, signal) => this.matches(path, bytes, sha256, signal),
    });
    this.activation = new ArtifactStoreActivation({
      journal: this.journal,
      rollbackRoot: options.rollbackRoot,
      stagedPath: (artifact) => this.stagedPath(artifact),
      matchesStaged: async (artifact, path, signal) => isFileArtifact(artifact)
        ? await this.matches(path, artifact.bytes, artifact.sha256, signal)
        : await this.snapshots.matches(path, artifact, signal),
      now: () => this.now(),
      random: () => this.random(),
    });
  }

  async stage(artifact: ArtifactDefinition, signal?: AbortSignal): Promise<StagedArtifact> {
    throwIfAborted(signal);
    if (isSnapshotArtifact(artifact)) {
      return await this.snapshots.stage(artifact, this.stagedPath(artifact), signal);
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
    if (await this.activeVerifier.destinationIsActive(artifact, destination)) {
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

    return await stageFileArtifact({
      artifact,
      destination,
      signal,
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.options.downloadTimeoutMs ?? 3_600_000,
      random: () => this.random(),
    });
  }

  async getStaged(
    artifact: ArtifactDefinition,
    signal?: AbortSignal,
  ): Promise<StagedArtifact | undefined> {
    if (isSnapshotArtifact(artifact)) {
      const path = this.stagedPath(artifact);
      if (!await this.snapshots.matches(path, artifact, signal)) {
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
    return await this.activation.activate(artifact, staged, signal);
  }

  async rollback(artifact: ArtifactDefinition): Promise<ActivationRecord> {
    return await this.activation.rollback(artifact);
  }

  async recoverPreparedActivations(artifacts: ArtifactDefinition[]): Promise<void> {
    await this.activation.recoverPreparedActivations(artifacts);
  }

  async requireRollback(artifact: ArtifactDefinition): Promise<ActivationRecord> {
    return await this.activation.requireRollback(artifact);
  }

  async activeMatches(artifact: ArtifactDefinition, signal?: AbortSignal): Promise<boolean> {
    return await this.activeVerifier.matchesActive(artifact, signal);
  }

  async writeOperation(record: ArtifactJournalRecord): Promise<void> {
    await this.journal.writeOperation(record);
  }

  async loadOperations(): Promise<ArtifactJournalRecord[]> {
    return await this.journal.loadOperations();
  }

  async deleteOperation(id: string): Promise<void> {
    await this.journal.deleteOperation(id);
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
      const actual = await hashArtifactFile(path, signal);
      return actual.bytes === bytes && actual.sha256 === sha256.toLowerCase();
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }


  private stagedPath(artifact: ArtifactDefinition): string {
    if (
      !SAFE_ARTIFACT_ID.test(artifact.id)
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

}
