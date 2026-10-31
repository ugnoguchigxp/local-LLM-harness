import { isMemoryPressure, memoryReclamationCandidates, type Allocation, type ClusterState, type MemoryPressure, type Registry } from "@larm/core";
import { withAbort } from "./http-body";

export class MemoryReclaimer {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    registry: Registry;
    state: () => ClusterState;
    tick: () => Promise<unknown>;
    allocations: () => readonly Allocation[];
    protectedRuntimeIds: () => ReadonlySet<string>;
    foregroundPriorityThreshold: () => number;
    retire: (victim: { runtime: string; allocations: string[] }, priority: number, signal?: AbortSignal) => Promise<boolean>;
    emit: (name: string, labels: Record<string, string>) => void;
  }) {}

  async reclaim(input: {
    evaluateAdmission: () => MemoryPressure;
    requestedRuntimeIds: readonly string[];
    priority: number;
    signal?: AbortSignal;
  }): Promise<void> {
    if (!isMemoryPressure(input.evaluateAdmission())) return;
    const work = this.chain.then(async () => {
      const d = this.options;
      input.signal?.throwIfAborted();
      await d.tick();
      const attempted = new Set<string>();
      for (;;) {
        input.signal?.throwIfAborted();
        const admission = input.evaluateAdmission();
        const protectedIds = new Set([...d.protectedRuntimeIds(), ...attempted]);
        const victim = memoryReclamationCandidates({
          registry: d.registry, state: d.state(), allocations: d.allocations(), admission,
          requestedRuntimeIds: input.requestedRuntimeIds, priority: input.priority,
          protectedRuntimeIds: protectedIds, foregroundPriorityThreshold: d.foregroundPriorityThreshold(),
        })[0];
        if (!victim) return;
        attempted.add(victim.runtime);
        const stopped = await d.retire(victim, input.priority, input.signal);
        d.emit("memory_reclamation", {
          runtime: victim.runtime, reason: admission.reason!, result: stopped ? "stopped" : "not_stopped",
          priority: String(input.priority),
        });
        // Never credit estimated memory as released. Both process state and fresh
        // telemetry must pass ordinary admission before the requester can start.
        await d.tick();
      }
    });
    this.chain = work.catch(() => {});
    await (input.signal ? withAbort(work, input.signal) : work);
  }

  async flush(): Promise<void> { await this.chain; }
}
