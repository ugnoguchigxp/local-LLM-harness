import {
  planTransition,
  resolveCapability,
  type ClusterState,
  type Lease,
  type Registry,
  type ResolveResult,
} from "@larm/core";

export type LegacyControlOperationsPort = {
  registry: Registry;
  isDraining: () => boolean;
  getState: () => ClusterState;
  hasFreshState: () => boolean;
  planningLeases: () => Lease[];
  getLease: (leaseId: string) => Lease | undefined;
  removeLease: (leaseId: string) => { lease: Lease | undefined; allocationId: string | undefined };
  cancelLeaseOperations: (leaseId: string) => void;
  releaseAllocation: (allocationId: string) => Promise<unknown>;
  scheduleIdleStop: (runtimeIds: string[]) => void;
  observeRouteShadow: (capability: string, result: ResolveResult) => void;
};

export class LegacyControlOperations {
  constructor(private readonly port: LegacyControlOperationsPort) {}

  async release(leaseId: string) {
    const p = this.port;
    const lease = p.getLease(leaseId);
    if (!lease) {
      return {
        status: 404 as const,
        body: { error: { code: "not_found", message: `lease ${leaseId} is not active` } },
      };
    }
    const removed = p.removeLease(leaseId);
    p.cancelLeaseOperations(leaseId);
    if (removed.allocationId) await p.releaseAllocation(removed.allocationId);
    const plan = planTransition({
      registry: p.registry,
      state: p.getState(),
      leases: p.planningLeases(),
    });
    if (p.planningLeases().length === 0 && plan.stop.length > 0) {
      p.scheduleIdleStop(plan.stop);
    }
    return {
      status: 200 as const,
      body: { released: true, leaseId, desired: plan.desired },
    };
  }

  resolve(capability: string) {
    const p = this.port;
    if (p.isDraining()) {
      return {
        status: 503 as const,
        body: { error: { code: "draining", message: "control plane is draining" } },
      };
    }
    const result = resolveCapability(p.registry, p.getState(), capability);
    if (!result.ok && result.reason === "unknown_capability") {
      return {
        status: 404 as const,
        body: { error: { code: "not_found", message: `capability ${capability} is not in the registry` } },
      };
    }
    if (!p.hasFreshState()) {
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
    p.observeRouteShadow(capability, result);
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
}
