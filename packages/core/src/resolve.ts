import type { ClusterState, Registry, RuntimeSnapshot } from "./schema";
import { providersOf } from "./planner";

const RANK: Record<string, number> = {
  HOT: 0,
  BUSY: 1,
};

export type ResolveResult =
  | {
      ok: true;
      runtime: string;
      node: string;
      endpoint: string;
      status: "HOT" | "BUSY";
    }
  | { ok: false; reason: "unknown_capability" | "not_ready" };

export function resolveCapability(
  registry: Registry,
  state: ClusterState,
  capability: string,
): ResolveResult {
  const providers = providersOf(registry, capability);
  if (providers.length === 0) {
    return { ok: false, reason: "unknown_capability" };
  }

  const live: RuntimeSnapshot[] = [];
  for (const provider of providers) {
    const snapshot = state.runtimes.find((item) => item.id === provider.id);
    if (snapshot && (snapshot.status === "HOT" || snapshot.status === "BUSY")) {
      live.push(snapshot);
    }
  }

  live.sort((a, b) => {
    const byStatus = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9);
    if (byStatus !== 0) {
      return byStatus;
    }
    const classRank = (cls: string) => (cls === "resident" ? 0 : 1);
    const byClass = classRank(a.class) - classRank(b.class);
    if (byClass !== 0) {
      return byClass;
    }
    return a.id.localeCompare(b.id);
  });

  const winner = live[0];
  if (!winner) {
    return { ok: false, reason: "not_ready" };
  }
  return {
    ok: true,
    runtime: winner.id,
    node: winner.node,
    endpoint: winner.endpoint,
    status: winner.status === "BUSY" ? "BUSY" : "HOT",
  };
}
