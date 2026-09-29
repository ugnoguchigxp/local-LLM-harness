import { activeAllocation, type Allocation, type Registry, type RuntimeReleaseDefinition } from "@larm/core";
import { ArtifactStoreError, type RuntimeBackend, LifecycleError } from "@larm/backends";
import type { Observer } from "./observer";
import type { Operation } from "./controller";
import {
  commitAllocationStartupFailure,
  commitAllocationStartupReady,
} from "./allocation-lifecycle-commit";
import { startAndVerifyAllocationRuntimes } from "./allocation-runtime-startup";
import type { ProviderInstanceManager } from "./provider-instance-manager";

export type AllocationStartupLifecycleOptions = {
  registry: Registry;
  backend: RuntimeBackend;
  observer: Observer;
  providerInstances: ProviderInstanceManager;
  allocationAborts: Map<string, AbortController>;
  allocationLifecycleAborts: Map<string, AbortController>;
  deploymentCoordinator?: {
    ensureRuntime(
      runtimeId: string,
      allocationId?: string,
      onPhase?: (phase: string) => void,
      signal?: AbortSignal,
    ): Promise<void>;
  };
  getRuntimeRelease?: (runtimeId: string) => string | undefined;
  getRuntimeReleaseDefinition?: (runtimeId: string) => RuntimeReleaseDefinition | undefined;
  now: () => number;
  isoNow: () => string;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  allocationLabels: (allocation: Allocation) => Record<string, string>;
  emit: (name: string, labels: Record<string, string>, value?: number) => void;
  clearAllocationTimer: (id: string) => void;
  detachLegacyAllocation: (id: string) => void;
  scheduleIdleReconcile: () => void;
  enqueueWaitingPromotion: () => void;
  pruneHistory: () => void;
};

export class AllocationStartupLifecycle {
  constructor(private readonly options: AllocationStartupLifecycleOptions) {}

  async run(allocation: Allocation, operation: Operation, deadline: number): Promise<void> {
    const d = this.options;
    if (!activeAllocation(allocation.status)) return;
    operation.status = "running";
    const abort = new AbortController();
    d.allocationAborts.set(allocation.id, abort);
    let deadlineExceeded = false;
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      abort.abort(new Error("allocation startup deadline exceeded"));
    }, Math.max(0, deadline - d.now()));
    deadlineTimer.unref?.();
    try {
      const result = await startAndVerifyAllocationRuntimes({
        allocation,
        registry: d.registry,
        backend: d.backend,
        observer: d.observer,
        providerInstances: d.providerInstances,
        deadline,
        signal: abort.signal,
        isActive: () => activeAllocation(allocation.status),
        ensureDeployment: d.deploymentCoordinator?.ensureRuntime.bind(d.deploymentCoordinator),
        runtimeRelease: (runtimeId) => d.getRuntimeReleaseDefinition?.(runtimeId)
          ?? d.getRuntimeRelease?.(runtimeId),
        now: d.now,
        sleep: d.sleep,
        pollIntervalMs: d.pollIntervalMs,
        setPhase: (phase) => { operation.phase = phase; },
      });
      if (!activeAllocation(allocation.status)) return;
      if (result === "ready") {
        commitAllocationStartupReady({ allocation, operation, completedAt: d.isoNow() });
        const labels = d.allocationLabels(allocation);
        d.emit("allocation_ready", labels);
        d.emit(
          "allocation_startup_seconds",
          labels,
          Math.max(0, (d.now() - Date.parse(allocation.createdAt)) / 1_000),
        );
        return;
      }
      this.fail(allocation, operation, "timed_out", {
        code: "startup_timeout",
        message: "allocated runtimes did not become ready before the deadline",
      });
    } catch (error) {
      if (!activeAllocation(allocation.status)) {
        d.providerInstances.releaseAllocation(allocation.id);
        return;
      }
      const failure = deadlineExceeded
        ? {
            terminal: "timed_out" as const,
            error: {
              code: "startup_timeout",
              message: "allocated runtimes did not become ready before the deadline",
            },
          }
        : {
            terminal: "failed" as const,
            error: error instanceof LifecycleError || error instanceof ArtifactStoreError
              ? { code: error.code, message: error.message }
              : { code: "start_failed", message: error instanceof Error ? error.message : String(error) },
          };
      this.fail(allocation, operation, failure.terminal, failure.error);
    } finally {
      clearTimeout(deadlineTimer);
      if (d.allocationAborts.get(allocation.id) === abort) {
        d.allocationAborts.delete(allocation.id);
      }
      if (!activeAllocation(allocation.status)) {
        d.providerInstances.releaseAllocation(allocation.id);
        try {
          await d.observer.tick();
        } catch {
          // The idle reconcile still applies resident protection when observation fails.
        }
        d.scheduleIdleReconcile();
        d.enqueueWaitingPromotion();
      }
      d.pruneHistory();
    }
  }

  private fail(
    allocation: Allocation,
    operation: Operation,
    terminal: "failed" | "timed_out",
    error: { code: string; message: string },
  ): void {
    const d = this.options;
    commitAllocationStartupFailure({
      allocation,
      operation,
      terminal,
      error,
      completedAt: d.isoNow(),
    });
    d.clearAllocationTimer(allocation.id);
    d.allocationLifecycleAborts.get(allocation.id)?.abort(new Error("allocation failed"));
    d.detachLegacyAllocation(allocation.id);
    d.emit("allocation_failed", {
      ...d.allocationLabels(allocation),
      reason: error.code,
    });
  }
}
