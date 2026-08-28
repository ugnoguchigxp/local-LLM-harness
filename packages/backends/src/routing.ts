import type { RuntimeDefinition } from "@larm/core";
import { isLlamaSwapRuntime } from "@larm/core";
import { LlamaSwapBackend, type LlamaSwapBackendOptions } from "./llama-swap";
import { SystemdBackend, type SystemdBackendOptions } from "./systemd";
import { LifecycleError, type RuntimeBackend, type RuntimeHealth } from "./types";

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
  constructor(private readonly routes: Map<string, RuntimeBackend>) {}

  async list(): Promise<RuntimeHealth[]> {
    const unique = [...new Set(this.routes.values())];
    const parts = await Promise.all(unique.map((backend) => backend.list()));
    return parts.flat();
  }

  async health(runtimeId: string): Promise<RuntimeHealth> {
    const backend = this.routes.get(runtimeId);
    if (!backend) {
      return missing(runtimeId);
    }
    return backend.health(runtimeId);
  }

  async ensure(runtime: RuntimeDefinition): Promise<RuntimeHealth> {
    const backend = this.routes.get(runtime.id);
    if (!backend) {
      throw new LifecycleError("start_failed", `runtime ${runtime.id} is not registered`);
    }
    return backend.ensure(runtime);
  }

  async stop(runtimeId: string): Promise<void> {
    const backend = this.routes.get(runtimeId);
    if (!backend) {
      throw new LifecycleError("stop_failed", `runtime ${runtimeId} is not registered`);
    }
    return backend.stop(runtimeId);
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
