import { currentObservation, type Observability } from "./observability";
import { AllocationNotifications } from "./allocation-notifications";
import { AllocationLifecycleError } from "./allocation-lifecycle";
import { resolveAllocationBindings } from "./allocation-binding-resolver";
import { UsageProtectionError, type UsageCoordinator } from "./usage-coordinator";
import type { ServiceMemoryReservation } from "@larm/core";
import {
  activeAllocation,
  admittedAllocation,
  createAllocationId,
  getRuntime,
  compareRouteSelection,
  createLeaseId,
  findDefaultRoute,
  planTransition,
  prepareRequestSchema,
  providerStartupPolicy,
  selectRoute,
  type Allocation,
  type AllocationRequest,
  type Lease,
  type PrepareRequest,
  type Registry,
  type ResolveResult,
  type RouteShadowComparison,
  type RuntimeReleaseDefinition,
} from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import type { Observer } from "./observer";
import { AllocationStartupLifecycle } from "./allocation-startup-lifecycle";
import { AllocationApiLifecycle } from "./allocation-api-lifecycle";
import { AllocationTimers } from "./allocation-timers";
import { planAllocationRequestAdmission } from "./allocation-request-admission";
import { commitAllocationRequest } from "./allocation-request-commit";
import {
  promoteWaitingAllocationBatch,
} from "./allocation-waiting-promotion";
import { reconcileOrphanedPreferredRuntimes } from "./control-plane-startup-reconciliation";
import { AllocationPreemption } from "./allocation-preemption";
import { LegacyLeaseRegistry } from "./legacy-lease-registry";
import { LegacyPrepareCoordinator } from "./legacy-prepare-coordinator";
import { runLegacyPrepareOperation } from "./legacy-prepare-operation";
import { LegacyControlOperations } from "./legacy-control-operations";
import { ProviderInstanceManager, type ProviderInstanceInspection } from "./provider-instance-manager";
import {
  admittedAllocations,
  countActiveAdmission,
  countActiveAllocations,
  evaluateAllocationAdmission,
  hasAllocationResourceConflict,
} from "./allocation-admission";

export type Operation = {
  id: string;
  kind: "prepare" | "allocation";
  leaseId?: string;
  allocationId?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  ready: boolean;
  desired: string[];
  ensure: string[];
  createdAt: string;
  deadlineAt?: string;
  completedAt?: string;
  phase?: string;
  error?: { code: string; message: string };
};

export type DeploymentCoordinator = {
  ensureRuntime(
    runtimeId: string,
    allocationId?: string,
    onPhase?: (phase: string) => void,
    signal?: AbortSignal,
  ): Promise<void>;
};

export type ControlEvent = {
  name: string;
  labels?: Record<string, string>;
  value?: number;
};

export type ControlPlaneOptions = {
  observability?: Observability;
  bootEpoch?: string;
  idleTtlMs?: number;
  now?: () => number;
  random?: () => string;
  sleep?: (ms: number) => Promise<void>;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  historyLimit?: number;
  maxActiveAllocations?: number;
  stateMaxAgeMs?: number;
  deploymentCoordinator?: DeploymentCoordinator;
  isRuntimeMutating?: (runtimeId: string) => boolean;
  onEvent?: (event: ControlEvent) => void;
  onRouteShadowComparison?: (comparison: RouteShadowComparison) => void;
  getServiceReservations?: () => readonly ServiceMemoryReservation[];
  requireFreshTelemetry?: boolean;
  telemetryMaxAgeMs?: number;
  foregroundPriorityThreshold?: number;
  providerSwitchHoldMs?: number;
  getCatalogRevision?: () => string;
  getRuntimeRelease?: (runtimeId: string) => string | undefined;
  getRuntimeReleaseDefinition?: (runtimeId: string) => RuntimeReleaseDefinition | undefined;
};

export class ControlPlane {
  usage?: UsageCoordinator;
  private readonly notifications = new AllocationNotifications();
  private readonly usageAllocations = new Map<string, string>();
  private retainedOwner?: string;
  private handover?: { owner?: string; promise: Promise<void> };
  private retentionChanged?: (runtimeIds: string[], protectedConsumer: boolean) => void;
  private retentionHealth?: () => boolean;
  private retentionRollback?: { previousOwner?: string; runtimeIds: string[]; nextOwner?: string; nextRuntimeIds: string[]; allocations: Set<string>; semanticAllocations: Set<string> };

  setUsageRetentionListener(listener: (runtimeIds: string[], protectedConsumer: boolean) => void, failed?: () => boolean): void { this.retentionChanged = listener; this.retentionHealth = failed; }
  completeUsageHandover(allocationId: string): void {
    if (this.retentionRollback?.allocations.has(allocationId)) this.retentionRollback = undefined;
  }
  rollbackUsageProfile(allocationId?: string): void {
    const rollback = this.retentionRollback;
    if (!rollback) return;
    if (allocationId) {
      if (!rollback.allocations.delete(allocationId) || rollback.allocations.size > 0) return;
    } else if (rollback.allocations.size > 0) return;
    const usable = new Set(this.providerInstances.inspect().filter(record => ["HOT", "BUSY", "STARTING"].includes(record.instance.status)).map(record => record.instance.runtimeId));
    const runtimeIds = rollback.runtimeIds.filter(id => usable.has(id));
    this.providerInstances.rollbackRetained(runtimeIds);
    this.retainedOwner = runtimeIds.length ? rollback.previousOwner : undefined;
    this.retentionRollback = undefined;
    this.retentionChanged?.(runtimeIds, this.retainedOwner !== undefined && this.retainedOwner === this.usage?.protectedOwner && this.usage.persistsLegacyProtection);
  }
  restoreUsageRetention(runtimeIds: string[], protectedConsumer: boolean, otherOwner = "(restored-other)"): void {
    if (!this.usage || !runtimeIds.length || runtimeIds.some(id => !getRuntime(this.registry, id))) return;
    this.retainedOwner = protectedConsumer ? this.usage.protectedOwner : otherOwner;
    this.providerInstances.retainUntilNextProfile(runtimeIds, this.profileRetentionScope(runtimeIds));
    if (protectedConsumer && this.usage.protectedOwner) this.usage.run(this.usage.protectedOwner, () => this.usage!.prepare(600_000)(true));
  }

