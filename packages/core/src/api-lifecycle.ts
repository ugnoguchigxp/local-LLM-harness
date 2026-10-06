export type ApiLifecycleClass = "current" | "compatibility" | "management";

export function apiOperationLifecycle(
  path: string,
  operationId: string,
): { classification: ApiLifecycleClass; successor?: string } {
  if (
    path.startsWith("/v1/management/local-services/")
    || path.startsWith("/v1/artifacts/")
    || path.startsWith("/v1/artifact-operations/")
    || path.startsWith("/v1/runtime-releases")
    || path.startsWith("/v1/deployments/")
    || path.startsWith("/v1/inspection/")
  ) return { classification: "management" };

  const successors: Record<string, string> = {
    listAgentProfilesV1: "GET /v3/agent-profiles",
    listAgentProfiles: "GET /v3/agent-profiles",
    getLegacyOperation: "GET /v1/operations/{id}",
    prepareLegacyLease: "POST /v1/agent-connections",
    releaseLegacyLease: "DELETE /v1/agent-connections/{id}",
    resolveLegacyLease: "POST /v1/allocations/{id}/resolve",
  };
  const successor = successors[operationId];
  return successor
    ? { classification: "compatibility", successor }
    : { classification: "current" };
}

export type ApiOperationOwner =
  | "local-services"
  | "health"
  | "service-activity"
  | "telemetry"
  | "api-contract"
  | "operator-inspection"
  | "allocation"
  | "managed-context"
  | "personal-state"
  | "agent-connection"
  | "service-harness"
  | "inference-gateway"
  | "music"
  | "image-artifact"
  | "release-management";

export type ApiOperationAuthority =
  | "local-service-bearer"
  | "management-bearer"
  | "public"
  | "api-bearer"
  | "optional-api-bearer"
  | "configurable-api-bearer"
  | "provider-bearer"
  | "api-or-provider-bearer"
  | "api-and-management-bearer";

type ApiOperationGovernanceBase = {
  audience: "public" | "agent" | "advanced" | "management";
  authority: ApiOperationAuthority;
  stability: "stable" | "experimental";
};

export type ApiOperationGovernance = ApiOperationGovernanceBase & (
  | { compatibility: "canonical"; lifecycle: "active"; successor?: never }
  | { compatibility: "compatibility"; lifecycle: "deprecated"; successor: string }
);

/** Independent policy axes for API evolution; the old lifecycle class stays as a compatibility export. */
export function apiOperationGovernance(path: string, operationId: string): ApiOperationGovernance {
  const policy = apiOperationPolicy(path, operationId);
  const legacy = apiOperationLifecycle(path, operationId);
  const compatibility = legacy.classification === "compatibility";
  const audience: ApiOperationGovernanceBase["audience"] = (policy.authority === "api-and-management-bearer" || policy.authority === "management-bearer")
    ? "management"
    : policy.owner === "allocation"
    ? "advanced"
    : policy.owner === "inference-gateway" || policy.owner === "health"
      || policy.owner === "service-harness" || policy.owner === "api-contract"
    ? "public"
    : "agent";
  const base = {
    audience,
    authority: policy.authority,
    stability: "stable" as const,
  };
  if (compatibility) {
    if (!legacy.successor) throw new Error(`compatibility operation has no successor: ${operationId}`);
    return { ...base, compatibility: "compatibility", lifecycle: "deprecated", successor: legacy.successor };
  }
  return { ...base, compatibility: "canonical", lifecycle: "active" };
}

