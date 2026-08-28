import {
  createLeaseId,
  compareRouteSelection,
  expandPrepareRequest,
  findDefaultRoute,
  getRuntime,
  planTransition,
  prepareRequestSchema,
  resolveCapability,
  selectRoute,
  type Lease,
  type PrepareRequest,
  type Registry,
  type ResolveResult,
  type RouteShadowComparison,
} from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { LifecycleError } from "@larm/backends";
import type { Observer } from "./observer";

export type Operation = {
  id: string;
  leaseId: string;
  status: "pending" | "running" | "succeeded" | "failed";
  ready: boolean;
  desired: string[];
  ensure: string[];
  error?: { code: string; message: string };
};

export type ControlPlaneOptions = {
  idleTtlMs?: number;
  now?: () => number;
  random?: () => string;
  onRouteShadowComparison?: (comparison: RouteShadowComparison) => void;
};

export class ControlPlane {
  private readonly leases = new Map<string, Lease>();
  private readonly operations = new Map<string, Operation>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private applyChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly registry: Registry,
    private readonly backend: RuntimeBackend,
    private readonly observer: Observer,
    private readonly options: ControlPlaneOptions = {},
  ) {}

  getLeases(): Lease[] {
    return [...this.leases.values()];
  }

  getOperation(id: string): Operation | undefined {
    return this.operations.get(id);
  }

  async prepare(request: PrepareRequest) {
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

    const trial = planTransition({
      registry: this.registry,
      state: this.observer.getState(),
      leases: [
        ...this.leases.values(),
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

    this.cancelIdle();
    const lease: Lease = {
      id: createLeaseId(this.options.random),
      client: request.client,
      capabilities: expanded.capabilities,
      profile: expanded.profile,
      createdAt: this.isoNow(),
    };
    this.leases.set(lease.id, lease);

    const plan = planTransition({
      registry: this.registry,
      state: this.observer.getState(),
      leases: [...this.leases.values()],
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
      id: `op_${(this.options.random ?? (() => crypto.randomUUID()))()}`,
      leaseId: lease.id,
      status: "pending",
      ready: false,
      desired: plan.desired,
      ensure: plan.ensure,
    };
    this.operations.set(operation.id, operation);
    this.enqueue(() => this.runEnsure(operation));

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
    const plan = planTransition({
      registry: this.registry,
      state: this.observer.getState(),
      leases: [...this.leases.values()],
    });

    if (this.leases.size === 0 && plan.stop.length > 0) {
      const ttl = this.options.idleTtlMs ?? 60_000;
      if (ttl <= 0) {
        this.enqueue(() => this.runStop(plan.stop));
      } else {
        this.cancelIdle();
        this.idleTimer = setTimeout(() => {
          this.enqueue(() => this.runStop(plan.stop));
        }, ttl);
      }
    }

    return {
      status: 200 as const,
      body: { released: true, leaseId, desired: plan.desired },
    };
  }

  resolve(capability: string) {
    const result = resolveCapability(this.registry, this.observer.getState(), capability);
    this.observeRouteShadow(capability, result);
    if (!result.ok && result.reason === "unknown_capability") {
      return {
        status: 404 as const,
        body: { error: { code: "not_found", message: `capability ${capability} is not in the registry` } },
      };
    }
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
    await this.applyChain;
  }

  private enqueue(work: () => Promise<void>): void {
    this.applyChain = this.applyChain.then(work).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`control plane task failed: ${message}`);
    });
  }

  private async runEnsure(operation: Operation): Promise<void> {
    operation.status = "running";
    try {
      for (const runtimeId of operation.ensure) {
        const runtime = getRuntime(this.registry, runtimeId);
        if (!runtime) {
          throw new Error(`runtime ${runtimeId} disappeared from registry`);
        }
        await this.backend.ensure(runtime);
        await this.observer.tick();
      }
      operation.status = "succeeded";
      operation.ready = true;
    } catch (err) {
      operation.status = "failed";
      operation.ready = false;
      if (err instanceof LifecycleError) {
        operation.error = { code: err.code, message: err.message };
      } else {
        operation.error = {
          code: "start_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  private async runStop(ids: string[]): Promise<void> {
    await this.observer.tick();
    const plan = planTransition({
      registry: this.registry,
      state: this.observer.getState(),
      leases: [...this.leases.values()],
    });
    const targets = ids.filter((id) => plan.stop.includes(id));
    for (const runtimeId of targets) {
      try {
        await this.backend.stop(runtimeId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`stop ${runtimeId} failed: ${message}`);
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
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }
}
