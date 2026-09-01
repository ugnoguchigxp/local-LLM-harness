import {
  activeAllocation,
  artifactOperationSchema,
  getRuntime,
  type Allocation,
  type ArtifactDefinition,
  type Registry,
  type RuntimeDefinition,
} from "@larm/core";
import {
  ArtifactStoreError,
  type ArtifactJournalRecord,
  type LocalArtifactStore,
  type RuntimeBackend,
  type StagedArtifact,
} from "@larm/backends";
import type { ControlEvent, DeploymentCoordinator } from "./controller";
import type { Observer } from "./observer";
import {
  type MutationCoordinator,
  MutationCoordinatorError,
  type MutationKind,
  type MutationLease,
} from "./mutation-coordinator";

export type ArtifactOperation = {
  id: string;
  kind: "stage" | "activate" | "rollback";
  artifactId?: string;
  runtimeId?: string;
  releaseId?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "interrupted";
  createdAt: string;
  completedAt?: string;
  error?: { code: string; message: string };
  result?: Record<string, unknown>;
};

export type ArtifactManagerOptions = {
  now?: () => number;
  random?: () => string;
  sleep?: (ms: number) => Promise<void>;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  historyLimit?: number;
  maxPendingOperations?: number;
  activeAllocations: () => Allocation[];
  isRuntimeTransitioning?: (runtimeId: string) => boolean;
  runtimeArtifacts?: (runtimeId: string) => string[] | undefined;
  additionalArtifactOwners?: { runtimeId: string; artifactIds: string[] }[];
  onEvent?: (event: ControlEvent) => void;
  onOperationState?: (active: number) => void;
  mutationCoordinator?: MutationCoordinator;
};

export class ArtifactManager implements DeploymentCoordinator {
  private readonly artifacts = new Map<string, ArtifactDefinition>();
  private readonly operations = new Map<string, ArtifactOperation>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly artifactOwners = new Map<string, Set<string>>();
  private readonly mutationReservations = new Map<string, number>();
  private readonly operationAborts = new Map<string, AbortController>();
  private readonly additionalArtifactOwners: { runtimeId: string; artifactIds: string[] }[];
  private idSequence = 0;

  constructor(
    artifacts: ArtifactDefinition[],
    private readonly registry: Registry,
    private readonly store: LocalArtifactStore,
    private readonly backend: RuntimeBackend,
    private readonly observer: Observer,
    private readonly options: ArtifactManagerOptions,
  ) {
    for (const artifact of artifacts) {
      this.artifacts.set(artifact.id, artifact);
    }
    this.additionalArtifactOwners = options.additionalArtifactOwners ?? [];
    for (const [artifactId, owners] of this.buildArtifactOwners(
      this.artifacts,
      this.registry,
      this.additionalArtifactOwners,
    )) {
      this.artifactOwners.set(artifactId, owners);
    }
  }

  private buildArtifactOwners(
    artifacts: Map<string, ArtifactDefinition>,
    registry: Registry,
    additionalArtifactOwners: { runtimeId: string; artifactIds: string[] }[],
  ): Map<string, Set<string>> {
    const artifactOwners = new Map<string, Set<string>>();
    const ownership = [
      ...registry.runtimes.map((runtime) => ({
        runtimeId: runtime.id,
        artifactIds: runtime.artifacts ?? [],
      })),
      ...additionalArtifactOwners,
    ];
    for (const owner of ownership) {
      for (const artifactId of owner.artifactIds) {
        if (!artifacts.has(artifactId)) {
          throw new ArtifactStoreError(
            "unknown_artifact",
            `runtime ${owner.runtimeId} references unknown artifact ${artifactId}`,
          );
        }
        const owners = artifactOwners.get(artifactId) ?? new Set<string>();
        owners.add(owner.runtimeId);
        artifactOwners.set(artifactId, owners);
      }
    }
    return artifactOwners;
  }

  async initialize(): Promise<void> {
    await this.store.recoverPreparedActivations([...this.artifacts.values()]);
    for (const saved of await this.store.loadOperations()) {
      const operation = this.savedOperation(saved);
      if (operation.status === "pending" || operation.status === "running") {
        operation.status = "interrupted";
        operation.completedAt = this.isoNow();
        operation.error = {
          code: "daemon_restarted",
          message: "operation was interrupted by daemon restart",
        };
        await this.store.writeOperation(operation);
      }
      this.operations.set(operation.id, operation);
    }
    await this.pruneHistory();
    this.emitOperationState();
  }

  getOperation(id: string): ArtifactOperation | undefined {
    return this.operations.get(id);
  }

