import { createHash } from "node:crypto";
import {
  defaultRuntimeRelease,
  type PublicRuntimeRelease,
  type RuntimeDeployment,
  type RuntimeDeploymentPlan,
  type RuntimeReleaseDefinition,
  type RuntimeSnapshot,
} from "@larm/core";
import {
  type LocalRuntimeReleaseStateStore,
  ReleaseStateStoreError,
  type RuntimeDeploymentRecord,
} from "@larm/backends";
import { ArtifactManager, type ArtifactOperation } from "./artifact-manager";

export class RuntimeReleaseManagerError extends Error {
  constructor(
    readonly code:
      | "release_not_found"
      | "runtime_not_found"
      | "release_runtime_mismatch"
      | "active_release_conflict"
      | "deployment_in_progress"
      | "rollback_unavailable"
      | "catalog_conflict",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeReleaseManagerError";
  }
}

export function runtimeReleaseCatalogRevision(releases: RuntimeReleaseDefinition[]): string {
  const hash = createHash("sha256");
  for (const release of [...releases].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(release.id);
    hash.update("\0");
    hash.update(release.digest);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export class RuntimeReleaseManager {
  private readonly releases: Map<string, RuntimeReleaseDefinition>;
  private readonly deployments = new Map<string, RuntimeDeploymentRecord>();
  private readonly pendingRuntimes = new Set<string>();
  private readonly stateFailures = new Set<string>();
  private readonly catalogRevision: string;

  constructor(
    releases: RuntimeReleaseDefinition[],
    private readonly artifactManager: ArtifactManager,
    private readonly stateStore: LocalRuntimeReleaseStateStore,
    private readonly now: () => number = Date.now,
    private readonly getRuntimeSnapshot?: (runtimeId: string) => RuntimeSnapshot | undefined,
  ) {
    this.catalogRevision = runtimeReleaseCatalogRevision(releases);
    this.releases = new Map(releases.map((release) => [release.id, release]));
  }

  async initialize(): Promise<void> {
    const saved = await this.stateStore.load();
    const catalogRuntimes = new Set([...this.releases.values()].map((release) => release.runtime));
    let changed = saved?.catalogRevision !== this.catalogRevision;
    if (saved) {
      for (const deployment of saved.deployments) {
        if (!catalogRuntimes.has(deployment.runtime)) {
          if (deployment.pending) {
            throw new ReleaseStateStoreError(
              "state_corrupt",
              `retired runtime ${deployment.runtime} has an unfinished deployment`,
            );
          }
          changed = true;
          continue;
        }
        this.validateDeploymentRecord(deployment);
        this.deployments.set(deployment.runtime, deployment);
      }
    }
    for (const deployment of this.deployments.values()) {
      if (deployment.pending) {
        await this.recoverPendingDeployment(deployment);
        changed = true;
      }
    }
    for (const release of this.releases.values()) {
      if (!release.default || this.deployments.has(release.runtime)) {
        continue;
      }
      this.deployments.set(release.runtime, {
        runtime: release.runtime,
        activeRelease: release.id,
        previousRelease: null,
        updatedAt: this.isoNow(),
      });
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  listReleases(): RuntimeReleaseDefinition[] {
    return [...this.releases.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  listPublicReleases(): PublicRuntimeRelease[] {
    return this.listReleases().map((release) => {
      const deployment = this.deployments.get(release.runtime);
      const state: PublicRuntimeRelease["state"] = deployment?.activeRelease === release.id
        ? "active"
        : deployment?.previousRelease === release.id
        ? "previous"
        : this.artifactManager.findLatestOperation({
          kind: "stage",
          releaseId: release.id,
          status: "succeeded",
        })
        ? "staged"
        : "available";
      return { ...release, state };
    });
  }

  getRuntimeArtifacts(runtimeId: string): string[] | undefined {
    const deployment = this.deployments.get(runtimeId);
    const active = deployment?.activeRelease
      ? this.releases.get(deployment.activeRelease)
      : undefined;
    return active?.artifacts ?? defaultRuntimeRelease(this.listReleases(), runtimeId)?.artifacts;
  }

  getActiveRelease(runtimeId: string): string | undefined {
    return this.deployments.get(runtimeId)?.activeRelease ?? undefined;
  }

  getDeployment(runtimeId: string): RuntimeDeployment {
    const desired = defaultRuntimeRelease(this.listReleases(), runtimeId);
    if (!desired) {
      throw new RuntimeReleaseManagerError(
        "runtime_not_found",
        `runtime ${runtimeId} has no release catalog entry`,
      );
    }
    const deployment = this.deployments.get(runtimeId);
    const active = deployment?.activeRelease
      ? this.releases.get(deployment.activeRelease)
      : undefined;
    const previous = deployment?.previousRelease
      ? this.releases.get(deployment.previousRelease)
      : undefined;
    const snapshot = this.getRuntimeSnapshot?.(runtimeId);
    return {
      runtime: runtimeId,
      activeRelease: deployment?.activeRelease ?? null,
      previousRelease: deployment?.previousRelease ?? null,
      desiredRelease: desired.id,
      activeProviderConfigRevision: active?.providerConfigRevision ?? null,
      previousProviderConfigRevision: previous?.providerConfigRevision ?? null,
      desiredProviderConfigRevision: desired.providerConfigRevision,
      catalogRevision: this.catalogRevision,
      pendingRelease: deployment?.pending?.targetRelease,
      stagedReleases: this.listReleases()
        .filter((release) => release.runtime === runtimeId)
        .filter((release) => release.id === deployment?.activeRelease
          || this.artifactManager.findLatestOperation({
            kind: "stage",
            releaseId: release.id,
            status: "succeeded",
          }) !== undefined)
        .map((release) => release.id),
      ...(snapshot
        ? {
          health: {
            status: snapshot.status,
            ok: snapshot.health?.ok,
            observedAt: snapshot.observedAt,
          },
        }
        : {}),
    };
  }

  async stageRelease(releaseId: string): Promise<ArtifactOperation> {
    const release = this.requireRelease(releaseId);
    return await this.artifactManager.stageRelease(release.id, release.artifacts);
  }

  async plan(runtimeId: string, releaseId: string): Promise<RuntimeDeploymentPlan> {
    const release = this.requireRelease(releaseId);
    this.assertReleaseRuntime(release, runtimeId);
    const deployment = this.getDeployment(runtimeId);
    const blockers = this.pendingRuntimes.has(runtimeId)
      ? ["deployment_in_progress"]
      : await this.artifactManager.planRuntimeActivation(runtimeId, release.artifacts);
    const snapshot = this.getRuntimeSnapshot?.(runtimeId);
    const staging = await this.artifactManager.inspectStagedArtifacts(release.artifacts);
    const staged = deployment.activeRelease === release.id || staging.staged;
    return {
      runtime: runtimeId,
      release: releaseId,
      activeRelease: deployment.activeRelease,
      artifacts: release.artifacts,
      providerConfigRevision: release.providerConfigRevision,
      healthPath: release.healthPath,
      runtimeStatus: snapshot?.status,
      requiresStop: snapshot?.status === "HOT"
        || snapshot?.status === "BUSY"
        || snapshot?.status === "STARTING",
      staged,
      rollbackAvailable: deployment.activeRelease !== null,
      disk: {
        additionalBytesRequired: staged ? 0 : staging.additionalBytesRequired,
        checkedDuringStage: staged,
      },
      allowed: blockers.length === 0,
      blockers,
    };
  }

  async activate(
    runtimeId: string,
    releaseId: string,
    expectedActiveRelease: string | null,
  ): Promise<ArtifactOperation> {
    const release = this.requireRelease(releaseId);
    this.assertReleaseRuntime(release, runtimeId);
    if (this.deployments.get(runtimeId)?.activeRelease === releaseId) {
      const previous = this.artifactManager.findLatestOperation({
        kind: "activate",
        runtimeId,
        releaseId,
        status: "succeeded",
      });
      if (previous) return previous;
    }
    this.reserveRuntime(runtimeId);
    const current = this.getDeployment(runtimeId).activeRelease;
    if (current !== expectedActiveRelease) {
      this.pendingRuntimes.delete(runtimeId);
      throw new RuntimeReleaseManagerError(
        "active_release_conflict",
        `runtime ${runtimeId} active release is ${current ?? "none"}, not ${expectedActiveRelease ?? "none"}`,
      );
    }
    const original = this.requireDeploymentRecord(runtimeId);
    const prepared = this.prepareRecord(original, "activate", releaseId);
    this.deployments.set(runtimeId, prepared);
    try {
      await this.persist();
    } catch (error) {
      this.deployments.set(runtimeId, original);
      this.pendingRuntimes.delete(runtimeId);
      throw error;
    }
    let operation: ArtifactOperation;
    try {
      operation = await this.artifactManager.activateRuntimeRelease(
        runtimeId,
        releaseId,
        release.artifacts,
        release.providerConfigRevision,
        release.healthPath,
        async () => {
          const previous = original.activeRelease;
          this.deployments.set(runtimeId, {
            runtime: runtimeId,
            activeRelease: releaseId,
            previousRelease: previous === releaseId ? null : previous,
            updatedAt: this.isoNow(),
          });
          await this.persist();
        },
      );
    } catch (error) {
      this.deployments.set(runtimeId, original);
      await this.persist().catch(() => this.stateFailures.add(runtimeId));
      this.pendingRuntimes.delete(runtimeId);
      throw error;
    }
    if (operation.status === "pending" || operation.status === "running") {
      this.trackRuntimeOperation(runtimeId, operation, original, "activate");
    } else {
      await this.settleTerminalOperation(runtimeId, operation, original, "activate");
    }
    return operation;
  }

  async rollback(runtimeId: string): Promise<ArtifactOperation> {
    this.reserveRuntime(runtimeId);
    const deployment = this.deployments.get(runtimeId);
    if (!deployment?.activeRelease || !deployment.previousRelease) {
      this.pendingRuntimes.delete(runtimeId);
      throw new RuntimeReleaseManagerError(
        "rollback_unavailable",
        `runtime ${runtimeId} has no previous release`,
      );
    }
    const active = this.requireRelease(deployment.activeRelease);
    const previous = this.requireRelease(deployment.previousRelease);
    const original = this.requireDeploymentRecord(runtimeId);
    this.deployments.set(runtimeId, this.prepareRecord(original, "rollback", previous.id));
    try {
      await this.persist();
    } catch (error) {
      this.deployments.set(runtimeId, original);
      this.pendingRuntimes.delete(runtimeId);
      throw error;
    }
    let operation: ArtifactOperation;
    try {
      operation = await this.artifactManager.rollbackRuntimeRelease(
        runtimeId,
        previous.id,
        active.artifacts,
        previous.providerConfigRevision,
        previous.healthPath,
        async () => {
          this.deployments.set(runtimeId, {
            runtime: runtimeId,
            activeRelease: previous.id,
            previousRelease: null,
            updatedAt: this.isoNow(),
          });
          await this.persist();
        },
      );
    } catch (error) {
      this.deployments.set(runtimeId, original);
      await this.persist().catch(() => this.stateFailures.add(runtimeId));
      this.pendingRuntimes.delete(runtimeId);
      throw error;
    }
    if (operation.status === "pending" || operation.status === "running") {
      this.trackRuntimeOperation(runtimeId, operation, original, "rollback");
    } else {
      await this.settleTerminalOperation(runtimeId, operation, original, "rollback");
    }
    return operation;
  }

  isRuntimeMutating(runtimeId: string): boolean {
    return this.pendingRuntimes.has(runtimeId) || this.stateFailures.has(runtimeId);
  }

  private requireRelease(id: string): RuntimeReleaseDefinition {
    const release = this.releases.get(id);
    if (!release) {
      throw new RuntimeReleaseManagerError("release_not_found", `release ${id} is not in the catalog`);
    }
    return release;
  }

  private assertReleaseRuntime(release: RuntimeReleaseDefinition, runtimeId: string): void {
    if (release.runtime !== runtimeId) {
      throw new RuntimeReleaseManagerError(
        "release_runtime_mismatch",
        `release ${release.id} belongs to ${release.runtime}, not ${runtimeId}`,
      );
    }
  }

  private reserveRuntime(runtimeId: string): void {
    if (this.pendingRuntimes.has(runtimeId)) {
      throw new RuntimeReleaseManagerError(
        "deployment_in_progress",
        `runtime ${runtimeId} already has a release operation`,
      );
    }
    this.pendingRuntimes.add(runtimeId);
  }

  private trackRuntimeOperation(
    runtimeId: string,
    operation: ArtifactOperation,
    original: RuntimeDeploymentRecord,
    kind: "activate" | "rollback",
  ): void {
    void this.artifactManager.flush().then(async () => {
      if (operation.status === "succeeded") return;
      await this.reconcileTerminalFailure(runtimeId, operation, original, kind);
    }).catch(() => {
      this.stateFailures.add(runtimeId);
    }).finally(() => {
      this.pendingRuntimes.delete(runtimeId);
    });
  }

  private async settleTerminalOperation(
    runtimeId: string,
    operation: ArtifactOperation,
    original: RuntimeDeploymentRecord,
    kind: "activate" | "rollback",
  ): Promise<void> {
    try {
      if (operation.status !== "succeeded") {
        await this.reconcileTerminalFailure(runtimeId, operation, original, kind);
      }
    } catch (error) {
      this.stateFailures.add(runtimeId);
      throw error;
    } finally {
      this.pendingRuntimes.delete(runtimeId);
    }
  }

  private async reconcileTerminalFailure(
    runtimeId: string,
    operation: ArtifactOperation,
    original: RuntimeDeploymentRecord,
    kind: "activate" | "rollback",
  ): Promise<void> {
    const target = operation.releaseId ? this.releases.get(operation.releaseId) : undefined;
    if (target && await this.artifactManager.areArtifactsActive(target.artifacts)) {
      this.deployments.set(runtimeId, {
        runtime: runtimeId,
        activeRelease: target.id,
        previousRelease: kind === "activate" && original.activeRelease !== target.id
          ? original.activeRelease
          : null,
        updatedAt: this.isoNow(),
      });
      await this.persist();
      return;
    }
    const originalRelease = original.activeRelease
      ? this.releases.get(original.activeRelease)
      : undefined;
    if (originalRelease && await this.artifactManager.areArtifactsActive(originalRelease.artifacts)) {
      this.deployments.set(runtimeId, original);
      await this.persist();
      return;
    }
    throw new ReleaseStateStoreError(
      "state_corrupt",
      `runtime ${runtimeId} terminal deployment state matches neither target nor original release`,
    );
  }

  private validateDeploymentRecord(record: RuntimeDeploymentRecord): void {
    for (const id of [
      record.activeRelease,
      record.previousRelease,
      record.pending?.targetRelease,
      record.pending?.originalActiveRelease,
      record.pending?.originalPreviousRelease,
    ]) {
      if (!id) {
        continue;
      }
      const release = this.releases.get(id);
      if (!release || release.runtime !== record.runtime) {
        throw new ReleaseStateStoreError(
          "state_corrupt",
          `runtime ${record.runtime} references unavailable release ${id}`,
        );
      }
    }
  }

  private async persist(): Promise<void> {
    await this.persistRevision(this.catalogRevision);
  }

  private async persistRevision(catalogRevision: string): Promise<void> {
    await this.stateStore.save({
      version: 1,
      catalogRevision,
      deployments: [...this.deployments.values()].sort((left, right) =>
        left.runtime.localeCompare(right.runtime)
      ),
    });
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private requireDeploymentRecord(runtimeId: string): RuntimeDeploymentRecord {
    const record = this.deployments.get(runtimeId);
    if (!record) {
      throw new RuntimeReleaseManagerError(
        "runtime_not_found",
        `runtime ${runtimeId} has no deployment state`,
      );
    }
    return structuredClone(record);
  }

  private prepareRecord(
    record: RuntimeDeploymentRecord,
    kind: "activate" | "rollback",
    targetRelease: string,
  ): RuntimeDeploymentRecord {
    return {
      ...record,
      pending: {
        kind,
        targetRelease,
        originalActiveRelease: record.activeRelease,
        originalPreviousRelease: record.previousRelease,
        startedAt: this.isoNow(),
      },
      updatedAt: this.isoNow(),
    };
  }

  private async recoverPendingDeployment(record: RuntimeDeploymentRecord): Promise<void> {
    const pending = record.pending!;
    const target = this.requireRelease(pending.targetRelease);
    const targetActive = await this.artifactManager.areArtifactsActive(target.artifacts);
    if (targetActive) {
      this.deployments.set(record.runtime, {
        runtime: record.runtime,
        activeRelease: target.id,
        previousRelease: pending.kind === "activate"
          && pending.originalActiveRelease !== target.id
          ? pending.originalActiveRelease
          : null,
        updatedAt: this.isoNow(),
      });
      return;
    }
    if (!pending.originalActiveRelease) {
      throw new ReleaseStateStoreError(
        "state_corrupt",
        `runtime ${record.runtime} has an incomplete deployment without an original release`,
      );
    }
    const original = this.requireRelease(pending.originalActiveRelease);
    if (!await this.artifactManager.areArtifactsActive(original.artifacts)) {
      throw new ReleaseStateStoreError(
        "state_corrupt",
        `runtime ${record.runtime} artifacts match neither pending release ${target.id} nor original release ${original.id}`,
      );
    }
    this.deployments.set(record.runtime, {
      runtime: record.runtime,
      activeRelease: original.id,
      previousRelease: pending.originalPreviousRelease,
      updatedAt: this.isoNow(),
    });
  }
}