  getUsageState() {
    const state = this.usage?.protection.snapshot();
    return {
      enabled: this.usage !== undefined, protected: (state?.protected ?? false) || (this.usage?.isTransitioning ?? false),
      transitioning: this.usage?.isTransitioning ?? false,
      activeRequests: state?.activeRequests ?? 0, preparing: state?.preparing ?? 0,
      remainingMs: state?.remainingMs ?? 0,
      retainedRuntimeIds: this.providerInstances.retainedRuntimeIds(),
      allocationWaiters: this.notifications.size,
      retentionPersistenceFailed: this.retentionHealth?.() ?? false,
    };
  }

  private usageHandoverNeeded(nextRuntimeIds: string[]): boolean {
    if (this.retainedOwner === undefined) return false;
    const primaryRuntimes = (ids: string[]) => [...new Set(ids)].filter(id =>
      !["openai.audio-transcriptions.v1", "openai.audio-speech.v1"].includes(getRuntime(this.registry, id)?.protocol ?? "")).sort();
    const sameRuntimes = JSON.stringify(primaryRuntimes(nextRuntimeIds)) === JSON.stringify(primaryRuntimes(this.providerInstances.retainedRuntimeIds()));
    return this.retainedOwner !== this.usage?.owner || !sameRuntimes;
  }

  private profileRetentionScope(runtimeIds: string[]): string[] {
    const groups = new Set(runtimeIds.map(id => getRuntime(this.registry, id)?.policy.swapGroup).filter(Boolean));
    return this.registry.runtimes.filter(runtime => runtime.policy.swapGroup && groups.has(runtime.policy.swapGroup)).map(runtime => runtime.id);
  }
  private readonly legacyLeases = new LegacyLeaseRegistry();
  private readonly allocations = new Map<string, Allocation>();
  private readonly operations = new Map<string, Operation>();
  private readonly lifecycleTimers = new AllocationTimers();
  private readonly allocationAborts = new Map<string, AbortController>();
  private readonly allocationLifecycleAborts = new Map<string, AbortController>();
  private readonly operationAborts = new Map<string, AbortController>();
  private readonly lifecycleReservations = new Set<string>();
  private readonly legacyPrepare: LegacyPrepareCoordinator;
  private readonly legacyControl: LegacyControlOperations;
  private readonly providerInstances: ProviderInstanceManager;
  private readonly allocationStartup: AllocationStartupLifecycle;
  private readonly allocationApi: AllocationApiLifecycle;
  private readonly preemption: AllocationPreemption;
  private applyChain: Promise<void> = Promise.resolve();
  private readonly audioTasks = new Set<Promise<void>>();
  private audioPromotion?: Promise<void>;
  private queuedTasks = 0;
  private draining = false;
  private idSequence = 0;

