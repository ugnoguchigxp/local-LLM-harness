import { getRuntime, type Allocation, type Registry, type RuntimeReleaseDefinition } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import type { Observer } from "./observer";
import type { ProviderInstanceManager } from "./provider-instance-manager";

export type AllocationRuntimeStartupResult = "ready" | "timed_out";

export async function startAndVerifyAllocationRuntimes(input: {
  allocation: Allocation;
  registry: Registry;
  backend: RuntimeBackend;
  observer: Pick<Observer, "getState" | "tick">;
  providerInstances: Pick<ProviderInstanceManager, "acquire">;
  deadline: number;
  signal: AbortSignal;
  isActive: () => boolean;
  ensureDeployment?: (
    runtimeId: string,
    allocationId: string,
    onPhase: (phase: string) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  runtimeRelease?: (runtimeId: string) => string | RuntimeReleaseDefinition | undefined;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  setPhase: (phase: string) => void;
}): Promise<AllocationRuntimeStartupResult> {
  const runtimeIds = [...new Set(input.allocation.bindings.map((binding) => binding.runtime))];
  for (const runtimeId of runtimeIds) {
    if (!input.isActive()) return "ready";
    if (input.allocation.deploymentPolicy === "allow-listed") {
      if (!input.ensureDeployment) {
        throw new Error("allow-listed deployment is not configured");
      }
      await input.ensureDeployment(
        runtimeId,
        input.allocation.id,
        input.setPhase,
        input.signal,
      );
      if (!input.isActive()) return "ready";
      if (input.signal.aborted) throw input.signal.reason;
    }
    const runtime = getRuntime(input.registry, runtimeId);
    if (!runtime) throw new Error(`runtime ${runtimeId} disappeared from registry`);
    const status = input.observer.getState().runtimes.find((item) => item.id === runtimeId)?.status;
    if (status === "COLD" || input.backend.ensureInstance) {
      input.setPhase("starting-runtime");
      const instance = await input.providerInstances.acquire(
        runtime,
        input.allocation.id,
        input.runtimeRelease?.(runtimeId),
        input.signal,
      );
      for (const binding of input.allocation.bindings) {
        if (binding.runtime !== runtimeId) continue;
        binding.providerRevision = instance.revision;
        binding.instanceId = instance.id;
        binding.instanceGeneration = instance.generation;
        binding.endpoint = instance.endpoint;
      }
    }
  }

  input.setPhase("verifying-runtime");
  while (input.isActive()) {
    const state = await input.observer.tick();
    for (const binding of input.allocation.bindings) {
      const snapshot = state.runtimes.find((item) => item.id === binding.runtime);
      if (snapshot) binding.status = snapshot.status;
    }
    if (input.allocation.bindings.every(
      (binding) => binding.status === "HOT" || binding.status === "BUSY",
    )) {
      input.setPhase("runtime-ready");
      return "ready";
    }
    if (input.allocation.bindings.some((binding) => binding.status === "FAILED")) {
      throw new Error("one or more allocated runtimes failed during startup");
    }
    if (input.now() >= input.deadline) return "timed_out";
    await input.sleep(input.pollIntervalMs);
  }
  return "ready";
}
