import {
  activeAllocation,
  admittedAllocation,
  admitRuntimes,
  createAllocationId,
  createLeaseId,
  compareRouteSelection,
  expandPrepareRequest,
  findDefaultRoute,
  getRuntime,
  planTransition,
  prepareRequestSchema,
  resolveCapability,
  selectRoute,
  type Allocation,
  type AllocationBinding,
  type AllocationRequest,
  type Lease,
  type PrepareRequest,
  type Registry,
  type ResolveResult,
  type RouteShadowComparison,
} from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { ArtifactStoreError, LifecycleError } from "@larm/backends";
import type { Observer } from "./observer";

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
  requireFreshTelemetry?: boolean;
  telemetryMaxAgeMs?: number;
  getCatalogRevision?: () => string;
  getRuntimeRelease?: (runtimeId: string) => string | undefined;
};

export class ControlPlane {
  private readonly leases = new Map<string, Lease>();
  private readonly legacyAllocationByLease = new Map<string, string>();
  private readonly allocations = new Map<string, Allocation>();
  private readonly operations = new Map<string, Operation>();
  private readonly allocationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly allocationAborts = new Map<string, AbortController>();
  private readonly allocationLifecycleAborts = new Map<string, AbortController>();
  private readonly operationAborts = new Map<string, AbortController>();
  private readonly lifecycleReservations = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private waitingTimer: ReturnType<typeof setTimeout> | undefined;
  private applyChain: Promise<void> = Promise.resolve();
  private draining = false;
  private idSequence = 0;

  constructor(
    private readonly registry: Registry,
    private readonly backend: RuntimeBackend,
    private readonly observer: Observer,
    private readonly options: ControlPlaneOptions = {},
  ) {}

  getLeases(): Lease[] {
    return [...this.leases.values()];
  }

  getBootEpoch(): string {
    return this.options.bootEpoch ?? "epoch-local";
  }

  beginDrain(): void {
    this.draining = true;
    this.cancelIdle();
    this.cancelWaitingPromotion();
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
    return [...this.allocations.values()].filter((allocation) =>
      activeAllocation(allocation.status)
    ).length;
  }