  constructor(
    private readonly registry: Registry,
    private readonly backend: RuntimeBackend,
    private readonly observer: Observer,
    private readonly options: ControlPlaneOptions = {},
  ) {
    this.legacyPrepare = new LegacyPrepareCoordinator({
      registry,
      isDraining: () => this.draining,
      allocate: (request) => this.allocate(request),
      hasFreshState: () => this.hasFreshState(),
      getState: () => this.observer.getState(),
      planningLeases: () => this.planningLeases(),
      activeAdmissionCount: () => this.activeAdmissionCount(),
      maxActiveAllocations: () => Math.max(1, options.maxActiveAllocations ?? 1_000),
      createLeaseId: () => this.uniqueId(
        createLeaseId(options.random),
        (candidate) => this.legacyLeases.has(candidate),
      ),
      addLease: (lease, allocationId) => this.legacyLeases.add(lease, allocationId),
      attachLeaseToOperation: (allocation, leaseId) => {
        if (!allocation.operationId) return;
        const operation = this.operations.get(allocation.operationId);
        if (operation) operation.leaseId = leaseId;
      },
      cancelIdle: () => this.cancelIdle(),
      createOperationId: () => this.createOperationId(),
      storeAndRunOperation: (operation) => {
        this.operations.set(operation.id, operation);
        const abort = new AbortController();
        this.operationAborts.set(operation.id, abort);
        this.enqueue(() => this.runEnsure(operation, abort), "legacy_prepare");
      },
      pruneHistory: () => this.pruneHistory(),
      isoNow: () => this.isoNow(),
    });
    this.preemption = new AllocationPreemption(registry, {
      now: () => this.now(),
      foregroundPriorityThreshold: options.foregroundPriorityThreshold,
      providerSwitchHoldMs: options.providerSwitchHoldMs,
      emit: (name, labels) => this.emit(name, labels),
    });
    this.legacyControl = new LegacyControlOperations({
      registry,
      isDraining: () => this.draining,
      getState: () => this.observer.getState(),
      hasFreshState: () => this.hasFreshState(),
      planningLeases: () => this.planningLeases(),
      getLease: (leaseId) => this.legacyLeases.get(leaseId),
      removeLease: (leaseId) => this.legacyLeases.remove(leaseId),
      cancelLeaseOperations: (leaseId) => {
        for (const operation of this.operations.values()) {
          if (
            operation.leaseId === leaseId
            && (operation.status === "pending" || operation.status === "running")
          ) {
            this.operationAborts.get(operation.id)?.abort(new Error(`lease ${leaseId} released`));
          }
        }
      },
      releaseAllocation: (allocationId) => this.releaseAllocation(allocationId),
      scheduleIdleStop: (runtimeIds) => this.scheduleIdleStop(runtimeIds),
      observeRouteShadow: (capability, result) => this.observeRouteShadow(capability, result),
    });
    this.providerInstances = new ProviderInstanceManager(backend, {
      idleTtlMs: options.idleTtlMs,
      now: options.now,
      onEvent: (name, labels) => options.onEvent?.({ name, labels }),
    });
    this.allocationStartup = new AllocationStartupLifecycle({
      registry,
      backend,
      observer,
      providerInstances: this.providerInstances,
      allocationAborts: this.allocationAborts,
      allocationLifecycleAborts: this.allocationLifecycleAborts,
      deploymentCoordinator: options.deploymentCoordinator,
      getRuntimeRelease: options.getRuntimeRelease,
      getRuntimeReleaseDefinition: options.getRuntimeReleaseDefinition,
      now: () => this.now(),
      isoNow: () => this.isoNow(),
      sleep: options.sleep ?? ((ms) => Bun.sleep(ms)),
      pollIntervalMs: options.pollIntervalMs ?? 500,
      allocationLabels: (allocation) => this.allocationLabels(allocation),
      emit: (name, labels, value) => this.emit(name, labels, value),
      clearAllocationTimer: (id) => this.clearAllocationTimer(id),
      detachLegacyAllocation: (id) => this.detachLegacyAllocation(id),
      scheduleIdleReconcile: () => this.scheduleIdleReconcile(),
      enqueueWaitingPromotion: () => this.enqueueWaitingPromotions(),
      pruneHistory: () => this.pruneHistory(),
    });
    this.allocationApi = new AllocationApiLifecycle({
      allocations: this.allocations,
      operations: this.operations,
      allocationAborts: this.allocationAborts,
      allocationLifecycleAborts: this.allocationLifecycleAborts,
      isDraining: () => this.draining,
      expireDueAllocations: () => this.expireDueAllocations(),
      allocationLookupError: (id) => this.allocationLookupError(id),
      now: () => this.now(),
      isoNow: () => this.isoNow(),
      hasFreshState: () => this.hasFreshState(),
      getState: () => this.observer.getState(),
      scheduleAllocationExpiry: (allocation) => this.scheduleAllocationExpiry(allocation),
      clearAllocationTimer: (id) => this.clearAllocationTimer(id),
      detachLegacyAllocation: (id) => this.detachLegacyAllocation(id),
      providerInstances: this.providerInstances,
      foregroundPriorityThreshold: () => this.foregroundPriorityThreshold(),
      holdForegroundProviders: (allocation) => this.holdForegroundProviders(allocation),
      allocationLabels: (allocation) => this.allocationLabels(allocation),
      emit: (name, labels) => this.emit(name, labels),
      enqueueWaitingPromotion: () => this.enqueueWaitingPromotions(),
      scheduleIdleReconcile: () => this.scheduleIdleReconcile(),
      pruneHistory: () => this.pruneHistory(),
    });
  }

  getProviderInstances(): ProviderInstanceInspection[] {
    return this.providerInstances.inspect();
  }

  waitForAllocation(id: string, signal?: AbortSignal, timeoutMs = 300_000) {
    return this.notifications.wait(id, () => this.getAllocation(id), signal, timeoutMs);
  }

  getAllocationWaiterCount(): number { return this.notifications.size; }

  async prepareUsageHandover(nextRuntimeIds: string[]): Promise<void> {
    const usage = this.usage;
    if (!usage) return;
    usage.check();
    const owner = usage.owner;
    if (this.handover) {
      if (this.handover.owner !== owner) throw new UsageProtectionError(1);
      await this.handover.promise;
      return await this.prepareUsageHandover(nextRuntimeIds);
    }
    const initialRetention = this.retainedOwner === undefined && usage.canProtect && usage.protection.snapshot().preparing > 0;
    if (!initialRetention && !this.usageHandoverNeeded(nextRuntimeIds)) return;
    // A different profile cannot overwrite rollback state while readiness for
    // the previous accepted allocation is still unresolved.
    if (this.retentionRollback?.allocations.size) throw new UsageProtectionError(1);
    if (usage.protection.snapshot().activeRequests > 0) throw new UsageProtectionError(1);
    this.retentionRollback = { previousOwner: this.retainedOwner, runtimeIds: this.providerInstances.retainedRuntimeIds(), nextOwner: owner, nextRuntimeIds: [...new Set(nextRuntimeIds)].sort(), allocations: new Set(), semanticAllocations: new Set() };
    const promise = usage.transfer(async () => {
      for (const [id, allocationOwner] of this.usageAllocations) {
        if (allocationOwner === this.retainedOwner) await this.releaseAllocation(id);
      }
      await this.providerInstances.releaseRetained(nextRuntimeIds, this.profileRetentionScope(nextRuntimeIds));
      this.retainedOwner = owner;
      usage.protection.relinquish(owner);
      await this.observer.tick();
      this.retentionChanged?.(this.providerInstances.retainedRuntimeIds(), owner === usage.protectedOwner && usage.persistsLegacyProtection);
    });
    this.handover = { owner, promise };
    try { await promise; } finally { if (this.handover?.promise === promise) this.handover = undefined; }
  }

