import {
  compileProviderRevision,
  managedWarmPolicy,
  type ProviderInstance,
  type RuntimeReleaseDefinition,
  type RuntimeDefinition,
} from "@larm/core";
import { LifecycleError, type RuntimeBackend } from "@larm/backends";

type RefKind = "allocation" | "request" | "mutation";

type ManagedInstance = {
  instance: ProviderInstance;
  runtime: RuntimeDefinition;
  refs: Record<RefKind, Set<string>>;
  warmRefs: number;
  idleDeadline?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type EnsureFlight = {
  runtimeId: string;
  revision: string;
  controller: AbortController;
  promise: Promise<ManagedInstance>;
  settled: boolean;
  waiters: Set<symbol>;
};

export type ProviderInstanceInspection = {
  instance: ProviderInstance;
  refs: Record<RefKind, number>;
  warmRefs: number;
  idleDeadline?: string;
};

export class ProviderInstanceManager {
  private readonly byRevision = new Map<string, ManagedInstance>();
  private readonly byId = new Map<string, ManagedInstance>();
  private readonly ensures = new Map<string, EnsureFlight>();

  constructor(
    private readonly backend: RuntimeBackend,
    private readonly options: {
      now?: () => number;
      idleTtlMs?: number;
      onEvent?: (name: string, labels: Record<string, string>) => void;
    } = {},
  ) {}

  hasRuntime(runtimeId: string): boolean {
    return [...this.byId.values()].some((record) => record.instance.runtimeId === runtimeId);
  }

  retainExisting(
    runtimeId: string,
    allocationId: string,
    providerRevision?: string,
  ): ProviderInstance | undefined {
    const record = [...this.byId.values()].find(
      (item) => item.instance.runtimeId === runtimeId
        && ["STARTING", "HOT", "BUSY"].includes(item.instance.status)
        && (!providerRevision || item.instance.revision === providerRevision),
    );
    if (!record) return undefined;
    this.cancelIdle(record);
    record.refs.allocation.add(allocationId);
    this.emit("provider_instance_reused", record);
    return record.instance;
  }

  async acquire(
    runtime: RuntimeDefinition,
    allocationId: string,
    runtimeRelease?: string | RuntimeReleaseDefinition,
    signal?: AbortSignal,
  ): Promise<ProviderInstance> {
    const revision = typeof runtimeRelease === "string" || runtimeRelease === undefined
      ? compileProviderRevision({ runtime, runtimeRelease })
      : compileProviderRevision({ runtime, release: runtimeRelease });
    let record = this.byRevision.get(revision.revision);
    if (record?.instance.status === "FAILED" && this.referenceCount(record) === 0 && record.warmRefs === 0) {
      this.cancelIdle(record);
      if (await this.stopIfIdle(record.instance.id, record.instance.generation)) {
        record = undefined;
      }
    }
    if (record && !["STARTING", "HOT", "BUSY"].includes(record.instance.status)) {
      throw new LifecycleError(
        "revision_conflict",
        `runtime ${runtime.id} revision ${revision.revision.slice(0, 12)} is ${record.instance.status}`,
      );
    }
    if (!record) {
      const conflictingFlight = [...this.ensures.values()].find(
        (item) => item.runtimeId === runtime.id && item.revision !== revision.revision,
      );
      if (conflictingFlight) {
        throw new LifecycleError(
          "revision_conflict",
          `runtime ${runtime.id} is starting a different revision`,
        );
      }
      const conflicting = [...this.byId.values()].find(
        (item) => item.instance.runtimeId === runtime.id
          && item.instance.revision !== revision.revision,
      );
      if (conflicting) {
        if (this.referenceCount(conflicting) > 0 || conflicting.warmRefs > 0) {
          throw new LifecycleError(
            "revision_conflict",
            `runtime ${runtime.id} still has references to revision ${conflicting.instance.revision.slice(0, 12)}`,
          );
        }
        this.cancelIdle(conflicting);
        if (!await this.stopIfIdle(conflicting.instance.id, conflicting.instance.generation)) {
          throw new LifecycleError(
            "revision_conflict",
            `runtime ${runtime.id} could not retire its previous revision`,
          );
        }
      }

      let flight = this.ensures.get(revision.revision);
      if (!flight) {
        const controller = new AbortController();
        let createdFlight!: EnsureFlight;
        const promise = (async () => {
          const instance = this.backend.ensureInstance
            ? await this.backend.ensureInstance(revision, runtime, controller.signal)
            : await this.ensureLegacy(revision.revision, runtime, controller.signal);
          const created: ManagedInstance = {
            instance,
            runtime,
            refs: { allocation: new Set(), request: new Set(), mutation: new Set() },
            warmRefs: 0,
          };
          this.byRevision.set(revision.revision, created);
          this.byId.set(instance.id, created);
          this.emit("provider_instance_ensured", created);
          if (createdFlight.waiters.size === 0) this.scheduleIfIdle(created);
          return created;
        })().finally(() => {
          createdFlight.settled = true;
          if (this.ensures.get(revision.revision) === createdFlight) {
            this.ensures.delete(revision.revision);
          }
        });
        createdFlight = {
          runtimeId: runtime.id,
          revision: revision.revision,
          controller,
          promise,
          settled: false,
          waiters: new Set(),
        };
        flight = createdFlight;
        this.ensures.set(revision.revision, flight);
      }

      const waiter = Symbol(allocationId);
      flight.waiters.add(waiter);
      let completed = false;
      try {
        record = await this.waitForFlight(flight, signal);
        completed = true;
      } finally {
        flight.waiters.delete(waiter);
        if (!flight.settled && flight.waiters.size === 0) {
          flight.controller.abort(new Error("provider ensure has no remaining waiters"));
        } else if (!completed && flight.waiters.size === 0) {
          const orphan = this.byRevision.get(flight.revision);
          if (orphan) this.scheduleIfIdle(orphan);
        }
      }
    }
    this.cancelIdle(record);
    record.refs.allocation.add(allocationId);
    return record.instance;
  }

  retainRequest(instanceId: string, requestId: string): void {
    const record = this.required(instanceId);
    this.cancelIdle(record);
    record.refs.request.add(requestId);
  }

  async ensureWarm(
    runtime: RuntimeDefinition,
    runtimeRelease?: string | RuntimeReleaseDefinition,
    signal?: AbortSignal,
  ): Promise<ProviderInstance | undefined> {
    const policy = managedWarmPolicy(runtime);
    if (policy.minInstances < 1) return undefined;
    const ref = `warm:${runtime.id}`;
    const instance = await this.acquire(runtime, ref, runtimeRelease, signal);
    const record = this.required(instance.id);
    record.refs.allocation.delete(ref);
    record.warmRefs = policy.minInstances;
    return instance;
  }

  releaseRequest(instanceId: string, requestId: string): void {
    const record = this.required(instanceId);
    record.refs.request.delete(requestId);
    this.scheduleIfIdle(record);
  }

  retainMutation(instanceId: string, mutationId: string): void {
    const record = this.required(instanceId);
    this.cancelIdle(record);
    record.refs.mutation.add(mutationId);
  }

  releaseMutation(instanceId: string, mutationId: string): void {
    const record = this.required(instanceId);
    record.refs.mutation.delete(mutationId);
    this.scheduleIfIdle(record);
  }

  releaseAllocation(allocationId: string): void {
    for (const record of this.byId.values()) {
      if (record.refs.allocation.delete(allocationId)) this.scheduleIfIdle(record);
    }
  }

  inspect(): ProviderInstanceInspection[] {
    return [...this.byId.values()].map((record) => ({
      instance: { ...record.instance },
      refs: {
        allocation: record.refs.allocation.size,
        request: record.refs.request.size,
        mutation: record.refs.mutation.size,
      },
      warmRefs: record.warmRefs,
      idleDeadline: record.idleDeadline,
    }));
  }

  close(): void {
    for (const record of this.byId.values()) this.cancelIdle(record);
  }

  private async ensureLegacy(
    revision: string,
    runtime: RuntimeDefinition,
    signal?: AbortSignal,
  ): Promise<ProviderInstance> {
    await this.backend.ensure(runtime, signal);
    return {
      id: `pinst-${runtime.id}-${revision.slice(0, 12)}-1`,
      runtimeId: runtime.id,
      revision,
      generation: 1,
      node: runtime.node,
      endpoint: runtime.deployment.endpoint,
      backendEndpoint: runtime.deployment.backendEndpoint ?? runtime.deployment.endpoint,
      status: "HOT",
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  private required(instanceId: string): ManagedInstance {
    const record = this.byId.get(instanceId);
    if (!record) throw new Error(`provider instance ${instanceId} is not managed`);
    return record;
  }

  private referenceCount(record: ManagedInstance): number {
    return record.refs.allocation.size + record.refs.request.size + record.refs.mutation.size;
  }

  private scheduleIfIdle(record: ManagedInstance): void {
    if (this.referenceCount(record) > 0 || record.warmRefs > 0) return;
    this.cancelIdle(record);
    const configured = managedWarmPolicy(record.runtime).idleTtlSeconds * 1_000;
    const ttl = this.options.idleTtlMs ?? configured;
    const expectedGeneration = record.instance.generation;
    record.idleDeadline = new Date(this.now() + Math.max(0, ttl)).toISOString();
    const stop = () => void this.stopIfIdle(record.instance.id, expectedGeneration);
    if (ttl <= 0) return stop();
    record.idleTimer = setTimeout(stop, ttl);
    record.idleTimer.unref?.();
  }

  private async stopIfIdle(instanceId: string, expectedGeneration: number): Promise<boolean> {
    const record = this.byId.get(instanceId);
    if (!record) return true;
    if (record.instance.generation !== expectedGeneration) return false;
    record.idleTimer = undefined;
    record.idleDeadline = undefined;
    if (this.referenceCount(record) > 0 || record.warmRefs > 0) return false;
    record.instance.status = "STOPPING";
    try {
      await this.backend.drainInstance?.(instanceId);
      if (
        this.referenceCount(record) > 0
        || record.warmRefs > 0
        || record.instance.generation !== expectedGeneration
      ) {
        record.instance.status = "HOT";
        return false;
      }
      if (this.backend.stopInstance) await this.backend.stopInstance(instanceId);
      else await this.backend.stop(record.runtime.id);
      this.byId.delete(instanceId);
      this.byRevision.delete(record.instance.revision);
      this.emit("provider_instance_stopped", record);
      return true;
    } catch {
      record.instance.status = "FAILED";
      this.emit("provider_instance_stop_failed", record);
      return false;
    }
  }

  private async waitForFlight(
    flight: EnsureFlight,
    signal?: AbortSignal,
  ): Promise<ManagedInstance> {
    if (!signal) return await flight.promise;
    if (signal.aborted) throw signal.reason;
    return await new Promise<ManagedInstance>((resolve, reject) => {
      const aborted = () => reject(signal.reason ?? new Error("provider ensure cancelled"));
      signal.addEventListener("abort", aborted, { once: true });
      void flight.promise.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", aborted);
      });
    });
  }

  private cancelIdle(record: ManagedInstance): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
    record.idleDeadline = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private emit(name: string, record: ManagedInstance): void {
    this.options.onEvent?.(name, {
      runtime: record.instance.runtimeId,
      revision: record.instance.revision.slice(0, 12),
      generation: String(record.instance.generation),
    });
  }
}