  async allocate(request: AllocationRequest) {
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
    this.expireDueAllocations();
    const activeLimit = Math.max(1, this.options.maxActiveAllocations ?? 1_000);
    if (this.activeAdmissionCount() >= activeLimit) {
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
    const capabilities = new Set<string>();
    const bindings: AllocationBinding[] = [];
    for (const requirement of request.requirements) {
      if (capabilities.has(requirement.capability)) {
        return {
          status: 400 as const,
          body: {
            error: {
              code: "duplicate_capability",
              message: `capability ${requirement.capability} is requested more than once`,
            },
          },
        };
      }
      capabilities.add(requirement.capability);
      const selected = selectRoute({
        registry: this.registry,
        state: this.observer.getState(),
        routeId: requirement.route,
        capability: requirement.capability,
        mode: "explicit",
        allowFallback: request.allowFallback,
      });
      if (!selected.ok) {
        const notFound = selected.reason === "unknown_route" || selected.reason === "unsupported_capability";
        const unavailable = selected.reason === "no_candidate_available";
        this.emit("allocation_rejected", { reason: selected.reason, route: requirement.route });
        return {
          status: notFound ? 404 as const : unavailable ? 503 as const : 409 as const,
          body: {
            error: {
              code: selected.reason,
              message: `route ${requirement.route} cannot provide ${requirement.capability}: ${selected.reason}`,
            },
          },
        };
      }
      bindings.push({
        capability: selected.capability,
        route: selected.route,
        runtime: selected.runtime,
        node: selected.node,
        endpoint: selected.endpoint,
        status: selected.status,
        candidateRank: selected.candidateRank,
        fallback: selected.fallback,
        selectionReason: selected.reason,
        release: this.options.getRuntimeRelease?.(selected.runtime),
      });
    }

    const runtimeIds = [...new Set(bindings.map((binding) => binding.runtime))];
    const lifecycleRuntimeIds = new Set(runtimeIds);
    for (const runtimeId of runtimeIds) {
      const swapGroup = getRuntime(this.registry, runtimeId)?.policy.swapGroup;
      if (!swapGroup) continue;
      for (const peer of this.registry.runtimes) {
        if (peer.policy.swapGroup === swapGroup) lifecycleRuntimeIds.add(peer.id);
      }
    }
    const transitioningRuntime = [...lifecycleRuntimeIds].find((runtimeId) =>
      this.lifecycleReservations.has(runtimeId)
    );
    const waitsForCapacity = request.capacityPolicy === "wait";
    const conflictsWithAdmitted = this.hasResourceConflict(
      runtimeIds,
      (allocation) => admittedAllocation(allocation.status),
    );
    const conflictsWithWaiter = this.hasResourceConflict(
      runtimeIds,
      (allocation) => allocation.status === "waiting",
    );
    if (transitioningRuntime && !(waitsForCapacity && conflictsWithAdmitted)) {
      this.emit("allocation_rejected", { reason: "runtime_transition_in_progress" });
      return {
        status: 409 as const,
        body: {
          error: {
            code: "runtime_transition_in_progress",
            message: `runtime ${transitioningRuntime} is changing lifecycle state`,
          },
        },
      };
    }
    const mutatingRuntime = [...lifecycleRuntimeIds].find((runtimeId) =>
      this.options.isRuntimeMutating?.(runtimeId)
    );
    if (mutatingRuntime) {
      this.emit("allocation_rejected", { reason: "deployment_in_progress" });
      return {
        status: 409 as const,
        body: {
          error: {
            code: "deployment_in_progress",
            message: `runtime ${mutatingRuntime} is being updated`,
          },
        },
      };
    }
    const admission = admitRuntimes({
      registry: this.registry,
      state: this.observer.getState(),
      allocations: this.admittedAllocations(),
      candidateRuntimeIds: runtimeIds,
      ...(this.options.requireFreshTelemetry
        ? {
          liveTelemetry: {
            requiredForNonResident: true,
            maxAgeMs: this.options.telemetryMaxAgeMs ?? 10_000,
            now: this.now(),
          },
        }
        : {}),
    });
    const capacityBlocked = !admission.ok && conflictsWithAdmitted;
    const waiting = waitsForCapacity && (
      conflictsWithWaiter
      || (transitioningRuntime !== undefined && conflictsWithAdmitted)
      || capacityBlocked
    );
    if (!admission.ok && !waiting) {
      this.emit("allocation_rejected", { reason: admission.reason });
      return {
        status: 409 as const,
        body: {
          error: {
            code: "resource_exhausted",
            message: admission.message,
            admission: admission.nodes,
          },
        },
      };
    }

    const now = this.now();
    const allocation: Allocation = {
      id: this.uniqueId(
        createAllocationId(this.getBootEpoch(), this.options.random),
        (candidate) => this.allocations.has(candidate),
      ),
      bootEpoch: this.getBootEpoch(),
      catalogRevision: this.options.getCatalogRevision?.(),
      client: request.client,
      status: waiting
        ? "waiting"
        : request.deploymentPolicy === "existing-only" &&
        bindings.every((binding) => binding.status === "HOT" || binding.status === "BUSY")
        ? "ready"
        : "pending",
      requirements: request.requirements,
      bindings,
      allowFallback: request.allowFallback,
      deploymentPolicy: request.deploymentPolicy,
      priority: request.priority,
      capacityPolicy: request.capacityPolicy,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + request.ttlSeconds * 1000).toISOString(),
    };
    this.allocations.set(allocation.id, allocation);
    this.allocationLifecycleAborts.set(allocation.id, new AbortController());
    this.emit(
      allocation.status === "waiting" ? "allocation_waiting" : "allocation_pending",
      this.allocationLabels(allocation),
    );
    this.scheduleAllocationExpiry(allocation);
    this.cancelIdle();

    if (allocation.status === "ready") {
      this.emit("allocation_ready", this.allocationLabels(allocation));
      this.pruneHistory();
      return {
        status: 200 as const,
        body: allocation,
      };
    }

    const deadline = allocation.status === "waiting"
      ? Date.parse(allocation.expiresAt)
      : this.allocationStartupDeadline(allocation);
    const operation: Operation = {
      id: this.createOperationId(),
      kind: "allocation",
      allocationId: allocation.id,
      status: "pending",
      ready: false,
      desired: [...capabilities].sort(),
      ensure: runtimeIds,
      createdAt: new Date(now).toISOString(),
      deadlineAt: new Date(deadline).toISOString(),
      phase: allocation.status === "waiting" ? "waiting-for-capacity" : "scheduled",
    };
    allocation.operationId = operation.id;
    this.operations.set(operation.id, operation);
    if (allocation.status === "waiting") {
      this.enqueue(() => this.promoteWaitingAllocations());
    } else {
      this.enqueue(() => this.runAllocationEnsure(allocation, operation, deadline));
    }
    this.pruneHistory();

    return {
      status: 202 as const,
      body: allocation,
    };
  }