  retainUsageProfile(allocationId: string): void {
    const allocation = this.allocations.get(allocationId);
    const owner = this.usage?.owner ?? this.usageAllocations.get(allocationId);
    if (!allocation || allocation.status !== "ready" || !owner) return;
    this.retainedOwner = owner;
    const runtimeIds = allocation.bindings.map(binding => binding.runtime);
    this.providerInstances.retainUntilNextProfile(runtimeIds, this.profileRetentionScope(runtimeIds));
    this.retentionChanged?.(this.providerInstances.retainedRuntimeIds(), owner === this.usage?.protectedOwner && this.usage.persistsLegacyProtection);
    this.completeUsageHandover(allocationId);
  }

  async activateUsageProtection(priority: number): Promise<void> {
    if (!this.usage) return;
    this.usage.check();
    for (const [id, owner] of [...this.usageAllocations]) {
      if (owner !== this.usage.owner && activeAllocation(this.allocations.get(id)?.status ?? "released")) {
        const result = await this.preemptAllocation(id, priority);
        if (result.status !== 200) throw new UsageProtectionError(1);
      }
    }
  }

  retainProviderRequest(allocationId: string, capability: string, requestId: string): string | undefined {
    const allocation = this.allocations.get(allocationId);
    if (!allocation || allocation.status !== "ready") return undefined;
    const instanceId = allocation.bindings.find(
      (binding) => binding.capability === capability,
    )?.instanceId;
    if (!instanceId) return undefined;
    this.providerInstances.retainRequest(instanceId, requestId);
    return instanceId;
  }

  releaseProviderRequest(instanceId: string | undefined, requestId: string): void {
    if (instanceId) this.providerInstances.releaseRequest(instanceId, requestId);
  }

  async reconcileProviderInstances(signal?: AbortSignal): Promise<void> {
    const state = await this.observer.tick();
    for (const runtime of this.registry.runtimes) {
      if (this.providerInstances.isProfileManaged(runtime.id) && !this.providerInstances.isRetained(runtime.id)) continue;
      const release = this.options.getRuntimeReleaseDefinition?.(runtime.id)
        ?? this.options.getRuntimeRelease?.(runtime.id);
      if (runtime.policy.class === "resident" || (runtime.policy.warm?.minInstances ?? 0) > 0) {
        await this.providerInstances.ensureWarm(runtime, release, signal);
        continue;
      }
      const status = state.runtimes.find((item) => item.id === runtime.id)?.status;
      if (status === "HOT" || status === "BUSY") {
        const recoveryRef = `recovery:${runtime.id}`;
        await this.providerInstances.acquire(runtime, recoveryRef, release, signal);
        this.providerInstances.releaseAllocation(recoveryRef);
      }
    }
    await this.observer.tick();
  }

  getLeases(): Lease[] {
    return this.legacyLeases.values();
  }

  getBootEpoch(): string {
    return this.options.bootEpoch ?? "epoch-local";
  }

  beginDrain(): void {
    this.draining = true;
    this.cancelIdle();
    this.cancelWaitingPromotion();
    this.providerInstances.close();
    const reason = new Error("control plane is draining");
    for (const allocation of this.allocations.values()) {
      if (allocation.status === "waiting" || allocation.status === "pending") {
        void this.releaseAllocation(allocation.id);
      }
    }
    for (const abort of this.operationAborts.values()) {
      abort.abort(reason);
    }
  }

  isDraining(): boolean {
    return this.draining;
  }

  isRuntimeTransitioning(runtimeId: string): boolean {
    return this.lifecycleReservations.has(runtimeId);
  }

  getOperation(id: string): Operation | undefined {
    return this.operations.get(id);
  }

  getAllocation(id: string): Allocation | undefined {
    this.expireDueAllocations();
    return this.allocations.get(id);
  }

  getRuntimeStartupPolicy(runtimeId: string) {
    const runtime = this.registry.runtimes.find((item) => item.id === runtimeId);
    return runtime ? providerStartupPolicy(runtime) : undefined;
  }

  getAllocationSignal(id: string): AbortSignal | undefined {
    this.expireDueAllocations();
    return this.allocationLifecycleAborts.get(id)?.signal;
  }

  allocationLookupError(id: string) {
    if (id.startsWith("alloc_") && !id.startsWith(`alloc_${this.getBootEpoch()}_`)) {
      return {
        status: 409 as const,
        body: {
          error: {
            code: "allocation_epoch_expired",
            message: `allocation ${id} belongs to a previous daemon boot epoch`,
          },
        },
      };
    }
    return {
      status: 404 as const,
      body: { error: { code: "not_found", message: `allocation ${id} does not exist` } },
    };
  }

  getAllocations(): Allocation[] {
    this.expireDueAllocations();
    return [...this.allocations.values()];
  }

  getActiveAllocationCount(): number {
    return countActiveAllocations([...this.allocations.values()]);
  }