  findLatestOperation(match: {
    kind: ArtifactOperation["kind"];
    releaseId?: string;
    runtimeId?: string;
    status?: ArtifactOperation["status"];
  }): ArtifactOperation | undefined {
    return [...this.operations.values()]
      .filter((operation) =>
        operation.kind === match.kind
        && (match.releaseId === undefined || operation.releaseId === match.releaseId)
        && (match.runtimeId === undefined || operation.runtimeId === match.runtimeId)
        && (match.status === undefined || operation.status === match.status)
      )
      .sort((left, right) => {
        const created = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        if (created !== 0) return created;
        const completed = Date.parse(right.completedAt ?? right.createdAt)
          - Date.parse(left.completedAt ?? left.createdAt);
        return completed !== 0 ? completed : right.id.localeCompare(left.id);
      })[0];
  }

  isRuntimeMutating(runtimeId: string): boolean {
    return (this.mutationReservations.get(runtimeId) ?? 0) > 0;
  }

  hasActiveOperations(): boolean {
    return [...this.operations.values()].some((operation) =>
      operation.status === "pending" || operation.status === "running"
    ) || this.mutationReservations.size > 0;
  }

  activeOperationCount(): number {
    return [...this.operations.values()].filter((operation) =>
      operation.status === "pending" || operation.status === "running"
    ).length;
  }

  async planRuntimeActivation(runtimeId: string, artifactIds: string[]): Promise<string[]> {
    const blockers: string[] = [];
    const runtime = getRuntime(this.registry, runtimeId);
    const validation = this.validateMutableRuntime(runtime);
    if (validation) {
      blockers.push(validation.code);
    }
    if (artifactIds.length === 0) {
      blockers.push("artifact_not_declared");
    }
    for (const artifactId of artifactIds) {
      try {
        const artifact = this.requireArtifact(artifactId);
        if (!await this.store.getStaged(artifact)) {
          blockers.push(`artifact_not_staged:${artifactId}`);
        }
      } catch (error) {
        blockers.push(error instanceof ArtifactStoreError ? error.code : "not_found");
      }
    }
    if (runtime && blockers.length === 0) {
      try {
        await this.observer.tick();
        await this.assertMutationSafe(runtimeId, artifactIds);
      } catch (error) {
        blockers.push(error instanceof ArtifactStoreError ? error.code : "deployment_blocked");
      }
    }
    return [...new Set(blockers)];
  }

  async inspectStagedArtifacts(artifactIds: string[]): Promise<{
    staged: boolean;
    additionalBytesRequired: number;
  }> {
    let additionalBytesRequired = 0;
    for (const artifactId of [...new Set(artifactIds)]) {
      const artifact = this.requireArtifact(artifactId);
      if (!await this.store.getStaged(artifact)) {
        additionalBytesRequired += artifact.kind === "file"
          ? artifact.bytes
          : artifact.totalBytes;
      }
    }
    return {
      staged: additionalBytesRequired === 0,
      additionalBytesRequired,
    };
  }

  async areArtifactsActive(artifactIds: string[], signal?: AbortSignal): Promise<boolean> {
    if (artifactIds.length === 0) {
      return false;
    }
    for (const artifactId of artifactIds) {
      if (!await this.store.activeMatches(this.requireArtifact(artifactId), signal)) {
        return false;
      }
    }
    return true;
  }

  beginDrain(): void {
    const reason = new Error("artifact manager is draining");
    for (const abort of this.operationAborts.values()) {
      abort.abort(reason);
    }
  }

