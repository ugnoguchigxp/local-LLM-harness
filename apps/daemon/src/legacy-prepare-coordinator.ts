import {
  activeAllocation,
  expandPrepareRequest,
  findDefaultRoute,
  planTransition,
  type Allocation,
  type AllocationRequest,
  type ClusterState,
  type Lease,
  type PrepareRequest,
  type Registry,
} from "@larm/core";
import type { Operation } from "./controller";

export type LegacyPrepareCoordinatorPort = {
  registry: Registry;
  isDraining: () => boolean;
  allocate: (request: AllocationRequest) => Promise<
    | { status: 200 | 202; body: Allocation }
    | { status: 400 | 404 | 409 | 503; body: { error: { code: string; message: string } } }
  >;
  hasFreshState: () => boolean;
  getState: () => ClusterState;
  planningLeases: () => Lease[];
  activeAdmissionCount: () => number;
  maxActiveAllocations: () => number;
  createLeaseId: () => string;
  addLease: (lease: Lease, allocationId?: string) => void;
  attachLeaseToOperation: (allocation: Allocation, leaseId: string) => void;
  cancelIdle: () => void;
  createOperationId: () => string;
  storeAndRunOperation: (operation: Operation) => void;
  pruneHistory: () => void;
  isoNow: () => string;
};

export class LegacyPrepareCoordinator {
  constructor(private readonly port: LegacyPrepareCoordinatorPort) {}

  async prepare(request: PrepareRequest) {
    const p = this.port;
    if (p.isDraining()) {
      return {
        status: 503 as const,
        body: { error: { code: "draining", message: "control plane is draining" } },
      };
    }
    const expanded = expandPrepareRequest(p.registry, request);
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
      route: findDefaultRoute(p.registry, capability)?.id,
    }));
    if (requirements.every(
      (requirement): requirement is { capability: string; route: string } => Boolean(requirement.route),
    )) {
      const allocated = await p.allocate({
        requirements,
        client: request.client,
        allowFallback: true,
        ttlSeconds: 86_400,
        deploymentPolicy: "existing-only",
        priority: 0,
        capacityPolicy: "reject",
      });
      if (allocated.status !== 200 && allocated.status !== 202) return allocated;
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
        id: p.createLeaseId(),
        client: request.client,
        capabilities: expanded.capabilities,
        profile: expanded.profile,
        createdAt: p.isoNow(),
      };
      p.addLease(lease, allocation.id);
      p.attachLeaseToOperation(allocation, lease.id);
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
    const trial = planTransition({
      registry: p.registry,
      state: p.getState(),
      leases: [
        ...p.planningLeases(),
        { id: "trial", capabilities: expanded.capabilities, createdAt: p.isoNow() },
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

    const activeLimit = p.maxActiveAllocations();
    if (p.activeAdmissionCount() >= activeLimit) {
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

    p.cancelIdle();
    const lease: Lease = {
      id: p.createLeaseId(),
      client: request.client,
      capabilities: expanded.capabilities,
      profile: expanded.profile,
      createdAt: p.isoNow(),
    };
    p.addLease(lease);
    const plan = planTransition({
      registry: p.registry,
      state: p.getState(),
      leases: p.planningLeases(),
    });
    const covering = p.getState().runtimes
      .filter((runtime) => runtime.status === "HOT" || runtime.status === "BUSY")
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
      id: p.createOperationId(),
      kind: "prepare",
      leaseId: lease.id,
      status: "pending",
      ready: false,
      desired: plan.desired,
      ensure: plan.ensure,
      createdAt: p.isoNow(),
    };
    p.storeAndRunOperation(operation);
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
}