  async allocate(request: AllocationRequest, options: { waitForSemanticReadiness?: boolean; independentAudio?: boolean } = {}) {
    if (options.independentAudio) {
      const resolved = resolveAllocationBindings({ registry: this.registry, state: this.observer.getState(), request,
        getRuntimeRelease: this.options.getRuntimeRelease, getRuntimeReleaseDefinition: this.options.getRuntimeReleaseDefinition, onRejected: () => {} });
      if (!resolved.ok) return resolved.result;
      if (resolved.bindings.some(binding => !["openai.audio-transcriptions.v1", "openai.audio-speech.v1"].includes(getRuntime(this.registry, binding.runtime)?.protocol ?? ""))) {
        throw new Error("independent audio allocation contains a non-audio runtime");
      }
    }
    this.usage?.check();
    if (this.draining) {
      return {
        status: 503 as const,
        body: { error: { code: "draining", message: "control plane is draining" } },
      };
    }
    if (!this.hasFreshState()) {
      this.emit("allocation_rejected", { reason: "stale_state" });
      return {
        status: 503 as const,
        body: {
          error: {
            code: "stale_state",
            message: "runtime observation is stale; retry after the next observer tick",
          },
        },
      };
    }
    if (!options.independentAudio && this.usage && (this.retainedOwner !== undefined || (this.usage.canProtect && this.usage.protection.snapshot().preparing > 0))) {
      const resolved = resolveAllocationBindings({
        registry: this.registry, state: this.observer.getState(), request,
        getRuntimeRelease: this.options.getRuntimeRelease,
        getRuntimeReleaseDefinition: this.options.getRuntimeReleaseDefinition,
        onRejected: () => {},
      });
      if (!resolved.ok) return resolved.result;
      await this.prepareUsageHandover(resolved.bindings.map(binding => binding.runtime));
    }
    this.expireDueAllocations();
    const activeLimit = Math.max(1, this.options.maxActiveAllocations ?? 1_000);
    if (this.activeAdmissionCount() >= activeLimit) {
      if (!options.independentAudio) this.rollbackUsageProfile();
      this.emit("allocation_rejected", { reason: "allocation_capacity" });
      return {
        status: 503 as const,
        body: {
          error: {
            code: "allocation_capacity",
            message: `active allocation capacity ${activeLimit} has been reached`,
          },
        },
      };
    }
    const admissionEnd = currentObservation()?.stage("allocation_admission");
    const admission = planAllocationRequestAdmission({
      registry: this.registry,
      request,
      getState: () => this.observer.getState(),
      getAllocations: () => [...this.allocations.values()],
      isLifecycleReserved: (runtimeId) => this.lifecycleReservations.has(runtimeId),
      isRuntimeMutating: (runtimeId) => this.options.isRuntimeMutating?.(runtimeId),
      hasResourceConflict: (runtimeIds, predicate) => this.hasResourceConflict(runtimeIds, predicate),
      providerSwitchHoldUntil: (runtimeIds, priority) => this.providerSwitchHoldUntil(runtimeIds, priority),
      preemptLowerPriorityConflicts: (priority, runtimeIds) =>
        this.preemptLowerPriorityConflicts(priority, runtimeIds),
      getRuntimeRelease: this.options.getRuntimeRelease,
      getRuntimeReleaseDefinition: this.options.getRuntimeReleaseDefinition,
      serviceReservations: this.options.getServiceReservations?.(),
      requireFreshTelemetry: this.options.requireFreshTelemetry ?? false,
      telemetryMaxAgeMs: this.options.telemetryMaxAgeMs ?? 10_000,
      now: () => this.now(),
      onRejected: (reason, route) => this.emit("allocation_rejected", {
        reason,
        ...(route ? { route } : {}),
      }),
    });
    admissionEnd?.();
    if (!admission.ok) { if (!options.independentAudio) this.rollbackUsageProfile(); return admission.result; }
    const now = this.now();
    const allocationId = this.uniqueId(
      createAllocationId(this.getBootEpoch(), this.options.random),
      (candidate) => this.allocations.has(candidate),
    );
    const bootEpoch = this.getBootEpoch();
    const catalogRevision = this.options.getCatalogRevision?.();
    return commitAllocationRequest({
      allocationId,
      bootEpoch,
      catalogRevision,
      request,
      admission,
      now,
      storeAllocation: (allocation) => {
        this.allocations.set(allocation.id, allocation);
        if (!options.independentAudio && this.usage?.owner) this.usageAllocations.set(allocation.id, this.usage.owner);
        const rollback = this.retentionRollback;
        if (!options.independentAudio && rollback && rollback.nextOwner === this.usage?.owner
          && JSON.stringify(rollback.nextRuntimeIds) === JSON.stringify([...new Set(allocation.bindings.map(binding => binding.runtime))].sort())) {
          rollback.allocations.add(allocation.id);
          if (options.waitForSemanticReadiness) rollback.semanticAllocations.add(allocation.id);
        }
      },
      retainExisting: (runtimeId, id, providerRevision) =>
        this.providerInstances.retainExisting(runtimeId, id, providerRevision),
      requiresInstanceTracking: Boolean(this.backend.ensureInstance),
      registerLifecycleAbort: (id) => this.allocationLifecycleAborts.set(id, new AbortController()),
      emitCreated: (allocation) => this.emit(
        allocation.status === "waiting" ? "allocation_waiting" : "allocation_pending",
        this.allocationLabels(allocation),
      ),
      emitReady: (allocation) => this.emit("allocation_ready", this.allocationLabels(allocation)),
      scheduleExpiry: (allocation) => this.scheduleAllocationExpiry(allocation),
      cancelIdle: () => this.cancelIdle(),
      startupDeadline: (allocation) => this.allocationStartupDeadline(allocation),
      createOperationId: () => this.createOperationId(),
      storeOperation: (operation) => this.operations.set(operation.id, operation),
      enqueueWaitingPromotion: () => this.enqueueWaitingPromotions(),
      enqueueStartup: (allocation, operation, deadline) => {
        const work = () => this.runAllocationEnsure(allocation, operation, deadline);
        if (options.independentAudio) this.enqueueAudio(work);
        else this.enqueue(work, "allocation_startup");
      },
      pruneHistory: () => this.pruneHistory(),
    });
  }

  renewAllocation(id: string, ttlSeconds: number) {
    return this.allocationApi.renewAllocation(id, ttlSeconds);
  }

  resolveAllocation(id: string, capability: string) {
    this.usage?.check();
    return this.allocationApi.resolveAllocation(id, capability);
  }

  async releaseAllocation(
    id: string,
    terminal: "released" | "expired" = "released",
    reason?: Error,
  ) {
    const result = await this.allocationApi.releaseAllocation(id, terminal, reason);
    this.usageAllocations.delete(id);
    return result;
  }