  renewAllocation(id: string, ttlSeconds: number) {
    if (this.draining) {
      return {
        status: 503 as const,
        body: { error: { code: "draining", message: "control plane is draining" } },
      };
    }
    this.expireDueAllocations();
    const allocation = this.allocations.get(id);
    if (!allocation) {
      return this.allocationLookupError(id);
    }
    if (!activeAllocation(allocation.status)) {
      return {
        status: 409 as const,
        body: {
          error: {
            code: "allocation_inactive",
            message: `allocation ${id} is ${allocation.status}`,
          },
        },
      };
    }
    allocation.expiresAt = new Date(this.now() + ttlSeconds * 1000).toISOString();
    this.scheduleAllocationExpiry(allocation);
    return { status: 200 as const, body: allocation };
  }

  resolveAllocation(id: string, capability: string) {
    if (this.draining) {
      return {
        status: 503 as const,
        body: { error: { code: "draining", message: "control plane is draining" } },
      };
    }
    this.expireDueAllocations();
    const allocation = this.allocations.get(id);
    if (!allocation) {
      return this.allocationLookupError(id);
    }
    if (allocation.status !== "ready") {
      return {
        status: activeAllocation(allocation.status) ? 503 as const : 409 as const,
        body: {
          error: {
            code: "allocation_not_ready",
            message: `allocation ${id} is ${allocation.status}`,
          },
        },
      };
    }
    const binding = allocation.bindings.find((item) => item.capability === capability);
    if (!binding) {
      return {
        status: 404 as const,
        body: {
          error: {
            code: "capability_not_allocated",
            message: `allocation ${id} does not bind ${capability}`,
          },
        },
      };
    }
    const state = this.observer.getState();
    if (!this.hasFreshState()) {
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
    const snapshot = state.runtimes.find((runtime) => runtime.id === binding.runtime);
    if (!snapshot || (snapshot.status !== "HOT" && snapshot.status !== "BUSY")) {
      if (snapshot) {
        binding.status = snapshot.status;
      }
      return {
        status: 503 as const,
        body: {
          error: {
            code: "runtime_not_ready",
            message: `allocated runtime ${binding.runtime} is not ready`,
          },
        },
      };
    }
    binding.status = snapshot.status;
    return { status: 200 as const, body: binding };
  }

  async releaseAllocation(id: string, terminal: "released" | "expired" = "released") {
    const allocation = this.allocations.get(id);
    if (!allocation) {
      return this.allocationLookupError(id);
    }
    if (allocation.status === "released" || allocation.status === "expired") {
      return { status: 200 as const, body: allocation };
    }
    allocation.status = terminal;
    allocation.releasedAt = this.isoNow();
    this.clearAllocationTimer(id);
    this.allocationAborts.get(id)?.abort(new Error(`allocation ${terminal}`));
    this.allocationLifecycleAborts.get(id)?.abort(new Error(`allocation ${terminal}`));
    this.detachLegacyAllocation(id);
    if (allocation.operationId) {
      const operation = this.operations.get(allocation.operationId);
      if (operation && (operation.status === "pending" || operation.status === "running")) {
        operation.status = terminal === "expired" ? "timed_out" : "cancelled";
        operation.completedAt = this.isoNow();
      }
    }
    this.emit(`allocation_${terminal}`, this.allocationLabels(allocation));
    this.enqueue(() => this.promoteWaitingAllocations());
    this.scheduleIdleReconcile();
    this.pruneHistory();
    return { status: 200 as const, body: allocation };
  }

  async prepare(request: PrepareRequest) {
    if (this.draining) {
      return {
        status: 503 as const,
        body: { error: { code: "draining", message: "control plane is draining" } },
      };
    }
    const expanded = expandPrepareRequest(this.registry, request);
    if (!expanded.ok) {
      if (expanded.reason === "unknown_profile") {
        return {
          status: 404 as const,
          body: {
            error: { code: "not_found", message: `profile ${request.profile} is not defined` },
          },
        };
      }
      return {
        status: 400 as const,
        body: { error: { code: "bad_request", message: "profile or capabilities is required" } },
      };
    }

    const requirements = expanded.capabilities.map((capability) => ({
      capability,
      route: findDefaultRoute(this.registry, capability)?.id,
    }));
    if (requirements.every(
      (requirement): requirement is { capability: string; route: string } => Boolean(requirement.route),
    )) {
      const allocated = await this.allocate({
        requirements,
        client: request.client,
        allowFallback: true,
        ttlSeconds: 86_400,
        deploymentPolicy: "existing-only",
        priority: 0,
        capacityPolicy: "reject",
      });
      if (allocated.status !== 200 && allocated.status !== 202) {
        return allocated;
      }
      const allocation = allocated.body as Allocation;
      if (!activeAllocation(allocation.status)) {
        return {
          status: 503 as const,
          body: {
            error: allocation.error ?? {
              code: "allocation_failed",
              message: "allocation failed before the legacy lease was created",
            },
          },
        };
      }
      const lease: Lease = {
        id: this.uniqueId(
          createLeaseId(this.options.random),
          (candidate) => this.leases.has(candidate),
        ),
        client: request.client,
        capabilities: expanded.capabilities,
        profile: expanded.profile,
        createdAt: this.isoNow(),
      };
      this.leases.set(lease.id, lease);
      this.legacyAllocationByLease.set(lease.id, allocation.id);
      if (allocation.operationId) {
        const operation = this.operations.get(allocation.operationId);
        if (operation) {
          operation.leaseId = lease.id;
        }
      }
      return {
        status: allocated.status,
        body: {
          leaseId: lease.id,
          operationId: allocation.operationId,
          desired: expanded.capabilities,
          ready: allocation.status === "ready",
          runtimes: [...new Set(allocation.bindings.map((binding) => binding.runtime))],
        },
      };
    }

    if (!this.hasFreshState()) {
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

    const trial = planTransition({
      registry: this.registry,
      state: this.observer.getState(),
      leases: [
        ...this.planningLeases(),
        {
          id: "trial",
          capabilities: expanded.capabilities,
          createdAt: this.isoNow(),
        },
      ],
    });

    if (trial.uncovered.length > 0) {
      return {
        status: 409 as const,
        body: {
          error: {
            code: "unsatisfiable",
            message: `no runtime can provide: ${trial.uncovered.join(", ")}`,
          },
        },
      };
    }

    const activeLimit = Math.max(1, this.options.maxActiveAllocations ?? 1_000);
    if (this.activeAdmissionCount() >= activeLimit) {
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

    this.cancelIdle();
    const lease: Lease = {
      id: this.uniqueId(
        createLeaseId(this.options.random),
        (candidate) => this.leases.has(candidate),
      ),
      client: request.client,
      capabilities: expanded.capabilities,
      profile: expanded.profile,
      createdAt: this.isoNow(),
    };
    this.leases.set(lease.id, lease);

    const plan = planTransition({
      registry: this.registry,
      state: this.observer.getState(),
      leases: this.planningLeases(),
    });

    const covering = this.observer
      .getState()
      .runtimes.filter((runtime) => runtime.status === "HOT" || runtime.status === "BUSY")
      .map((runtime) => runtime.id);

    if (plan.ensure.length === 0) {
      return {
        status: 200 as const,
        body: {
          leaseId: lease.id,
          desired: plan.desired,
          ready: true,
          runtimes: covering,
        },
      };
    }

    const operation: Operation = {
      id: this.createOperationId(),
      kind: "prepare",
      leaseId: lease.id,
      status: "pending",
      ready: false,
      desired: plan.desired,
      ensure: plan.ensure,
      createdAt: this.isoNow(),
    };
    this.operations.set(operation.id, operation);
    const abort = new AbortController();
    this.operationAborts.set(operation.id, abort);
    this.enqueue(() => this.runEnsure(operation, abort));
    this.pruneHistory();

    return {
      status: 202 as const,
      body: {
        leaseId: lease.id,
        operationId: operation.id,
        desired: plan.desired,
        ready: false,
        runtimes: plan.ensure,
      },
    };
  }

  async release(leaseId: string) {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      return {
        status: 404 as const,
        body: { error: { code: "not_found", message: `lease ${leaseId} is not active` } },
      };
    }
    this.leases.delete(leaseId);
    for (const operation of this.operations.values()) {
      if (
        operation.leaseId === leaseId
        && (operation.status === "pending" || operation.status === "running")
      ) {
        this.operationAborts.get(operation.id)?.abort(new Error(`lease ${leaseId} released`));
      }
    }
    const allocationId = this.legacyAllocationByLease.get(leaseId);
    if (allocationId) {
      this.legacyAllocationByLease.delete(leaseId);
      await this.releaseAllocation(allocationId);
    }
    const plan = planTransition({
      registry: this.registry,
      state: this.observer.getState(),
      leases: this.planningLeases(),
    });

    if (this.planningLeases().length === 0 && plan.stop.length > 0) {
      this.scheduleIdleStop(plan.stop);
    }

    return {
      status: 200 as const,
      body: { released: true, leaseId, desired: plan.desired },
    };
  }

  resolve(capability: string) {
    if (this.draining) {
      return {
        status: 503 as const,
        body: { error: { code: "draining", message: "control plane is draining" } },
      };
    }
    const result = resolveCapability(this.registry, this.observer.getState(), capability);
    if (!result.ok && result.reason === "unknown_capability") {
      return {
        status: 404 as const,
        body: { error: { code: "not_found", message: `capability ${capability} is not in the registry` } },
      };
    }
    if (!this.hasFreshState()) {
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
    this.observeRouteShadow(capability, result);
    if (!result.ok) {
      return {
        status: 503 as const,
        body: { error: { code: "not_ready", message: "no HOT runtime; call POST /prepare first" } },
      };
    }
    return {
      status: 200 as const,
      body: {
        runtime: result.runtime,
        node: result.node,
        endpoint: result.endpoint,
        status: result.status,
      },
    };
  }

  async flush(): Promise<void> {
    while (true) {
      const current = this.applyChain;
      await current;
      if (this.applyChain === current) {
        return;
      }
    }
  }

  async reconcileOrphanedPreferred(): Promise<string[]> {
    if (this.draining) {
      return [];
    }
    this.expireDueAllocations();
    const state = await this.observer.tick();
    const allocated = new Set(
      [...this.allocations.values()]
        .filter((allocation) => activeAllocation(allocation.status))
        .flatMap((allocation) => allocation.bindings.map((binding) => binding.runtime)),
    );
    const legacyCapabilities = new Set(
      [...this.leases.values()].flatMap((lease) => lease.capabilities),
    );
    const stopped: string[] = [];
    for (const snapshot of state.runtimes) {
      const runtime = getRuntime(this.registry, snapshot.id);
      if (
        !runtime
        || runtime.policy.class !== "preferred"
        || snapshot.status !== "HOT"
        || allocated.has(runtime.id)
        || runtime.capability.some((capability) => legacyCapabilities.has(capability))
        || this.options.isRuntimeMutating?.(runtime.id)
      ) {
        continue;
      }
      this.lifecycleReservations.add(runtime.id);
      try {
        const inUse = [...this.allocations.values()].some(
          (allocation) => activeAllocation(allocation.status)
            && allocation.bindings.some((binding) => binding.runtime === runtime.id),
        );
        if (inUse || this.options.isRuntimeMutating?.(runtime.id)) {
          continue;
        }
        await this.backend.stop(runtime.id);
        stopped.push(runtime.id);
        this.emit("startup_reconciliation", { runtime: runtime.id, result: "stopped_orphan" });
      } finally {
        this.lifecycleReservations.delete(runtime.id);
      }
    }
    if (stopped.length > 0) {
      await this.observer.tick();
    }
    return stopped;
  }

  private enqueue(work: () => Promise<void>): void {
    this.applyChain = this.applyChain.then(work).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`control plane task failed: ${message}`);
    });
  }

