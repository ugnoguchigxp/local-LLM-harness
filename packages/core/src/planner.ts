import type { Registry } from "./registry";
import type { ClusterState, RuntimeDefinition, RuntimeSnapshot, RuntimeStatus } from "./schema";
import { desiredCapabilities, residentCapabilitiesFrom, type Lease } from "./leases";

const LIVE: RuntimeStatus[] = ["HOT", "BUSY", "STARTING"];

export type TransitionPlan = {
  desired: string[];
  ensure: string[];
  stop: string[];
  uncovered: string[];
};

export function isControllable(runtime: RuntimeDefinition): boolean {
  return runtime.policy.class !== "resident";
}

export function providersOf(registry: Registry, capability: string): RuntimeDefinition[] {
  return registry.runtimes.filter((runtime) => runtime.capability.includes(capability));
}

function snapshotOf(state: ClusterState, id: string): RuntimeSnapshot | undefined {
  return state.runtimes.find((runtime) => runtime.id === id);
}

function isLive(state: ClusterState, id: string): boolean {
  const status = snapshotOf(state, id)?.status;
  return status !== undefined && LIVE.includes(status);
}

function pickStartable(
  candidates: RuntimeDefinition[],
): RuntimeDefinition | undefined {
  const startable = candidates.filter(isControllable);
  startable.sort((a, b) => {
    const classRank = (cls: string) => (cls === "preferred" ? 0 : 1);
    const byClass = classRank(a.policy.class) - classRank(b.policy.class);
    if (byClass !== 0) {
      return byClass;
    }
    return a.id.localeCompare(b.id);
  });
  return startable[0];
}

export function planTransition(input: {
  registry: Registry;
  state: ClusterState;
  leases: Lease[];
}): TransitionPlan {
  const requested = desiredCapabilities([], input.leases);
  const keep = desiredCapabilities(
    residentCapabilitiesFrom(input.registry.runtimes),
    input.leases,
  );
  const ensure: string[] = [];
  const uncovered: string[] = [];

  for (const capability of requested) {
    const providers = providersOf(input.registry, capability);
    if (providers.length === 0) {
      uncovered.push(capability);
      continue;
    }
    if (providers.some((runtime) => isLive(input.state, runtime.id))) {
      continue;
    }
    const start = pickStartable(providers);
    if (!start) {
      uncovered.push(capability);
      continue;
    }
    if (!ensure.includes(start.id)) {
      ensure.push(start.id);
    }
  }

  const stop: string[] = [];
  const leasesActive = input.leases.length > 0;
  if (!leasesActive) {
    for (const runtime of input.registry.runtimes) {
      if (!isControllable(runtime)) {
        continue;
      }
      if (!isLive(input.state, runtime.id) && snapshotOf(input.state, runtime.id)?.status !== "FAILED") {
        continue;
      }
      const uniquelyNeeded = runtime.capability.some((capability) => {
        if (!keep.includes(capability)) {
          return false;
        }
        const others = providersOf(input.registry, capability).filter((item) => item.id !== runtime.id);
        return !others.some((item) => isLive(input.state, item.id));
      });
      if (!uniquelyNeeded) {
        stop.push(runtime.id);
      }
    }
  }

  return { desired: keep, ensure, stop, uncovered };
}