export function apiOperationPolicy(
  path: string,
  operationId: string,
): {
  owner: ApiOperationOwner;
  consumers: readonly string[];
  authority: ApiOperationAuthority;
} {
  let owner: ApiOperationOwner;
  if (/^\/v1\/(local-services|local-service-leases|management\/local-services)/.test(path)) owner = "local-services";
  else if (path === "/health" || path === "/ready" || path === "/v1/release-convergence") owner = "health";
  else if (path === "/v1/activity") owner = "service-activity";
  else if (path === "/metrics") owner = "telemetry";
  else if (path === "/openapi.json") owner = "api-contract";
  else if (path.startsWith("/v1/inspection/")) owner = "operator-inspection";
  else if (path.startsWith("/v1/agent-profiles") || path.startsWith("/v1/agent-connections")
    || path.startsWith("/v2/agent-profiles") || path.startsWith("/v3/agent-profiles")) {
    owner = "agent-connection";
  } else if (path.startsWith("/v1/services")) owner = "service-harness";
  else if (path.startsWith("/v1/contexts") || path.startsWith("/v1/context-status")
    || path.startsWith("/v1/context-views") || path.startsWith("/v1/context-operations")) {
    owner = "managed-context";
  } else if (path.startsWith("/v1/personal-state/") || path.startsWith("/v1/context-sources")
    || path.startsWith("/v1/context-source-operations") || path.startsWith("/v1/context-measurements")
    || path.startsWith("/v2/context-views") || path.startsWith("/v1/generation-attempts")
    || path.startsWith("/v1/context-forget-operations")) {
    owner = "personal-state";
  } else if (path.startsWith("/v1/music/")) owner = "music";
  else if (path.startsWith("/v1/image-artifacts") || path === "/v1/images/generations") owner = "image-artifact";
  else if (path.startsWith("/v1/artifacts/") || path.startsWith("/v1/artifact-operations/")
    || path.startsWith("/v1/runtime-releases") || path.startsWith("/v1/deployments/")) {
    owner = "release-management";
  } else if (path.startsWith("/v1/chat/") || path.startsWith("/v1/audio/")
    || path.startsWith("/v1/embed") || path.startsWith("/v1/systemone") || path === "/v1/models") {
    owner = "inference-gateway";
  } else if (path.startsWith("/v1/allocations/") || path === "/v1/allocations"
    || path === "/prepare" || path === "/resolve" || path === "/release"
    || path === "/operations/{id}" || path === "/v1/operations/{id}"
    || path === "/runtimes" || path === "/runtimes/{id}" || path === "/state") {
    owner = "allocation";
  } else {
    throw new Error(`API operation has no owner policy: ${operationId} ${path}`);
  }

  const lifecycle = apiOperationLifecycle(path, operationId);
  const authority: ApiOperationAuthority = owner === "local-services"
    ? path.startsWith("/v1/management/") ? "management-bearer" : "local-service-bearer"
    : lifecycle.classification === "management"
    ? "api-and-management-bearer"
    : operationId === "getHealth" || operationId === "getReadiness"
    ? "public"
    : [
      "listAgentProfilesV1", "listAgentProfiles", "listAgentProfilesV3", "getServiceActivity",
      "createAgentConnection", "getAgentConnection", "getAgentConnectionHealth", "claimAgentConnection",
      "renewAgentConnection", "releaseAgentConnection",
    ].includes(operationId)
    ? "optional-api-bearer"
    : ["listServices", "getAsrServiceHealth", "createTranscription"].includes(operationId)
    ? "configurable-api-bearer"
    : [
      "createEmbedding", "getPersonalStateCapability", "provisionContextSource", "getContextSourceOperation",
      "createContextMeasurement", "getContextMeasurement", "createContextViewV2", "getContextViewV2",
      "getGenerationAttempt", "cancelGenerationAttempt", "createContextForgetOperation", "getContextForgetOperation",
    ].includes(operationId)
    ? "provider-bearer"
    : [
      "getAgentProviderHealth", "createChatCompletion", "createTranscription", "createSpeech", "createContext",
    ].includes(operationId)
    ? "api-or-provider-bearer"
    : "api-bearer";

  const consumers: Readonly<Record<ApiOperationOwner, readonly string[]>> = {
    "local-services": ["local-service-consumer", "operator"],
    health: ["operator", "service-monitor"],
    "service-activity": ["daemon-consumer", "service-monitor"],
    telemetry: ["operator", "monitoring"],
    "api-contract": ["api-consumer", "operator"],
    "operator-inspection": ["operator"],
    allocation: ["advanced-consumer", "agent-consumer", "operator"],
    "managed-context": ["agent-consumer", "operator"],
    "personal-state": ["agent-provider", "operator"],
    "agent-connection": ["agent-consumer"],
    "service-harness": ["service-harness-consumer"],
    "inference-gateway": ["openai-compatible-consumer"],
    music: ["music-consumer", "operator"],
    "image-artifact": ["agent-consumer", "operator"],
    "release-management": ["operator"],
  };
  return { owner, consumers: consumers[owner], authority };
}

export function compatibilityApiOperation(method: string, requestPath: string): string | undefined {
  const normalizedMethod = method.toLowerCase();
  const compatibilityRoutes: ReadonlyArray<readonly [string, RegExp, string]> = [
    ["get", /^\/v1\/agent-profiles$/, "listAgentProfilesV1"],
    ["get", /^\/v2\/agent-profiles$/, "listAgentProfiles"],
    ["get", /^\/operations\/[^/]+$/, "getLegacyOperation"],
    ["post", /^\/prepare$/, "prepareLegacyLease"],
    ["post", /^\/release$/, "releaseLegacyLease"],
    ["post", /^\/resolve$/, "resolveLegacyLease"],
  ];
  for (const [operationMethod, pattern, operationId] of compatibilityRoutes) {
    if (operationMethod === normalizedMethod && pattern.test(requestPath)) return operationId;
  }
  return undefined;
}
