import type { Registry } from "./registry";
import type {
  ClusterState,
  RouteDefinition,
  RuntimeDefinition,
  RuntimeSnapshot,
} from "./schema";

const LIVE_STATUSES = new Set(["HOT", "BUSY", "STARTING"]);

export type RouteSelectionMode = "default" | "explicit";
export type RouteSelectionReason =
  | "primary-live"
  | "primary-startable"
  | "fallback-live"
  | "fallback-startable";

export type RouteSelectionFailure =
  | "unknown_route"
  | "unsupported_capability"
  | "explicit_route_required"
  | "fallback_not_allowed"
  | "no_candidate_available";

export type RouteSelectionResult =
  | {
      ok: true;
      route: string;
      capability: string;
      runtime: string;
      node: string;
      endpoint: string;
      status: RuntimeSnapshot["status"];
      candidateRank: number;
      fallback: boolean;
      reason: RouteSelectionReason;
    }
  | {
      ok: false;
      route: string;
      capability: string;
      reason: RouteSelectionFailure;
    };

export type RouteShadowComparison = {
  capability: string;
  route: string;
  legacyRuntime?: string;
  routeRuntime?: string;
  legacyOutcome: string;
  routeOutcome: string;
  matches: boolean;
};

type CandidateAvailability = "live" | "startable";

function availabilityOf(
  runtime: RuntimeDefinition,
  snapshot: RuntimeSnapshot | undefined,
): CandidateAvailability | undefined {
  if (!snapshot) {
    return undefined;
  }
  if (LIVE_STATUSES.has(snapshot.status)) {
    return "live";
  }
  if (snapshot.status === "COLD" && runtime.policy.class !== "resident") {
    return "startable";
  }
  return undefined;
}

export function findDefaultRoute(
  registry: Registry,
  capability: string,
): RouteDefinition | undefined {
  return registry.routes.find(
    (route) => !route.explicitOnly && route.capabilities.includes(capability),
  );
}

export function selectRoute(input: {
  registry: Registry;
  state: ClusterState;
  routeId: string;
  capability: string;
  mode: RouteSelectionMode;
  allowFallback: boolean;
}): RouteSelectionResult {
  const route = input.registry.routes.find((item) => item.id === input.routeId);
  if (!route) {
    return {
      ok: false,
      route: input.routeId,
      capability: input.capability,
      reason: "unknown_route",
    };
  }
  if (!route.capabilities.includes(input.capability)) {
    return {
      ok: false,
      route: route.id,
      capability: input.capability,
      reason: "unsupported_capability",
    };
  }
  if (route.explicitOnly && input.mode !== "explicit") {
    return {
      ok: false,
      route: route.id,
      capability: input.capability,
      reason: "explicit_route_required",
    };
  }

  let availableFallback = false;
  for (const [index, candidate] of route.candidates.entries()) {
    const runtime = input.registry.runtimes.find((item) => item.id === candidate.runtime);
    const snapshot = input.state.runtimes.find((item) => item.id === candidate.runtime);
    if (!runtime) {
      continue;
    }
    const availability = availabilityOf(runtime, snapshot);
    if (!availability) {
      continue;
    }
    if (candidate.purpose === "fallback" && !input.allowFallback) {
      availableFallback = true;
      continue;
    }

    const fallback = candidate.purpose === "fallback";
    const reason: RouteSelectionReason = fallback
      ? availability === "live"
        ? "fallback-live"
        : "fallback-startable"
      : availability === "live"
        ? "primary-live"
        : "primary-startable";
    return {
      ok: true,
      route: route.id,
      capability: input.capability,
      runtime: runtime.id,
      node: runtime.node,
      endpoint: runtime.deployment.endpoint,
      status: snapshot.status,
      candidateRank: index + 1,
      fallback,
      reason,
    };
  }

  return {
    ok: false,
    route: route.id,
    capability: input.capability,
    reason: availableFallback ? "fallback_not_allowed" : "no_candidate_available",
  };
}

export function compareRouteSelection(
  capability: string,
  route: RouteDefinition,
  legacy:
    | { ok: true; runtime: string }
    | { ok: false; reason: string },
  selected: RouteSelectionResult,
): RouteShadowComparison {
  const legacyRuntime = legacy.ok ? legacy.runtime : undefined;
  const routeRuntime = selected.ok ? selected.runtime : undefined;
  return {
    capability,
    route: route.id,
    legacyRuntime,
    routeRuntime,
    legacyOutcome: legacy.ok ? `runtime:${legacy.runtime}` : `error:${legacy.reason}`,
    routeOutcome: selected.ok ? `runtime:${selected.runtime}` : `error:${selected.reason}`,
    matches: legacyRuntime !== undefined
      ? legacyRuntime === routeRuntime
      : !selected.ok,
  };
}
