import {
  buildClusterState,
  buildRuntimeSnapshot,
  deriveStatus,
  isStartingCondition,
  primaryNode,
  type ClusterState,
  type NodeTelemetry,
  type Registry,
} from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import type { NodeTelemetryProvider } from "@larm/backends";

export type ObserverOptions = {
  graceMs?: number;
  now?: () => number;
  telemetry?: NodeTelemetryProvider;
  telemetryTimeoutMs?: number;
  onTelemetry?: (telemetry: ClusterState["node"]["telemetry"]) => void;
};

export class Observer {
  private readonly startingSince = new Map<string, number>();
  private snapshot: ClusterState;
  private tickInFlight: Promise<ClusterState> | undefined;

  constructor(
    private registry: Registry,
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

  async replaceRegistry(registry: Registry): Promise<ClusterState> {
    if (this.tickInFlight) {
      await this.tickInFlight;
    }
    this.registry = registry;
    const runtimeIds = new Set(registry.runtimes.map((runtime) => runtime.id));
    for (const runtimeId of this.startingSince.keys()) {
      if (!runtimeIds.has(runtimeId)) {
        this.startingSince.delete(runtimeId);
      }
    }
    return await this.tick();
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
    const [probes, telemetry] = await Promise.all([
      this.backend.list(),
      this.observeTelemetry(now),
    ]);
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
      telemetry,
    });
    this.options.onTelemetry?.(telemetry);
    return this.snapshot;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async observeTelemetry(now: number): Promise<NodeTelemetry | undefined> {
    const provider = this.options.telemetry;
    if (!provider) return undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        provider.observe(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("resource telemetry timed out")),
            this.options.telemetryTimeoutMs ?? 1_000,
          );
          timeout.unref?.();
        }),
      ]);
    } catch (error) {
      return {
        status: "unavailable",
        observedAt: new Date(now).toISOString(),
        source: "observer",
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 512),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