  async preemptAllocation(id: string, preemptingPriority: number) {
    return await this.allocationApi.preemptAllocation(id, preemptingPriority);
  }

  async prepare(request: PrepareRequest) {
    this.usage?.check();
    return await this.legacyPrepare.prepare(request);
  }

  async release(leaseId: string) {
    return await this.legacyControl.release(leaseId);
  }

  resolve(capability: string) {
    this.usage?.check();
    return this.legacyControl.resolve(capability);
  }

  async flush(): Promise<void> {
    while (true) {
      const current = this.applyChain;
      await Promise.all([current, ...this.audioTasks]);
      if (this.applyChain === current && this.audioTasks.size === 0) {
        return;
      }
    }
  }

  async reconcileOrphanedPreferred(): Promise<string[]> {
    return await reconcileOrphanedPreferredRuntimes({
      draining: this.draining,
      expireDueAllocations: () => this.expireDueAllocations(),
      observer: this.observer,
      registry: this.registry,
      allocations: this.allocations,
      leases: new Map(this.legacyLeases.values().map((lease) => [lease.id, lease])),
      providerInstances: this.providerInstances,
      backend: this.backend,
      lifecycleReservations: this.lifecycleReservations,
      isRuntimeMutating: this.options.isRuntimeMutating,
      emit: (name, labels) => this.emit(name, labels),
    });
  }

  private enqueueAudio(work: () => Promise<void>): Promise<void> {
    const task = Promise.resolve().then(() => this.usage ? this.usage.runIndependentAudio(work) : work())
      .catch(() => this.emit("audio_control_task_failed"))
      .finally(() => this.audioTasks.delete(task));
    this.audioTasks.add(task);
    return task;
  }

  private isAudioAllocation(allocation: Allocation): boolean {
    return allocation.bindings.length > 0 && allocation.bindings.every(binding =>
      ["openai.audio-transcriptions.v1", "openai.audio-speech.v1"].includes(getRuntime(this.registry, binding.runtime)?.protocol ?? ""));
  }

  private enqueueWaitingPromotions(): void {
    this.enqueue(() => this.promoteWaitingAllocations(), "waiting_promotion");
    if (!this.audioPromotion && [...this.allocations.values()].some(allocation => allocation.status === "waiting" && this.isAudioAllocation(allocation))) {
      const task = this.enqueueAudio(() => this.promoteWaitingAllocations(true));
      this.audioPromotion = task;
      void task.finally(() => { if (this.audioPromotion === task) this.audioPromotion = undefined; });
    }
  }

