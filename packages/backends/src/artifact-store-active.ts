import { lstat, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  isFileArtifact,
  type ArtifactDefinition,
  type FileArtifactDefinition,
  type SnapshotArtifactDefinition,
} from "@larm/core";
import { ArtifactStoreError } from "./artifact-store-errors";
import type { ArtifactStoreSnapshotStager } from "./artifact-store-snapshot";

export class ArtifactStoreActiveVerifier {
  constructor(private readonly options: {
    snapshots: ArtifactStoreSnapshotStager;
    stagedPath: (artifact: ArtifactDefinition) => string;
    matchesFile: (
      path: string,
      bytes: number,
      sha256: string,
      signal?: AbortSignal,
    ) => Promise<boolean>;
  }) {}

  async destinationIsActive(
    artifact: ArtifactDefinition,
    destination: string,
  ): Promise<boolean> {
    try {
      const stat = await lstat(artifact.path);
      if (!stat.isSymbolicLink()) return false;
      const linked = await readlink(artifact.path);
      return resolve(dirname(artifact.path), linked) === resolve(destination);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return false;
      throw err;
    }
  }

  async matchesActive(artifact: ArtifactDefinition, signal?: AbortSignal): Promise<boolean> {
    return isFileArtifact(artifact)
      ? await this.matchesActiveFile(artifact, signal)
      : await this.matchesActiveSnapshot(artifact, signal);
  }

  private async matchesActiveSnapshot(
    artifact: SnapshotArtifactDefinition,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const stat = await lstat(artifact.path);
      if (!stat.isSymbolicLink()) {
        return await this.options.snapshots.matches(artifact.path, artifact, signal);
      }
      const linked = await readlink(artifact.path);
      const linkedPath = resolve(dirname(artifact.path), linked);
      if (linkedPath !== resolve(this.options.stagedPath(artifact))) {
        throw new ArtifactStoreError(
          "unsafe_snapshot",
          `artifact ${artifact.id} active link does not point to its pinned staged snapshot`,
        );
      }
      return await this.options.snapshots.matches(linkedPath, artifact, signal);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return false;
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
        return await this.options.matchesFile(artifact.path, artifact.bytes, artifact.sha256, signal);
      }
      const linked = await readlink(artifact.path);
      const linkedPath = resolve(dirname(artifact.path), linked);
      if (linkedPath !== resolve(this.options.stagedPath(artifact))) {
        throw new ArtifactStoreError(
          "unsafe_target",
          `artifact ${artifact.id} active link does not point to its pinned staged file`,
        );
      }
      return await this.options.matchesFile(linkedPath, artifact.bytes, artifact.sha256, signal);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return false;
      throw err;
    }
  }
}
