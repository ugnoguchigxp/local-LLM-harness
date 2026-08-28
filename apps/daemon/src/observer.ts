import {
  buildClusterState,
  buildRuntimeSnapshot,
  deriveStatus,
  isStartingCondition,
  primaryNode,
  type ClusterState,
  type Registry,
} from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";

export type ObserverOptions = {
  graceMs?: number;
  now?: () => number;
};

export class Observer {
  private readonly startingSince = new Map<string, number>();
  private snapshot: ClusterState;
  private tickInFlight: Promise<ClusterState> | undefined;

  constructor(
    private readonly registry: Registry,
    private readonly backend: RuntimeBackend,
    private readonly options: ObserverOptions = {},
  ) {
    const generatedAt = new Date(this.now()).toISOString();
    this.snapshot = buildClusterState({
      node: primaryNode(registry.nodes, registry.runtimes),
      snapshots: [],
      generatedAt,
    });
  }

  getState(): ClusterState {
    return this.snapshot;
  }

  tick(): Promise<ClusterState> {
    if (this.tickInFlight) {
      return this.tickInFlight;
    }
    const observed = this.observe();
    const tracked = observed.finally(() => {
      if (this.tickInFlight === tracked) {
        this.tickInFlight = undefined;
      }
    });
    this.tickInFlight = tracked;
    return tracked;
  }

  private async observe(): Promise<ClusterState> {
    const now = this.now();
    const observedAt = new Date(now).toISOString();
    const graceMs = this.options.graceMs ?? 300_000;
    const probes = await this.backend.list();
    const probeById = new Map(probes.map((probe) => [probe.runtimeId, probe]));

    const snapshots = this.registry.runtimes.map((runtime) => {
      const probe = probeById.get(runtime.id) ?? {
        runtimeId: runtime.id,
        service: "Unknown" as const,
        listening: false,
        healthOk: false,
        busy: false,
        detail: "no probe result",
      };

      const starting = isStartingCondition(probe);
      let startedAt = this.startingSince.get(runtime.id);
      if (starting) {
        if (startedAt === undefined) {
          startedAt = now;
          this.startingSince.set(runtime.id, startedAt);
        }
      } else {
        this.startingSince.delete(runtime.id);
        startedAt = undefined;
      }

      const startingGraceExpired =
        startedAt !== undefined && now - startedAt >= graceMs;

      const status = deriveStatus({
        service: probe.service,
        listening: probe.listening,
        healthOk: probe.healthOk,
        busy: probe.busy,
        startingGraceExpired,
      });

      return buildRuntimeSnapshot({
        runtime,
        status,
        observedAt,
        health: {
          ok: probe.healthOk,
          httpStatus: probe.httpStatus,
          detail: probe.detail,
        },
      });
    });

    this.snapshot = buildClusterState({
      node: primaryNode(this.registry.nodes, this.registry.runtimes),
      snapshots,
      generatedAt: observedAt,
    });
    return this.snapshot;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