  private enqueue(work: () => Promise<void>, kind = "maintenance"): void {
    const observation = this.options.observability;
    const activity = observation?.operation("control_task");
    activity?.attribute("larm.task_kind", kind);
    const queueEnd = activity?.stage("queue_wait");
    if (observation) observation.gauge("control_tasks_queued", {}, ++this.queuedTasks);
    this.applyChain = this.applyChain.then(async () => {
      queueEnd?.();
      if (observation) {
        observation.gauge("control_tasks_queued", {}, --this.queuedTasks);
        observation.gauge("control_tasks_active", {}, 1);
      }
      const end = activity?.stage("run");
      let outcome = "complete";
      try { await (activity ? activity.run(work) : work()); }
      catch (error) { outcome = "error"; throw error; }
      finally { end?.(); activity?.finish(outcome); observation?.gauge("control_tasks_active", {}, 0); }
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`control plane task failed: ${message}`);
    });
  }

  private async runAllocationEnsure(
    allocation: Allocation,
    operation: Operation,
    deadline: number,
  ): Promise<void> {
    try { this.usage?.check(); }
    catch (error) {
      if (!(error instanceof UsageProtectionError)) throw error;
      await this.releaseAllocation(allocation.id, "released", new AllocationLifecycleError("foreground_protected", "request stopped because another consumer is protected"));
      return;
    }
    await this.allocationStartup.run(allocation, operation, deadline);
  }

  private async runEnsure(operation: Operation, abort: AbortController): Promise<void> {
    await runLegacyPrepareOperation({
      operation,
      abort,
      registry: this.registry,
      backend: this.backend,
      observer: this.observer,
      isoNow: () => this.isoNow(),
      deleteAbortedOperation: (operationId) => this.operationAborts.delete(operationId),
      clearOperationAbort: (operationId, currentAbort) => {
        if (this.operationAborts.get(operationId) === currentAbort) {
          this.operationAborts.delete(operationId);
        }
      },
      pruneHistory: () => this.pruneHistory(),
    });
  }

  private async runStop(ids: string[]): Promise<void> {
    await this.observer.tick();
    for (const runtimeId of ids) {
      if (this.providerInstances.hasRuntime(runtimeId)) continue;
      if (this.lifecycleReservations.has(runtimeId)) {
        continue;
      }
      this.lifecycleReservations.add(runtimeId);
      try {
        if (this.options.isRuntimeMutating?.(runtimeId)) {
          continue;
        }
        const plan = planTransition({
          registry: this.registry,
          state: this.observer.getState(),
          leases: this.planningLeases(),
        });
        if (!plan.stop.includes(runtimeId)) {
          continue;
        }
        await this.backend.stop(runtimeId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`stop ${runtimeId} failed: ${message}`);
      } finally {
        this.lifecycleReservations.delete(runtimeId);
      }
    }
    await this.observer.tick();
  }

  private cancelIdle(): void {
    this.lifecycleTimers.cancelIdle();
  }

  private planningLeases(): Lease[] {
    const allocationLeases = [...this.allocations.values()]
      .filter((allocation) => activeAllocation(allocation.status))
      .map((allocation): Lease => ({
        id: `allocation:${allocation.id}`,
        client: allocation.client,
        capabilities: allocation.requirements.map((requirement) => requirement.capability),
        createdAt: allocation.createdAt,
      }));
    return [...this.legacyLeases.values(), ...allocationLeases];
  }

  private activeAdmissionCount(): number {
    return countActiveAdmission(
      [...this.allocations.values()],
      this.legacyLeases.ids(),
      this.legacyLeases.activeAdmissionIndex(),
    );
  }

  private admittedAllocations(): Allocation[] {
    return admittedAllocations([...this.allocations.values()]);
  }

  private foregroundPriorityThreshold(): number {
    return this.preemption.foregroundPriorityThreshold();
  }

  private preemptLowerPriorityConflicts(priority: number, runtimeIds: string[]): void {
    this.preemption.preemptLowerPriorityConflicts({
      priority,
      runtimeIds,
      allocations: [...this.allocations.values()],
      preempt: (allocationId, requestedPriority) => this.preemptAllocation(allocationId, requestedPriority),
    });
  }

  private holdForegroundProviders(allocation: Allocation): void {
    if (this.retainedOwner !== undefined && this.usageAllocations.get(allocation.id) === this.retainedOwner) return;
    if (this.usage?.protectedOwner && this.usageAllocations.get(allocation.id) === this.usage.protectedOwner) return;
    this.preemption.holdForegroundProviders(allocation);
  }

  private providerSwitchHoldUntil(runtimeIds: string[], priority: number): number | undefined {
    return this.preemption.holdUntil(runtimeIds, priority);
  }

  private hasResourceConflict(
    runtimeIds: string[],
    predicate: (allocation: Allocation) => boolean,
  ): boolean {
    return hasAllocationResourceConflict(
      this.registry,
      [...this.allocations.values()],
      runtimeIds,
      predicate,
      false,
    );
  }

  private hasExclusiveResourceConflict(
    runtimeIds: string[],
    predicate: (allocation: Allocation) => boolean,
  ): boolean {
    return hasAllocationResourceConflict(
      this.registry,
      [...this.allocations.values()],
      runtimeIds,
      predicate,
      true,
    );
  }

  private allocationStartupDeadline(allocation: Allocation): number {
    return Math.min(
      Date.parse(allocation.expiresAt),
      this.now() + (this.options.startupTimeoutMs ?? 300_000),
    );
  }

  private allocationAdmission(allocation: Allocation) {
    return evaluateAllocationAdmission({
      registry: this.registry,
      state: this.observer.getState(),
      allocations: this.admittedAllocations(),
      candidateRuntimeIds: allocation.bindings.map((binding) => binding.runtime),
      serviceReservations: this.options.getServiceReservations?.(),
      requireFreshTelemetry: this.options.requireFreshTelemetry ?? false,
      telemetryMaxAgeMs: this.options.telemetryMaxAgeMs ?? 10_000,
      ...(this.options.requireFreshTelemetry ? { now: this.now() } : {}),
    });
  }

  getAllocationWaitReason(id: string): { reason: string; runtime?: string } | undefined {
    const allocation = this.allocations.get(id);
    if (allocation?.status !== "waiting") return undefined;
    const admission = this.allocationAdmission(allocation);
    return admission.ok
      ? { reason: "scheduling_policy" }
      : { reason: admission.reason, ...("runtime" in admission ? { runtime: admission.runtime } : {}) };
  }

  private async promoteWaitingAllocations(audioOnly = false): Promise<void> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 500;
    await promoteWaitingAllocationBatch({
      queue: {
        draining: this.draining,
        hasFreshState: () => this.hasFreshState(),
        tick: () => this.observer.tick(),
        allocations: () => [...this.allocations.values()].filter(allocation => this.isAudioAllocation(allocation) === audioOnly),
        now: () => this.now(),
        pollIntervalMs,
        scheduleRetry: (delayMs) => this.scheduleWaitingPromotion(delayMs),
        pruneHistory: () => this.pruneHistory(),
      },
      admission: {
        registry: this.registry,
        providerSwitchHoldUntil: (runtimeIds, priority) =>
          this.providerSwitchHoldUntil(runtimeIds, priority),
        isRuntimeBusy: (runtimeId) =>
          this.lifecycleReservations.has(runtimeId)
          || this.options.isRuntimeMutating?.(runtimeId) === true,
        hasHigherPriorityConflict: (allocation, runtimeIds) =>
          this.hasExclusiveResourceConflict(
            runtimeIds,
            (candidate) => admittedAllocation(candidate.status)
              && (candidate.priority ?? 0) > (allocation.priority ?? 0),
          ),
        evaluateAdmission: (allocation) => this.allocationAdmission(allocation),
        hasAdmittedResourceConflict: (runtimeIds) => this.hasResourceConflict(
          runtimeIds,
          (candidate) => admittedAllocation(candidate.status),
        ),
      },
      lifecycle: {
        runtimeStatuses: () => new Map(
          this.observer.getState().runtimes.map((runtime) => [runtime.id, runtime.status]),
        ),
        getOperation: (allocation) => allocation.operationId
          ? this.operations.get(allocation.operationId)
          : undefined,
        isoNow: () => this.isoNow(),
        startupDeadline: (allocation) => this.allocationStartupDeadline(allocation),
        onAdmitted: (allocation) => this.emit("allocation_admitted", this.allocationLabels(allocation)),
        onReady: (allocation) => this.emit("allocation_ready", this.allocationLabels(allocation)),
        failMissingOperation: (allocation) =>
          this.allocationLifecycleAborts.get(allocation.id)?.abort(new Error("allocation failed")),
        runEnsure: (allocation, operation, deadline) =>
          this.runAllocationEnsure(allocation, operation, deadline),
      },
    });
  }

  private scheduleWaitingPromotion(delayMs = this.options.pollIntervalMs ?? 500): void {
    this.lifecycleTimers.scheduleWaitingPromotion({
      draining: this.draining,
      hasWaiting: [...this.allocations.values()].some((allocation) => allocation.status === "waiting"),
      delayMs,
      promote: () => this.enqueueWaitingPromotions(),
    });
  }

  private cancelWaitingPromotion(): void {
    this.lifecycleTimers.cancelWaitingPromotion();
  }

  private scheduleIdleReconcile(): void {
    if (this.draining) {
      return;
    }
    const plan = planTransition({
      registry: this.registry,
      state: this.observer.getState(),
      leases: this.planningLeases(),
    });
    if (this.planningLeases().length === 0 && plan.stop.length > 0) {
      this.scheduleIdleStop(plan.stop);
    }
  }

  private scheduleIdleStop(ids: string[]): void {
    this.lifecycleTimers.scheduleIdleStop({
      draining: this.draining,
      ttlMs: this.options.idleTtlMs ?? 60_000,
      ids,
      enqueue: (work) => this.enqueue(work),
      runStop: (runtimeIds) => this.runStop(runtimeIds),
    });
  }

  private scheduleAllocationExpiry(allocation: Allocation): void {
    this.lifecycleTimers.scheduleAllocationExpiry({
      id: allocation.id,
      expiresAt: allocation.expiresAt,
      now: this.now(),
      expire: (id) => { void this.releaseAllocation(id, "expired"); },
    });
  }

  private clearAllocationTimer(id: string): void {
    this.lifecycleTimers.clearAllocationExpiry(id);
  }

  private expireDueAllocations(): void {
    this.lifecycleTimers.expireDueAllocations({
      allocations: this.allocations.values(),
      now: this.now(),
      isActive: activeAllocation,
      expire: (id) => { void this.releaseAllocation(id, "expired"); },
    });
  }

  private pruneHistory(): void {
    const limit = Math.max(1, this.options.historyLimit ?? 1_000);
    const terminalAllocations = [...this.allocations.values()]
      .filter((allocation) => !activeAllocation(allocation.status))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    while (this.allocations.size > limit && terminalAllocations.length > 0) {
      const allocation = terminalAllocations.shift();
      if (allocation) {
        this.allocations.delete(allocation.id);
        this.usageAllocations.delete(allocation.id);
        this.allocationLifecycleAborts.delete(allocation.id);
      }
    }
    const terminalOperations = [...this.operations.values()]
      .filter((operation) => operation.status !== "pending" && operation.status !== "running")
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    while (this.operations.size > limit && terminalOperations.length > 0) {
      const operation = terminalOperations.shift();
      if (operation) {
        this.operations.delete(operation.id);
      }
    }
  }

  private allocationLabels(allocation: Allocation): Record<string, string> {
    return {
      allocation: allocation.id,
      client: allocation.client ?? "unknown",
      routes: [...new Set(allocation.bindings.map((binding) => binding.route))].join(","),
      runtimes: [...new Set(allocation.bindings.map((binding) => binding.runtime))].join(","),
      releases: [...new Set(allocation.bindings.map((binding) => binding.release ?? "unmanaged"))].join(","),
      fallback: String(allocation.bindings.some((binding) => binding.fallback)),
      reasons: [...new Set(allocation.bindings.map((binding) => binding.selectionReason))].join(","),
      priority: String(allocation.priority ?? 0),
    };
  }

  private emit(name: string, labels?: Record<string, string>, value?: number): void {
    if (["allocation_failed", "allocation_released", "allocation_expired"].includes(name) && labels?.allocation) this.rollbackUsageProfile(labels.allocation);
    if (name === "allocation_ready" && labels?.allocation && !this.retentionRollback?.semanticAllocations.has(labels.allocation)) this.completeUsageHandover(labels.allocation);
    if (labels?.allocation) this.notifications.notify(labels.allocation);
    if (labels?.allocation && ["allocation_released", "allocation_expired", "allocation_failed"].includes(name)) this.usageAllocations.delete(labels.allocation);
    this.options.onEvent?.({ name, labels, value });
  }

  private createOperationId(): string {
    return this.uniqueId(
      `op_${(this.options.random ?? (() => crypto.randomUUID()))()}`,
      (candidate) => this.operations.has(candidate),
    );
  }

  private uniqueId(base: string, exists: (candidate: string) => boolean): string {
    if (!exists(base)) {
      return base;
    }
    let candidate: string;
    do {
      this.idSequence += 1;
      candidate = `${base}_${this.idSequence}`;
    } while (exists(candidate));
    return candidate;
  }

  private detachLegacyAllocation(allocationId: string): void {
    this.legacyLeases.detachAllocation(allocationId);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private hasFreshState(): boolean {
    const age = this.now() - Date.parse(this.observer.getState().generatedAt);
    return Number.isFinite(age)
      && age >= 0
      && age <= (this.options.stateMaxAgeMs ?? 10_000);
  }

  private observeRouteShadow(capability: string, legacy: ResolveResult): void {
    const route = findDefaultRoute(this.registry, capability);
    if (!route) {
      return;
    }
    const selected = selectRoute({
      registry: this.registry,
      state: this.observer.getState(),
      routeId: route.id,
      capability,
      mode: "default",
      allowFallback: true,
    });
    const comparison = compareRouteSelection(capability, route, legacy, selected);
    this.options.onRouteShadowComparison?.(comparison);
    if (!comparison.matches && !this.options.onRouteShadowComparison) {
      console.warn(JSON.stringify({ event: "route_shadow_mismatch", ...comparison }));
    }
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}
