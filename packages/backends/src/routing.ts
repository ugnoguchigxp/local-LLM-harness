import type { ProviderInstance, ProviderRevision, RuntimeDefinition } from "@larm/core";
import { isLlamaSwapRuntime } from "@larm/core";
import { LlamaSwapBackend, type LlamaSwapBackendOptions } from "./llama-swap";
import { SystemdBackend, type SystemdBackendOptions } from "./systemd";
import {
  LifecycleError,
  type ProviderInstanceHealth,
  type RuntimeBackend,
  type RuntimeHealth,
} from "./types";

export type CreateRuntimeBackendOptions = {
  llamaSwap?: LlamaSwapBackendOptions;
  systemd?: SystemdBackendOptions;
};

const missing = (runtimeId: string): RuntimeHealth => ({
  runtimeId,
  service: "NotFound",
  listening: false,
  healthOk: false,
  busy: false,
  detail: "runtime is not registered with this backend",
});

export class RoutingBackend implements RuntimeBackend {
  private readonly instanceRoutes = new Map<string, RuntimeBackend>();

  constructor(private readonly routes: Map<string, RuntimeBackend>) {}

  async list(): Promise<RuntimeHealth[]> {
    const groups = new Map<RuntimeBackend, string[]>();
    for (const [runtimeId, backend] of this.routes) {
      const ids = groups.get(backend) ?? [];
      ids.push(runtimeId);
      groups.set(backend, ids);
    }
    const parts = await Promise.all([...groups].map(async ([backend, runtimeIds]) => {
      try {
        return await backend.list();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return runtimeIds.map((runtimeId): RuntimeHealth => ({
          runtimeId,
          service: "Unknown",
          listening: false,
          healthOk: false,
          busy: false,
          detail: `backend observation failed: ${detail}`,
        }));
      }
    }));
    return parts.flat();
  }

  async health(runtimeId: string): Promise<RuntimeHealth> {
    const backend = this.routes.get(runtimeId);
    if (!backend) {
      return missing(runtimeId);
    }
    return backend.health(runtimeId);
  }

  async ensure(runtime: RuntimeDefinition, signal?: AbortSignal): Promise<RuntimeHealth> {
    const backend = this.routes.get(runtime.id);
    if (!backend) {
      throw new LifecycleError("start_failed", `runtime ${runtime.id} is not registered`);
    }
    return backend.ensure(runtime, signal);
  }

  async stop(runtimeId: string): Promise<void> {
    const backend = this.routes.get(runtimeId);
    if (!backend) {
      throw new LifecycleError("stop_failed", `runtime ${runtimeId} is not registered`);
    }
    return backend.stop(runtimeId);
  }

  async listInstances(): Promise<ProviderInstanceHealth[]> {
    const unique = [...new Set(this.routes.values())];
    const nested = await Promise.all(unique.map((backend) => backend.listInstances?.() ?? []));
    for (let index = 0; index < unique.length; index += 1) {
      for (const instance of nested[index] ?? []) {
        this.instanceRoutes.set(instance.id, unique[index]!);
      }
    }
    return nested.flat();
  }

  async ensureInstance(
    revision: ProviderRevision,
    runtime: RuntimeDefinition,
    signal?: AbortSignal,
  ): Promise<ProviderInstance> {
    const backend = this.routes.get(revision.runtimeId);
    if (!backend?.ensureInstance) {
      throw new LifecycleError("start_failed", `runtime ${revision.runtimeId} has no instance backend`);
    }
    const instance = await backend.ensureInstance(revision, runtime, signal);
    this.instanceRoutes.set(instance.id, backend);
    return instance;
  }

  async healthInstance(instanceId: string): Promise<ProviderInstanceHealth> {
    const backend = this.instanceRoutes.get(instanceId);
    if (!backend?.healthInstance) {
      throw new LifecycleError("access_denied", `provider instance ${instanceId} is unknown`);
    }
    return backend.healthInstance(instanceId);
  }

  async drainInstance(instanceId: string, signal?: AbortSignal): Promise<void> {
    const backend = this.instanceRoutes.get(instanceId);
    if (!backend?.drainInstance) {
      throw new LifecycleError("access_denied", `provider instance ${instanceId} is unknown`);
    }
    await backend.drainInstance(instanceId, signal);
  }

  async stopInstance(instanceId: string): Promise<void> {
    const backend = this.instanceRoutes.get(instanceId);
    if (!backend?.stopInstance) return;
    await backend.stopInstance(instanceId);
    this.instanceRoutes.delete(instanceId);
  }
}

export function createRuntimeBackend(
  runtimes: RuntimeDefinition[],
  options: CreateRuntimeBackendOptions = {},
): RuntimeBackend {
  const llamaSwap = new LlamaSwapBackend(runtimes, options.llamaSwap);
  const systemd = new SystemdBackend(runtimes, options.systemd);
  const routes = new Map<string, RuntimeBackend>();
  for (const runtime of runtimes) {
    routes.set(runtime.id, isLlamaSwapRuntime(runtime) ? llamaSwap : systemd);
  }
  return new RoutingBackend(routes);
}