  private async runAllocationEnsure(
    allocation: Allocation,
    operation: Operation,
    deadline: number,
  ): Promise<void> {
    if (!activeAllocation(allocation.status)) {
      return;
    }
    operation.status = "running";
    const abort = new AbortController();
    this.allocationAborts.set(allocation.id, abort);
    let deadlineExceeded = false;
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      abort.abort(new Error("allocation startup deadline exceeded"));
    }, Math.max(0, deadline - this.now()));
    deadlineTimer.unref?.();
    try {
      const runtimeIds = [...new Set(allocation.bindings.map((binding) => binding.runtime))];
      for (const runtimeId of runtimeIds) {
        if (!activeAllocation(allocation.status)) {
          return;
        }
        if (allocation.deploymentPolicy === "allow-listed") {
          if (!this.options.deploymentCoordinator) {
            throw new Error("allow-listed deployment is not configured");
          }
          await this.options.deploymentCoordinator.ensureRuntime(
            runtimeId,
            allocation.id,
            (phase) => {
              operation.phase = phase;
            },
            abort.signal,
          );
          if (!activeAllocation(allocation.status)) {
            return;
          }
          if (abort.signal.aborted) {
            throw abort.signal.reason;
          }
        }
        const runtime = getRuntime(this.registry, runtimeId);
        if (!runtime) {
          throw new Error(`runtime ${runtimeId} disappeared from registry`);
        }
        const status = this.observer.getState().runtimes.find((item) => item.id === runtimeId)?.status;
        if (status === "COLD") {
          operation.phase = "starting-runtime";
          await this.backend.ensure(runtime, abort.signal);
        }
      }

      operation.phase = "verifying-runtime";
      while (activeAllocation(allocation.status)) {
        const state = await this.observer.tick();
        for (const binding of allocation.bindings) {
          const snapshot = state.runtimes.find((item) => item.id === binding.runtime);
          if (snapshot) {
            binding.status = snapshot.status;
          }
        }
        if (allocation.bindings.every(
          (binding) => binding.status === "HOT" || binding.status === "BUSY",
        )) {
          allocation.status = "ready";
          operation.status = "succeeded";
          operation.ready = true;
          operation.phase = "runtime-ready";
          operation.completedAt = this.isoNow();
          this.emit("allocation_ready", this.allocationLabels(allocation));
          this.emit(
            "allocation_startup_seconds",
            this.allocationLabels(allocation),
            Math.max(0, (this.now() - Date.parse(allocation.createdAt)) / 1_000),
          );
          return;
        }
        if (allocation.bindings.some((binding) => binding.status === "FAILED")) {
          throw new Error("one or more allocated runtimes failed during startup");
        }
        if (this.now() >= deadline) {
          allocation.status = "failed";
          allocation.error = {
            code: "startup_timeout",
            message: "allocated runtimes did not become ready before the deadline",
          };
          operation.status = "timed_out";
          operation.error = allocation.error;
          operation.completedAt = this.isoNow();
          this.clearAllocationTimer(allocation.id);
          this.allocationLifecycleAborts.get(allocation.id)?.abort(new Error("allocation failed"));
          this.detachLegacyAllocation(allocation.id);
          this.emit("allocation_failed", {
            ...this.allocationLabels(allocation),
            reason: "startup_timeout",
          });
          return;
        }
        await (this.options.sleep ?? ((ms: number) => Bun.sleep(ms)))(
          this.options.pollIntervalMs ?? 500,
        );
      }
    } catch (err) {
      if (!activeAllocation(allocation.status)) {
        return;
      }
      const error = deadlineExceeded
        ? {
            code: "startup_timeout",
            message: "allocated runtimes did not become ready before the deadline",
          }
        : err instanceof LifecycleError || err instanceof ArtifactStoreError
        ? { code: err.code, message: err.message }
        : {
            code: "start_failed",
            message: err instanceof Error ? err.message : String(err),
          };
      allocation.status = "failed";
      allocation.error = error;
      operation.status = deadlineExceeded ? "timed_out" : "failed";
      operation.ready = false;
      operation.error = error;
      operation.completedAt = this.isoNow();
      this.clearAllocationTimer(allocation.id);
      this.allocationLifecycleAborts.get(allocation.id)?.abort(new Error("allocation failed"));
      this.detachLegacyAllocation(allocation.id);
      this.emit("allocation_failed", {
        ...this.allocationLabels(allocation),
        reason: error.code,
      });
    } finally {
      clearTimeout(deadlineTimer);
      if (this.allocationAborts.get(allocation.id) === abort) {
        this.allocationAborts.delete(allocation.id);
      }
      if (!activeAllocation(allocation.status)) {
        try {
          await this.observer.tick();
        } catch {
          // The idle reconcile still applies resident protection when observation fails.
        }
        this.scheduleIdleReconcile();
        this.enqueue(() => this.promoteWaitingAllocations());
      }
      this.pruneHistory();
    }
  }

  private async runEnsure(operation: Operation, abort: AbortController): Promise<void> {
    if (abort.signal.aborted) {
      operation.status = "cancelled";
      operation.ready = false;
      operation.completedAt = this.isoNow();
      operation.error = {
        code: "operation_cancelled",
        message: abort.signal.reason instanceof Error
          ? abort.signal.reason.message
          : "operation cancelled",
      };
      this.operationAborts.delete(operation.id);
      this.pruneHistory();
      return;
    }
    operation.status = "running";
    try {
      for (const runtimeId of operation.ensure) {
        if (abort.signal.aborted) {
          throw abort.signal.reason;
        }
        const runtime = getRuntime(this.registry, runtimeId);
        if (!runtime) {
          throw new Error(`runtime ${runtimeId} disappeared from registry`);
        }
        await this.backend.ensure(runtime, abort.signal);
        if (abort.signal.aborted) {
          throw abort.signal.reason;
        }
        await this.observer.tick();
        if (abort.signal.aborted) {
          throw abort.signal.reason;
        }
      }
      operation.status = "succeeded";
      operation.ready = true;
      operation.completedAt = this.isoNow();
    } catch (err) {
      operation.status = abort.signal.aborted ? "cancelled" : "failed";
      operation.ready = false;
      operation.completedAt = this.isoNow();
      if (abort.signal.aborted) {
        operation.error = {
          code: "operation_cancelled",
          message: abort.signal.reason instanceof Error
            ? abort.signal.reason.message
            : "operation cancelled",
        };
      } else if (err instanceof LifecycleError) {
        operation.error = { code: err.code, message: err.message };
      } else {
        operation.error = {
          code: "start_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    } finally {
      if (this.operationAborts.get(operation.id) === abort) {
        this.operationAborts.delete(operation.id);
      }
      this.pruneHistory();
    }
  }

  private async runStop(ids: string[]): Promise<void> {
    await this.observer.tick();
    for (const runtimeId of ids) {
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
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
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
    return [...this.leases.values(), ...allocationLeases];
  }

  private activeAdmissionCount(): number {
    const directLegacyLeases = [...this.leases.keys()].filter((leaseId) =>
      !this.legacyAllocationByLease.has(leaseId)
    ).length;
    return this.getActiveAllocationCount() + directLegacyLeases;
  }

  private admittedAllocations(): Allocation[] {
    return [...this.allocations.values()].filter((allocation) =>
      admittedAllocation(allocation.status)
    );
  }

  private allocationResourceKeys(runtimeIds: string[]): Set<string> {
    const keys = new Set<string>();
    for (const runtimeId of runtimeIds) {
      keys.add(`runtime:${runtimeId}`);
      const swapGroup = getRuntime(this.registry, runtimeId)?.policy.swapGroup;
      if (swapGroup) keys.add(`swap:${swapGroup}`);
    }
    return keys;
  }

  private hasResourceConflict(
    runtimeIds: string[],
    predicate: (allocation: Allocation) => boolean,
  ): boolean {
    const requested = this.allocationResourceKeys(runtimeIds);
    return [...this.allocations.values()].some((allocation) => {
      if (!predicate(allocation)) return false;
      const existing = this.allocationResourceKeys(
        allocation.bindings.map((binding) => binding.runtime),
      );
      return [...requested].some((key) => existing.has(key));
    });
  }

  private allocationStartupDeadline(allocation: Allocation): number {
    return Math.min(
      Date.parse(allocation.expiresAt),
      this.now() + (this.options.startupTimeoutMs ?? 300_000),
    );
  }

  private allocationAdmission(allocation: Allocation) {
    return admitRuntimes({
      registry: this.registry,
      state: this.observer.getState(),
      allocations: this.admittedAllocations(),
      candidateRuntimeIds: [...new Set(allocation.bindings.map((binding) => binding.runtime))],
      ...(this.options.requireFreshTelemetry
        ? {
          liveTelemetry: {
            requiredForNonResident: true,
            maxAgeMs: this.options.telemetryMaxAgeMs ?? 10_000,
            now: this.now(),
          },
        }
        : {}),
    });
  }

  private async promoteWaitingAllocations(): Promise<void> {
    if (this.draining) return;
    if (!this.hasFreshState()) {
      try {
        await this.observer.tick();
      } catch {
        this.scheduleWaitingPromotion();
        return;
      }
      if (!this.hasFreshState()) {
        this.scheduleWaitingPromotion();
        return;
      }
    }
    const waiting = [...this.allocations.values()]
      .filter((allocation) => allocation.status === "waiting")
      .sort((left, right) => {
        const byPriority = (right.priority ?? 0) - (left.priority ?? 0);
        if (byPriority !== 0) return byPriority;
        const byCreated = Date.parse(left.createdAt) - Date.parse(right.createdAt);
        return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
      });
    let retryNeeded = false;
    for (const allocation of waiting) {
      if (allocation.status !== "waiting" || Date.parse(allocation.expiresAt) <= this.now()) {
        continue;
      }
      const runtimeIds = [...new Set(allocation.bindings.map((binding) => binding.runtime))];
      const lifecycleRuntimeIds = new Set(runtimeIds);
      for (const runtimeId of runtimeIds) {
        const swapGroup = getRuntime(this.registry, runtimeId)?.policy.swapGroup;
        if (!swapGroup) continue;
        for (const peer of this.registry.runtimes) {
          if (peer.policy.swapGroup === swapGroup) lifecycleRuntimeIds.add(peer.id);
        }
      }
      if ([...lifecycleRuntimeIds].some((runtimeId) =>
        this.lifecycleReservations.has(runtimeId) || this.options.isRuntimeMutating?.(runtimeId)
      )) {
        retryNeeded = true;
        continue;
      }
      const admission = this.allocationAdmission(allocation);
      if (!admission.ok) {
        if (!this.hasResourceConflict(
          runtimeIds,
          (candidate) => admittedAllocation(candidate.status),
        )) {
          retryNeeded = true;
        }
        continue;
      }
      const state = this.observer.getState();
      for (const binding of allocation.bindings) {
        const snapshot = state.runtimes.find((runtime) => runtime.id === binding.runtime);
        if (snapshot) binding.status = snapshot.status;
      }
      const operation = allocation.operationId
        ? this.operations.get(allocation.operationId)
        : undefined;
      const ready = allocation.deploymentPolicy === "existing-only"
        && allocation.bindings.every((binding) =>
          binding.status === "HOT" || binding.status === "BUSY"
        );
      allocation.status = ready ? "ready" : "pending";
      this.emit("allocation_admitted", this.allocationLabels(allocation));
      if (ready) {
        if (operation) {
          operation.status = "succeeded";
          operation.ready = true;
          operation.phase = "runtime-ready";
          operation.completedAt = this.isoNow();
        }
        this.emit("allocation_ready", this.allocationLabels(allocation));
        continue;
      }
      if (!operation) {
        allocation.status = "failed";
        allocation.error = {
          code: "operation_missing",
          message: "waiting allocation lost its startup operation",
        };
        this.allocationLifecycleAborts.get(allocation.id)?.abort(new Error("allocation failed"));
        continue;
      }
      const deadline = this.allocationStartupDeadline(allocation);
      operation.deadlineAt = new Date(deadline).toISOString();
      operation.phase = "scheduled";
      await this.runAllocationEnsure(allocation, operation, deadline);
    }
    this.pruneHistory();
    if (retryNeeded) this.scheduleWaitingPromotion();
  }

  private scheduleWaitingPromotion(): void {
    if (
      this.draining
      || this.waitingTimer
      || ![...this.allocations.values()].some((allocation) => allocation.status === "waiting")
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (this.waitingTimer === timer) this.waitingTimer = undefined;
      this.enqueue(() => this.promoteWaitingAllocations());
    }, this.options.pollIntervalMs ?? 500);
    timer.unref?.();
    this.waitingTimer = timer;
  }

  private cancelWaitingPromotion(): void {
    if (!this.waitingTimer) return;
    clearTimeout(this.waitingTimer);
    this.waitingTimer = undefined;
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
    if (this.draining) {
      return;
    }
    const ttl = this.options.idleTtlMs ?? 60_000;
    this.cancelIdle();
    if (ttl <= 0) {
      this.enqueue(() => this.runStop(ids));
      return;
    }
    const timer = setTimeout(() => {
      if (this.idleTimer === timer) {
        this.idleTimer = undefined;
      }
      this.enqueue(() => this.runStop(ids));
    }, ttl);
    this.idleTimer = timer;
    this.idleTimer.unref?.();
  }

  private scheduleAllocationExpiry(allocation: Allocation): void {
    const existing = this.allocationTimers.get(allocation.id);
    if (existing) {
      clearTimeout(existing);
    }
    const delay = Math.max(0, Date.parse(allocation.expiresAt) - this.now());
    const timer = setTimeout(() => {
      void this.releaseAllocation(allocation.id, "expired");
    }, delay);
    timer.unref?.();
    this.allocationTimers.set(allocation.id, timer);
  }

  private clearAllocationTimer(id: string): void {
    const timer = this.allocationTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.allocationTimers.delete(id);
    }
  }

  private expireDueAllocations(): void {
    const now = this.now();
    for (const allocation of this.allocations.values()) {
      if (activeAllocation(allocation.status) && Date.parse(allocation.expiresAt) <= now) {
        void this.releaseAllocation(allocation.id, "expired");
      }
    }
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
    for (const [leaseId, mappedAllocationId] of this.legacyAllocationByLease) {
      if (mappedAllocationId !== allocationId) {
        continue;
      }
      this.legacyAllocationByLease.delete(leaseId);
      this.leases.delete(leaseId);
    }
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