  async flush(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all([...this.queues.values()]);
    }
  }

  async stage(artifactId: string): Promise<ArtifactOperation> {
    const artifact = this.artifacts.get(artifactId);
    const operation = this.createOperation("stage", { artifactId });
    const mutationLease = await this.acquireMutation(operation, "artifact-stage");
    if (!mutationLease && this.options.mutationCoordinator) return operation;
    let handedOff = false;
    try {
      if (await this.rejectAtCapacity(operation)) {
        return operation;
      }
      await this.persistPending(operation);
      if (!artifact) {
        await this.fail(operation, "not_found", `artifact ${artifactId} is not in the manifest`);
        return operation;
      }
      const abort = new AbortController();
      this.operationAborts.set(operation.id, abort);
      this.enqueue(`artifact:${artifactId}`, async () => {
        try {
          await this.run(operation, async () => {
            const staged = await this.store.stage(artifact, abort.signal);
            return { path: staged.path, bytes: staged.bytes, sha256: staged.sha256 };
          });
        } finally {
          this.operationAborts.delete(operation.id);
          mutationLease?.release();
        }
      });
      handedOff = true;
      return operation;
    } finally {
      if (!handedOff) mutationLease?.release();
    }
  }

  async stageRelease(releaseId: string, artifactIds: string[]): Promise<ArtifactOperation> {
    const existing = this.findLatestOperation({ kind: "stage", releaseId });
    if (existing) {
      if (existing.status === "pending" || existing.status === "running") return existing;
      if (existing.status === "succeeded") {
        try {
          if ((await this.inspectStagedArtifacts(artifactIds)).staged) return existing;
        } catch {
          // Re-run validation in the new operation so the failure is journaled for the caller.
        }
      }
    }
    const operation = this.createOperation("stage", { releaseId });
    const mutationLease = await this.acquireMutation(operation, "artifact-stage");
    if (!mutationLease && this.options.mutationCoordinator) return operation;
    let handedOff = false;
    try {
      if (await this.rejectAtCapacity(operation)) {
        return operation;
      }
      await this.persistPending(operation);
      let artifacts: ArtifactDefinition[];
      try {
        artifacts = [...new Set(artifactIds)].map((id) => this.requireArtifact(id));
        if (artifacts.length === 0) {
          throw new ArtifactStoreError("artifact_not_declared", `release ${releaseId} has no artifacts`);
        }
      } catch (error) {
        await this.fail(
          operation,
          error instanceof ArtifactStoreError ? error.code : "not_found",
          this.errorMessage(error),
        );
        return operation;
      }
      const abort = new AbortController();
      this.operationAborts.set(operation.id, abort);
      this.enqueue(`release:${releaseId}`, async () => {
        try {
          await this.run(operation, async () => {
            const staged: StagedArtifact[] = [];
            await this.withArtifactLocks(artifacts.map((artifact) => artifact.id), async () => {
              for (const artifact of artifacts) {
                this.throwIfAborted(abort.signal);
                staged.push(await this.store.stage(artifact, abort.signal));
              }
            });
            return {
              release: releaseId,
              artifacts: staged.map((item) => item.artifactId),
            };
          });
        } finally {
          this.operationAborts.delete(operation.id);
          mutationLease?.release();
        }
      });
      handedOff = true;
      return operation;
    } finally {
      if (!handedOff) mutationLease?.release();
    }
  }

  async activateRuntimeRelease(
    runtimeId: string,
    releaseId: string,
    artifactIds: string[],
    providerConfigRevision: string,
    healthPath: string,
    onActivated: () => Promise<void>,
  ): Promise<ArtifactOperation> {
    return await this.activateRuntimeArtifacts(
      runtimeId,
      artifactIds,
      releaseId,
      providerConfigRevision,
      healthPath,
      onActivated,
    );
  }

  private async activateRuntimeArtifacts(
    runtimeId: string,
    artifactIds: string[],
    releaseId?: string,
    providerConfigRevision?: string,
    healthPath = "/health",
    onActivated?: () => Promise<void>,
  ): Promise<ArtifactOperation> {
    const operation = this.createOperation("activate", { runtimeId, releaseId });
    const mutationLease = await this.acquireMutation(operation, "runtime-activation");
    if (!mutationLease && this.options.mutationCoordinator) return operation;
    let handedOff = false;
    let releaseReservation: (() => void) | undefined;
    try {
      if (await this.rejectAtCapacity(operation)) return operation;
      await this.persistPending(operation);
      const runtime = getRuntime(this.registry, runtimeId);
      const validation = this.validateMutableRuntime(runtime);
      if (validation) {
        await this.fail(operation, validation.code, validation.message);
        return operation;
      }
      const healthContractError = this.validateHealthContract(runtime, healthPath);
      if (healthContractError) {
        await this.fail(operation, "health_contract_mismatch", healthContractError);
        return operation;
      }
      if (artifactIds.length === 0) {
        await this.fail(operation, "artifact_not_declared", `runtime ${runtimeId} has no release artifacts`);
        return operation;
      }
      try {
        artifactIds.forEach((artifactId) => this.requireArtifact(artifactId));
      } catch (error) {
        await this.fail(operation, "not_found", this.errorMessage(error));
        return operation;
      }
      releaseReservation = this.reserveRuntimeMutation(this.affectedRuntimeIds(artifactIds));
      const abort = new AbortController();
      this.operationAborts.set(operation.id, abort);
      this.enqueue(`runtime:${runtimeId}`, async () => {
        try {
          await this.run(operation, async () => {
            this.throwIfAborted(abort.signal);
            const staged = await this.stagedArtifactsFor(artifactIds, abort.signal);
            let changed: StagedArtifact[] = [];
            await this.withArtifactLocks(staged.map((item) => item.artifactId), async () => {
              changed = await this.changedArtifacts(staged, abort.signal);
              if (changed.length === 0) {
                await onActivated?.();
                return;
              }
              await this.observer.tick();
              this.throwIfAborted(abort.signal);
              await this.assertMutationSafe(runtimeId, changed.map((item) => item.artifactId));
              await this.activateStagedRuntime(
                runtime!,
                changed,
                () => undefined,
                abort.signal,
                onActivated,
              );
            });
            if (changed.length === 0) {
              return {
                runtime: runtimeId,
                release: releaseId,
                providerConfigRevision,
                healthPath,
                artifacts: [],
                current: true,
              };
            }
            return {
              runtime: runtimeId,
              release: releaseId,
              providerConfigRevision,
              healthPath,
              artifacts: changed.map((item) => item.artifactId),
            };
          });
        } finally {
          this.operationAborts.delete(operation.id);
          releaseReservation?.();
          mutationLease?.release();
        }
      });
      handedOff = true;
      return operation;
    } finally {
      if (!handedOff) {
        releaseReservation?.();
        mutationLease?.release();
      }
    }
  }

  async rollbackRuntimeRelease(
    runtimeId: string,
    releaseId: string,
    artifactIds: string[],
    providerConfigRevision: string,
    healthPath: string,
    onRolledBack: () => Promise<void>,
  ): Promise<ArtifactOperation> {
    return await this.rollbackRuntimeArtifacts(
      runtimeId,
      artifactIds,
      releaseId,
      providerConfigRevision,
      healthPath,
      onRolledBack,
    );
  }

  private async rollbackRuntimeArtifacts(
    runtimeId: string,
    artifactIds: string[],
    releaseId?: string,
    providerConfigRevision?: string,
    healthPath = "/health",
    onRolledBack?: () => Promise<void>,
  ): Promise<ArtifactOperation> {
    const operation = this.createOperation("rollback", { runtimeId, releaseId });
    const mutationLease = await this.acquireMutation(operation, "runtime-rollback");
    if (!mutationLease && this.options.mutationCoordinator) return operation;
    let handedOff = false;
    let releaseReservation: (() => void) | undefined;
    try {
      if (await this.rejectAtCapacity(operation)) return operation;
      await this.persistPending(operation);
      const runtime = getRuntime(this.registry, runtimeId);
      const validation = this.validateMutableRuntime(runtime);
      if (validation) {
        await this.fail(operation, validation.code, validation.message);
        return operation;
      }
      const healthContractError = this.validateHealthContract(runtime, healthPath);
      if (healthContractError) {
        await this.fail(operation, "health_contract_mismatch", healthContractError);
        return operation;
      }
      if (artifactIds.length === 0) {
        await this.fail(operation, "artifact_not_declared", `runtime ${runtimeId} has no release artifacts`);
        return operation;
      }
      releaseReservation = this.reserveRuntimeMutation(this.affectedRuntimeIds(artifactIds));
      this.enqueue(`runtime:${runtimeId}`, async () => {
        try {
          await this.run(operation, async () => {
            await this.withArtifactLocks(artifactIds, async () => {
              await Promise.all(
                artifactIds.map((artifactId) =>
                  this.store.requireRollback(this.requireArtifact(artifactId))
                ),
              );
              await this.observer.tick();
              await this.assertMutationSafe(runtimeId, artifactIds);
              const status = this.runtimeStatus(runtimeId);
              const wasLive = status === "HOT" || status === "BUSY" || status === "STARTING";
              await this.stopIfLive(runtime!);
              for (const artifactId of [...artifactIds].reverse()) {
                await this.store.rollback(this.requireArtifact(artifactId));
              }
              if (wasLive) {
                await this.backend.ensure(runtime!);
                await this.waitForRuntime(runtimeId);
              }
              await onRolledBack?.();
            });
            return {
              runtime: runtimeId,
              release: releaseId,
              providerConfigRevision,
              healthPath,
              rolledBack: artifactIds,
            };
          });
        } finally {
          releaseReservation?.();
          mutationLease?.release();
        }
      });
      handedOff = true;
      return operation;
    } finally {
      if (!handedOff) {
        releaseReservation?.();
        mutationLease?.release();
      }
    }
  }

  async ensureRuntime(
    runtimeId: string,
    allocationId?: string,
    onPhase: (phase: string) => void = () => undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const runtime = getRuntime(this.registry, runtimeId);
    let mutationLease: MutationLease | undefined;
    try {
      mutationLease = this.options.mutationCoordinator?.reserve("allocation-deployment");
    } catch (error) {
      if (error instanceof MutationCoordinatorError) {
        throw new ArtifactStoreError(error.code, error.message);
      }
      throw error;
    }
    const releaseReservation = this.reserveRuntimeMutation(
      this.affectedRuntimeIds(runtime?.artifacts ?? []),
    );
    try {
      await this.serialize(`runtime:${runtimeId}`, async () => {
        this.throwIfAborted(signal);
        await this.ensureRuntimeUnlocked(runtimeId, allocationId, onPhase, signal);
      });
    } finally {
      releaseReservation();
      mutationLease?.release();
    }
  }

  private async ensureRuntimeUnlocked(
    runtimeId: string,
    allocationId: string | undefined,
    onPhase: (phase: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.throwIfAborted(signal);
    onPhase("checking-artifacts");
    const runtime = getRuntime(this.registry, runtimeId);
    if (!runtime) {
      throw new ArtifactStoreError("not_found", `runtime ${runtimeId} is not in the registry`);
    }
    const artifacts = this.runtimeArtifactIds(runtime).map((id) => this.requireArtifact(id));
    if (artifacts.length === 0) {
      throw new ArtifactStoreError(
        "artifact_not_declared",
        `runtime ${runtimeId} has no declared artifacts`,
      );
    }
    await this.withArtifactLocks(artifacts.map((artifact) => artifact.id), async () => {
      const matches = await Promise.all(
        artifacts.map((artifact) => this.store.activeMatches(artifact, signal)),
      );
      const changedArtifacts = artifacts.filter((_, index) => !matches[index]);
      if (changedArtifacts.length === 0) {
        onPhase("artifacts-current");
        return;
      }
      if (runtime.policy.class === "resident") {
        throw new ArtifactStoreError(
          "resident_activation_forbidden",
          `resident runtime ${runtimeId} requires attended artifact activation`,
        );
      }
      await this.observer.tick();
      await this.assertMutationSafe(
        runtimeId,
        changedArtifacts.map((artifact) => artifact.id),
        allocationId,
      );
      const operation = this.createOperation("activate", { runtimeId });
      if (await this.rejectAtCapacity(operation)) {
        throw new ArtifactStoreError(
          "artifact_operation_capacity",
          operation.error?.message ?? "artifact operation capacity has been reached",
        );
      }
      await this.persistPending(operation);
      await this.run(operation, async () => {
        const staged: StagedArtifact[] = [];
        onPhase("staging-artifacts");
        for (const artifact of changedArtifacts) {
          this.throwIfAborted(signal);
          staged.push(await this.store.stage(artifact, signal));
        }
        await this.activateStagedRuntime(runtime, staged, onPhase, signal);
        return { runtime: runtimeId, artifacts: staged.map((item) => item.artifactId) };
      }, true);
    });
  }

  private async activateStagedRuntime(
    runtime: RuntimeDefinition,
    staged: StagedArtifact[],
    onPhase: (phase: string) => void = () => undefined,
    signal?: AbortSignal,
    onActivated?: () => Promise<void>,
  ): Promise<void> {
    this.throwIfAborted(signal);
    const status = this.runtimeStatus(runtime.id);
    const wasLive = status === "HOT" || status === "BUSY" || status === "STARTING";
    onPhase("stopping-runtime");
    await this.stopIfLive(runtime);

    let activated = false;
    try {
      onPhase("activating-artifacts");
      await this.activateAll(runtime, staged, signal);
      activated = true;
      this.throwIfAborted(signal);
      onPhase("starting-runtime");
      await this.backend.ensure(runtime, signal);
      this.throwIfAborted(signal);
      onPhase("verifying-runtime");
      await this.waitForRuntime(runtime.id, signal);
      await onActivated?.();
      onPhase("runtime-ready");
    } catch (err) {
      if (activated) {
        onPhase("rolling-back");
        try {
          await this.restorePreviousRuntime(
            runtime,
            wasLive,
            staged.map((item) => item.artifactId),
          );
        } catch (rollbackError) {
          throw new ArtifactStoreError(
            "activation_rollback_failed",
            `${this.errorMessage(err)}; rollback failed: ${this.errorMessage(rollbackError)}`,
          );
        }
      } else if (
        wasLive
        && !(err instanceof ArtifactStoreError && err.code === "activation_rollback_failed")
      ) {
        await this.backend.ensure(runtime);
        await this.waitForRuntime(runtime.id);
      }
      throw err;
    }
  }

  private async activateAll(
    runtime: RuntimeDefinition,
    staged: StagedArtifact[],
    signal?: AbortSignal,
  ): Promise<void> {
    const activated: ArtifactDefinition[] = [];
    try {
      for (const item of staged) {
        this.throwIfAborted(signal);
        const artifact = this.requireArtifact(item.artifactId);
        await this.store.activate(artifact, item, signal);
        activated.push(artifact);
      }
    } catch (err) {
      let rollbackFailure: unknown;
      for (const artifact of activated.reverse()) {
        try {
          await this.store.rollback(artifact);
        } catch (rollbackError) {
          rollbackFailure ??= rollbackError;
        }
      }
      if (rollbackFailure) {
        throw new ArtifactStoreError(
          "activation_rollback_failed",
          `${this.errorMessage(err)}; rollback failed: ${this.errorMessage(rollbackFailure)}`,
        );
      }
      throw err;
    }
    this.emit("artifact_activation", { runtime: runtime.id });
  }

  private async stagedArtifactsFor(
    artifactIds: string[],
    signal?: AbortSignal,
  ): Promise<StagedArtifact[]> {
    const staged: StagedArtifact[] = [];
    for (const artifactId of artifactIds) {
      this.throwIfAborted(signal);
      const artifact = this.requireArtifact(artifactId);
      const item = await this.store.getStaged(artifact, signal);
      if (!item) {
        throw new ArtifactStoreError("artifact_not_staged", `artifact ${artifactId} is not staged`);
      }
      staged.push(item);
    }
    return staged;
  }

  private runtimeArtifactIds(runtime: RuntimeDefinition | undefined): string[] {
    if (!runtime) {
      return [];
    }
    return this.options.runtimeArtifacts?.(runtime.id) ?? runtime.artifacts ?? [];
  }

  private async changedArtifacts(
    staged: StagedArtifact[],
    signal?: AbortSignal,
  ): Promise<StagedArtifact[]> {
    const changed: StagedArtifact[] = [];
    for (const item of staged) {
      this.throwIfAborted(signal);
      if (!await this.store.activeMatches(this.requireArtifact(item.artifactId), signal)) {
        changed.push(item);
      }
    }
    return changed;
  }

  private affectedRuntimeIds(artifactIds: string[]): string[] {
    const affected = new Set<string>();
    for (const artifactId of artifactIds) {
      for (const runtimeId of this.artifactOwners.get(artifactId) ?? []) {
        affected.add(runtimeId);
      }
    }
    return [...affected].sort();
  }

  private reserveRuntimeMutation(runtimeIds: string[]): () => void {
    for (const runtimeId of runtimeIds) {
      this.mutationReservations.set(
        runtimeId,
        (this.mutationReservations.get(runtimeId) ?? 0) + 1,
      );
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      for (const runtimeId of runtimeIds) {
        const remaining = (this.mutationReservations.get(runtimeId) ?? 1) - 1;
        if (remaining <= 0) {
          this.mutationReservations.delete(runtimeId);
        } else {
          this.mutationReservations.set(runtimeId, remaining);
        }
      }
    };
  }

  private async withArtifactLocks(
    artifactIds: string[],
    work: () => Promise<void>,
  ): Promise<void> {
    const keys = [...new Set(artifactIds)].sort();
    const acquire = async (index: number): Promise<void> => {
      const artifactId = keys[index];
      if (!artifactId) {
        await work();
        return;
      }
      await this.serialize(`artifact:${artifactId}`, async () => {
        await acquire(index + 1);
      });
    };
    await acquire(0);
  }

  private validateMutableRuntime(runtime: RuntimeDefinition | undefined) {
    if (!runtime) {
      return { code: "not_found", message: "runtime is not in the registry" };
    }
    if (runtime.policy.class === "resident") {
      return {
        code: "resident_activation_forbidden",
        message: `resident runtime ${runtime.id} requires attended activation`,
      };
    }
    if (!runtime.artifacts || runtime.artifacts.length === 0) {
      return {
        code: "artifact_not_declared",
        message: `runtime ${runtime.id} has no declared artifacts`,
      };
    }
    return undefined;
  }

  private async assertMutationSafe(
    runtimeId: string,
    artifactIds: string[],
    exceptAllocationId?: string,
  ): Promise<void> {
    const affectedRuntimeIds = this.affectedRuntimeIds(artifactIds);
    const transitioning = affectedRuntimeIds.find((affectedRuntimeId) =>
      this.options.isRuntimeTransitioning?.(affectedRuntimeId)
    );
    if (transitioning) {
      throw new ArtifactStoreError(
        "runtime_transition_in_progress",
        `runtime ${transitioning} is changing lifecycle state`,
      );
    }
    const inUse = this.options.activeAllocations().some(
      (allocation) =>
        allocation.id !== exceptAllocationId &&
        activeAllocation(allocation.status) &&
        allocation.bindings.some((binding) => affectedRuntimeIds.includes(binding.runtime)),
    );
    if (inUse) {
      throw new ArtifactStoreError(
        "runtime_in_use",
        `runtime ${runtimeId} has an active allocation`,
      );
    }
    for (const affectedRuntimeId of affectedRuntimeIds) {
      if (affectedRuntimeId === runtimeId) {
        continue;
      }
      const status = this.runtimeStatus(affectedRuntimeId);
      if (status !== "COLD" && status !== "FAILED") {
        throw new ArtifactStoreError(
          "shared_artifact_in_use",
          `shared artifact is in use by runtime ${affectedRuntimeId}`,
        );
      }
    }
  }

  private async stopIfLive(runtime: RuntimeDefinition): Promise<void> {
    const status = this.runtimeStatus(runtime.id);
    if (status && status !== "COLD" && status !== "FAILED") {
      await this.backend.stop(runtime.id);
      await this.observer.tick();
    }
  }

  private async restorePreviousRuntime(
    runtime: RuntimeDefinition,
    wasLive: boolean,
    artifactIds: string[],
  ): Promise<void> {
    try {
      await this.backend.stop(runtime.id);
      await this.observer.tick();
    } catch {
      // Roll back the filesystem target even when a failed process cannot be stopped cleanly.
    }
    for (const artifactId of [...artifactIds].reverse()) {
      await this.store.rollback(this.requireArtifact(artifactId));
    }
    if (wasLive) {
      await this.backend.ensure(runtime);
      await this.waitForRuntime(runtime.id);
    }
  }

  private runtimeStatus(runtimeId: string) {
    return this.observer.getState().runtimes.find((item) => item.id === runtimeId)?.status;
  }

  private async waitForRuntime(runtimeId: string, signal?: AbortSignal): Promise<void> {
    const deadline = this.now() + (this.options.startupTimeoutMs ?? 300_000);
    while (this.now() < deadline) {
      this.throwIfAborted(signal);
      const state = await this.observer.tick();
      this.throwIfAborted(signal);
      const status = state.runtimes.find((item) => item.id === runtimeId)?.status;
      if (status === "HOT" || status === "BUSY") {
        return;
      }
      if (status === "FAILED") {
        throw new ArtifactStoreError("runtime_failed", `runtime ${runtimeId} failed after activation`);
      }
      await (this.options.sleep ?? ((ms: number) => Bun.sleep(ms)))(
        this.options.pollIntervalMs ?? 500,
      );
    }
    throw new ArtifactStoreError("startup_timeout", `runtime ${runtimeId} did not become ready`);
  }

  private createOperation(
    kind: ArtifactOperation["kind"],
    target: Pick<ArtifactOperation, "artifactId" | "runtimeId" | "releaseId">,
  ): ArtifactOperation {
    const base = `artifact_op_${this.random()}`;
    let id = base;
    while (this.operations.has(id)) {
      this.idSequence += 1;
      id = `${base}_${this.idSequence}`;
    }
    const operation: ArtifactOperation = {
      id,
      kind,
      ...target,
      status: "pending",
      createdAt: this.isoNow(),
    };
    this.operations.set(operation.id, operation);
    this.emitOperationState();
    return operation;
  }

  private enqueue(key: string, work: () => Promise<void>): void {
    void this.serialize(key, work).catch(() => undefined);
  }

  private serialize(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.then(work);
    const tracked = result.catch(() => undefined).finally(() => {
      if (this.queues.get(key) === tracked) {
        this.queues.delete(key);
      }
    });
    this.queues.set(key, tracked);
    return result;
  }

  private async run(
    operation: ArtifactOperation,
    work: () => Promise<Record<string, unknown>>,
    rethrow = false,
  ): Promise<void> {
    operation.status = "running";
    this.emitOperationState();
    try {
      await this.store.writeOperation(operation);
    } catch (err) {
      operation.status = "failed";
      operation.completedAt = this.isoNow();
      operation.error = {
        code: "journal_write_failed",
        message: this.errorMessage(err),
      };
      this.emit(`artifact_${operation.kind}_failed`, {
        artifact: operation.artifactId ?? "multiple",
        runtime: operation.runtimeId ?? "none",
        reason: "journal_write_failed",
      });
      await this.pruneHistory();
      this.emitOperationState();
      if (rethrow) {
        throw new ArtifactStoreError("journal_write_failed", this.errorMessage(err));
      }
      return;
    }
    let failure: unknown;
    try {
      operation.result = await work();
      operation.status = "succeeded";
      operation.completedAt = this.isoNow();
      this.emit(`artifact_${operation.kind}_succeeded`, {
        artifact: operation.artifactId ?? "multiple",
        runtime: operation.runtimeId ?? "none",
      });
    } catch (err) {
      failure = err;
      const code = err instanceof ArtifactStoreError ? err.code : "artifact_operation_failed";
      operation.status = "failed";
      operation.completedAt = this.isoNow();
      operation.error = {
        code,
        message: err instanceof Error ? err.message : String(err),
      };
      this.emit(`artifact_${operation.kind}_failed`, {
        artifact: operation.artifactId ?? "multiple",
        runtime: operation.runtimeId ?? "none",
        reason: code,
      });
    }
    try {
      await this.store.writeOperation(operation);
    } catch (err) {
      operation.status = "failed";
      operation.completedAt = this.isoNow();
      operation.error = {
        code: "journal_write_failed",
        message: this.errorMessage(err),
      };
      throw new ArtifactStoreError("journal_write_failed", this.errorMessage(err));
    } finally {
      await this.pruneHistory();
      this.emitOperationState();
    }
    if (failure && rethrow) {
      throw failure;
    }
  }

  private async fail(operation: ArtifactOperation, code: string, message: string): Promise<void> {
    operation.status = "failed";
    operation.completedAt = this.isoNow();
    operation.error = { code, message };
    await this.store.writeOperation(operation);
    this.emit(`artifact_${operation.kind}_failed`, {
      artifact: operation.artifactId ?? "multiple",
      runtime: operation.runtimeId ?? "none",
      reason: code,
    });
    await this.pruneHistory();
    this.emitOperationState();
  }

  private async rejectAtCapacity(operation: ArtifactOperation): Promise<boolean> {
    const active = [...this.operations.values()].filter((candidate) =>
      candidate.id !== operation.id
      && (candidate.status === "pending" || candidate.status === "running")
    ).length;
    const limit = Math.max(1, this.options.maxPendingOperations ?? 64);
    if (active < limit) {
      return false;
    }
    await this.fail(
      operation,
      "artifact_operation_capacity",
      `pending artifact operation capacity ${limit} has been reached`,
    );
    return true;
  }

  private async persistPending(operation: ArtifactOperation): Promise<void> {
    try {
      await this.store.writeOperation(operation);
    } catch (err) {
      this.operations.delete(operation.id);
      this.emitOperationState();
      throw new ArtifactStoreError("journal_write_failed", this.errorMessage(err));
    }
  }

  private savedOperation(saved: ArtifactJournalRecord): ArtifactOperation {
    const parsed = artifactOperationSchema.safeParse(saved);
    if (!parsed.success) {
      throw new ArtifactStoreError("journal_corrupt", `invalid artifact operation ${saved.id}`);
    }
    const operation = parsed.data;
    if (
      !/^artifact_op_[a-zA-Z0-9._-]+$/.test(operation.id)
      || (operation.kind === "stage" && !operation.artifactId && !operation.releaseId)
      || (operation.kind !== "stage" && !operation.runtimeId)
    ) {
      throw new ArtifactStoreError("journal_corrupt", `invalid artifact operation ${saved.id}`);
    }
    return operation;
  }

  private async pruneHistory(): Promise<void> {
    const limit = Math.max(1, this.options.historyLimit ?? 1_000);
    const terminal = [...this.operations.values()]
      .filter((operation) => operation.status !== "pending" && operation.status !== "running")
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    while (this.operations.size > limit && terminal.length > 0) {
      const operation = terminal.shift();
      if (!operation) {
        break;
      }
      this.operations.delete(operation.id);
      await this.store.deleteOperation(operation.id);
    }
  }

  private requireArtifact(id: string): ArtifactDefinition {
    const artifact = this.artifacts.get(id);
    if (!artifact) {
      throw new ArtifactStoreError("not_found", `artifact ${id} is not in the manifest`);
    }
    return artifact;
  }

  private emit(name: string, labels: Record<string, string>): void {
    this.options.onEvent?.({ name, labels });
  }

  private emitOperationState(): void {
    this.options.onOperationState?.(this.activeOperationCount());
  }

  private async acquireMutation(
    operation: ArtifactOperation,
    kind: MutationKind,
  ): Promise<MutationLease | undefined> {
    try {
      return this.options.mutationCoordinator?.reserve(kind);
    } catch (error) {
      if (error instanceof MutationCoordinatorError) {
        await this.fail(operation, error.code, error.message);
        return undefined;
      }
      throw error;
    }
  }

  private validateHealthContract(
    runtime: RuntimeDefinition | undefined,
    healthPath: string,
  ): string | undefined {
    if (!runtime) return undefined;
    const configured = runtime.backend === "systemd"
      ? runtime.deployment.healthPath ?? "/health"
      : "/health";
    return configured === healthPath
      ? undefined
      : `release health path ${healthPath} does not match runtime contract ${configured}`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private random(): string {
    return (this.options.random ?? (() => crypto.randomUUID()))();
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new ArtifactStoreError(
        "operation_cancelled",
        signal.reason instanceof Error ? signal.reason.message : "artifact operation cancelled",
      );
    }
  }
}
