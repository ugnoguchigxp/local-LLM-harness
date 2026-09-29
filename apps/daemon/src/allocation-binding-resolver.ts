import {
  compileProviderRevision,
  getRuntime,
  selectRoute,
  type AllocationBinding,
  type AllocationRequest,
  type ClusterState,
  type Registry,
  type RuntimeReleaseDefinition,
} from "@larm/core";

export type AllocationBindingResolution =
  | { ok: true; bindings: AllocationBinding[]; capabilities: string[] }
  | {
    ok: false;
    result: {
      status: 400 | 404 | 409 | 503;
      body: { error: { code: string; message: string } };
    };
  };

export function resolveAllocationBindings(input: {
  registry: Registry;
  state: ClusterState;
  request: AllocationRequest;
  getRuntimeRelease?: (runtimeId: string) => string | undefined;
  getRuntimeReleaseDefinition?: (runtimeId: string) => RuntimeReleaseDefinition | undefined;
  onRejected?: (reason: string, route: string) => void;
}): AllocationBindingResolution {
  const capabilities = new Set<string>();
  const bindings: AllocationBinding[] = [];
  for (const requirement of input.request.requirements) {
    if (capabilities.has(requirement.capability)) {
      return {
        ok: false,
        result: {
          status: 400,
          body: {
            error: {
              code: "duplicate_capability",
              message: `capability ${requirement.capability} is requested more than once`,
            },
          },
        },
      };
    }
    capabilities.add(requirement.capability);
    const selected = selectRoute({
      registry: input.registry,
      state: input.state,
      routeId: requirement.route,
      capability: requirement.capability,
      mode: "explicit",
      allowFallback: input.request.allowFallback,
    });
    if (!selected.ok) {
      const notFound = selected.reason === "unknown_route" || selected.reason === "unsupported_capability";
      const unavailable = selected.reason === "no_candidate_available";
      input.onRejected?.(selected.reason, requirement.route);
      return {
        ok: false,
        result: {
          status: notFound ? 404 : unavailable ? 503 : 409,
          body: {
            error: {
              code: selected.reason,
              message: `route ${requirement.route} cannot provide ${requirement.capability}: ${selected.reason}`,
            },
          },
        },
      };
    }
    const runtime = getRuntime(input.registry, selected.runtime);
    const releaseDefinition = input.getRuntimeReleaseDefinition?.(selected.runtime);
    bindings.push({
      capability: selected.capability,
      route: selected.route,
      runtime: selected.runtime,
      node: selected.node,
      endpoint: selected.endpoint,
      status: selected.status,
      candidateRank: selected.candidateRank,
      fallback: selected.fallback,
      selectionReason: selected.reason,
      release: input.getRuntimeRelease?.(selected.runtime),
      providerRevision: runtime
        ? compileProviderRevision(releaseDefinition
          ? { runtime, release: releaseDefinition }
          : {
            runtime,
            runtimeRelease: input.getRuntimeRelease?.(selected.runtime),
          }).revision
        : undefined,
    });
  }
  return { ok: true, bindings, capabilities: [...capabilities] };
}
