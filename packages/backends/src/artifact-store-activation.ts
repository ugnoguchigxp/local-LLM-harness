import {
  copyFile,
  link,
  lstat,
  mkdir,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  isFileArtifact,
  type ArtifactDefinition,
} from "@larm/core";
import { ArtifactStoreError } from "./artifact-store-errors";
import {
  throwIfAborted,
} from "./artifact-store-safety";
import {
  ArtifactStoreJournal,
  type ActivationRecord,
  type PreviousTarget,
} from "./artifact-store-journal";
import type { StagedArtifact } from "./artifact-store-types";

export type ArtifactStoreActivationOptions = {
  journal: ArtifactStoreJournal;
  rollbackRoot: string;
  stagedPath: (artifact: ArtifactDefinition) => string;
  matchesStaged: (artifact: ArtifactDefinition, path: string, signal?: AbortSignal) => Promise<boolean>;
  now: () => number;
  random: () => string;
};

export class ArtifactStoreActivation {
  constructor(private readonly options: ArtifactStoreActivationOptions) {}

  async activate(
    artifact: ArtifactDefinition,
    staged: StagedArtifact,
    signal?: AbortSignal,
  ): Promise<ActivationRecord> {
    throwIfAborted(signal);
    const expectedPath = this.options.stagedPath(artifact);
    const expectedBytes = isFileArtifact(artifact) ? artifact.bytes : artifact.totalBytes;
    const expectedSha256 = isFileArtifact(artifact) ? artifact.sha256 : artifact.snapshotDigest;
    if (
      artifact.kind !== staged.kind
      || artifact.id !== staged.artifactId
      || artifact.revision !== staged.revision
      || expectedBytes !== staged.bytes
      || expectedSha256.toLowerCase() !== staged.sha256.toLowerCase()
      || resolve(staged.path) !== resolve(expectedPath)
    ) {
      throw new ArtifactStoreError("artifact_mismatch", "staged artifact does not match the manifest");
    }
    if (!await this.options.matchesStaged(artifact, staged.path, signal)) {
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
      activatedAt: new Date(this.options.now()).toISOString(),
    };
    try {
      await this.options.journal.writeActivation(record);
      if (previous.kind === "directory") {
        await rename(target, previous.path);
      }
      throwIfAborted(signal);
      const temporaryLink = `${target}.larm-next-${this.options.random()}`;
      await symlink(staged.path, temporaryLink);
      try {
        throwIfAborted(signal);
        await rename(temporaryLink, target);
      } catch (err) {
        await rm(temporaryLink, { force: true });
        throw err;
      }
      record.phase = "active";
      await this.options.journal.writeActivation(record);
    } catch (err) {
      await this.restore(record);
      await this.options.journal.deleteActivation(record.artifactId);
      throw err;
    }
    return record;
  }

  async rollback(artifact: ArtifactDefinition): Promise<ActivationRecord> {
    const record = await this.requireRollback(artifact);
    await this.restore(record);
    return record;
  }

  async recoverPreparedActivations(artifacts: ArtifactDefinition[]): Promise<void> {
    for (const artifact of artifacts) {
      const record = await this.options.journal.readActivation(artifact.id);
      if (!record || record.phase !== "prepared") continue;
      await this.requireRollback(artifact);
      await this.restore(record);
      await this.options.journal.deleteActivation(record.artifactId);
    }
  }

  async requireRollback(artifact: ArtifactDefinition): Promise<ActivationRecord> {
    const record = await this.options.journal.readActivation(artifact.id);
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
        const backup = join(rollbackDir, `${this.options.now()}-${basename(target)}-${this.options.random()}`);
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
      const backup = join(rollbackDir, `${this.options.now()}-${basename(target)}`);
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

  private async restore(record: ActivationRecord): Promise<void> {
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

    const temporary = `${record.target}.larm-rollback-${this.options.random()}`;
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
}
