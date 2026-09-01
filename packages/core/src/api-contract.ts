import { z } from "zod";
import {
  allocationBindingSchema,
  allocationStatusSchema,
} from "./allocation";
import {
  allocationRequirementSchema,
  allocationRenewRequestSchema,
  allocationRequestSchema,
  allocationResolveRequestSchema,
  deploymentPolicySchema,
  prepareRequestSchema,
  releaseRequestSchema,
  resolveRequestSchema,
} from "./api-schema";
import { runtimeReleaseDefinitionSchema } from "./releases";
import {
  agentConnectionClaimRequestSchema,
  agentConnectionClaimSchema,
  agentConnectionHealthSchema,
  agentConnectionRenewRequestSchema,
  agentConnectionRequestSchema,
  agentProviderHealthSchema,
  publicAgentConnectionSchema,
  publicAgentProfileListSchema,
} from "./agent-connection";
import {
  clusterStateSchema,
  runtimeClassSchema,
  runtimeDefinitionSchema,
  runtimeProtocolSchema,
  runtimeStatusSchema,
} from "./schema";

const identifierSchema = z.string().min(1).max(192);

export const errorDetailSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1),
  blockers: z.array(z.string().min(1)).optional(),
  admission: z.array(z.object({
    node: z.string().min(1),
    usableMemoryGB: z.number(),
    committedMemoryGB: z.number(),
    incrementalMemoryGB: z.number(),
    availableMemoryGB: z.number(),
    liveAvailableMemoryGB: z.number().optional(),
    reclaimableMemoryGB: z.number().optional(),
  }).strict()).optional(),
}).strict();

export const publicRuntimeSchema = z.object({
  id: z.string().min(1).max(128),
  capability: z.array(z.string().min(1).max(128)).min(1).max(64),
  protocol: runtimeProtocolSchema,
  policy: z.object({ class: runtimeClassSchema }).strict(),
}).strict();

export const runtimeListSchema = z.object({
  runtimes: z.array(publicRuntimeSchema),
}).strict();

export const publicRuntimeSnapshotSchema = z.object({
  id: z.string().min(1).max(128),
  status: runtimeStatusSchema,
  class: runtimeClassSchema,
  capability: z.array(z.string().min(1).max(128)).min(1).max(64),
  observedAt: z.string().datetime(),
  health: z.object({ ok: z.boolean() }).strict().optional(),
}).strict();

export const publicClusterStateSchema = z.object({
  generatedAt: z.string().datetime(),
  online: z.boolean(),
  runtimes: z.array(publicRuntimeSnapshotSchema),
}).strict();

export const inspectionRuntimeListSchema = z.object({
  runtimes: z.array(runtimeDefinitionSchema),
}).strict();

export const errorResponseSchema = z.object({
  error: errorDetailSchema,
}).strict();

export const daemonHealthSchema = z.object({
  status: z.literal("ok"),
  version: z.string().min(1),
  releaseCommit: z.union([z.string().regex(/^[a-f0-9]{40}$/), z.literal("development")]),
  configRevision: z.string().min(1),
  bootEpoch: z.string().min(1),
}).strict();

export const readinessSchema = z.union([
  z.object({ status: z.literal("ready") }).strict(),
  z.object({ status: z.literal("draining") }).strict(),
  z.object({ status: z.literal("reloading") }).strict(),
  z.object({ status: z.literal("stale"), ageMs: z.number() }).strict(),
]);

export const publicAllocationBindingSchema = allocationBindingSchema.omit({ endpoint: true });
export const publicAllocationSchema = z.object({
  id: z.string().min(1).max(192),
  bootEpoch: z.string().min(1).max(128),
  catalogRevision: z.string().min(1).max(128).optional(),
  client: z.string().min(1).max(128).optional(),
  status: allocationStatusSchema,
  requirements: z.array(allocationRequirementSchema).min(1).max(16),
  bindings: z.array(publicAllocationBindingSchema).min(1).max(16),
  allowFallback: z.boolean(),
  deploymentPolicy: deploymentPolicySchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  operationId: z.string().min(1).max(192).optional(),
  releasedAt: z.string().datetime().optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
}).strict();

export const allocationResolveResponseSchema = z.object({
  allocationId: identifierSchema,
  capability: z.string().min(1).max(128),
  route: z.string().min(1).max(128),
  runtime: z.string().min(1).max(128),
  node: z.string().min(1).max(128),
  endpoint: z.string().url(),
  status: z.enum(["HOT", "BUSY"]),
  expiresAt: z.string().datetime(),
}).strict();

export const legacyPrepareResponseSchema = z.object({
  leaseId: identifierSchema,
  operationId: identifierSchema.optional(),
  desired: z.array(z.string().min(1).max(128)),
  ready: z.boolean(),
  runtimes: z.array(z.string().min(1).max(128)),
}).strict();

export const legacyResolveResponseSchema = z.object({
  runtime: z.string().min(1).max(128),
  node: z.string().min(1).max(128),
  endpoint: z.string().url(),
  status: z.enum(["HOT", "BUSY"]),
}).strict();

export const legacyReleaseResponseSchema = z.object({
  released: z.literal(true),
  leaseId: identifierSchema,
  desired: z.array(z.string().min(1).max(128)),
}).strict();

export const metricsResponseSchema = z.string();
export const upstreamJsonResponseSchema = z.record(z.string(), z.unknown());
export const openApiDocumentSchema = z.object({
  openapi: z.literal("3.1.0"),
  info: z.object({ title: z.string().min(1), version: z.string().min(1) }).strict(),
  servers: z.array(z.object({ url: z.string().min(1) }).strict()),
  paths: z.record(z.string(), z.unknown()),
  components: z.object({
    securitySchemes: z.record(z.string(), z.unknown()),
    schemas: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict();

export const controlOperationSchema = z.object({
  id: identifierSchema,
  kind: z.enum(["prepare", "allocation", "artifact"]),
  leaseId: identifierSchema.optional(),
  allocationId: identifierSchema.optional(),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "timed_out"]),
  ready: z.boolean(),
  desired: z.array(z.string()),
  ensure: z.array(z.string()),
  createdAt: z.string().datetime(),
  deadlineAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  phase: z.string().optional(),
  error: errorDetailSchema.optional(),
}).strict();

export const artifactOperationSchema = z.object({
  id: identifierSchema,
  kind: z.enum(["stage", "activate", "rollback"]),
  artifactId: z.string().min(1).max(128).optional(),
  runtimeId: z.string().min(1).max(128).optional(),
  releaseId: z.string().min(1).max(128).optional(),
  status: z.enum(["pending", "running", "succeeded", "failed", "interrupted"]),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  error: errorDetailSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const publicRuntimeReleaseSchema = runtimeReleaseDefinitionSchema.extend({
  state: z.enum(["active", "previous", "staged", "available"]),
}).strict();

export const runtimeReleaseListSchema = z.object({
  releases: z.array(publicRuntimeReleaseSchema),
}).strict();

export const runtimeReleaseSelectionSchema = z.object({
  release: z.string().min(1).max(128),
  expectedActiveRelease: z.string().min(1).max(128).nullable(),
}).strict();

export const runtimeReleasePlanRequestSchema = z.object({
  release: z.string().min(1).max(128),
}).strict();

export const runtimeDeploymentSchema = z.object({
  runtime: z.string().min(1).max(128),
  activeRelease: z.string().min(1).max(128).nullable(),
  previousRelease: z.string().min(1).max(128).nullable(),
  desiredRelease: z.string().min(1).max(128),
  activeProviderConfigRevision: z.string().min(1).max(128).nullable(),
  previousProviderConfigRevision: z.string().min(1).max(128).nullable(),
  desiredProviderConfigRevision: z.string().min(1).max(128),
  catalogRevision: z.string().min(1),
  pendingRelease: z.string().min(1).max(128).optional(),
  stagedReleases: z.array(z.string().min(1).max(128)),
  health: z.object({
    status: z.string().min(1).max(32),
    ok: z.boolean().optional(),
    observedAt: z.string().datetime(),
  }).strict().optional(),
}).strict();

export const runtimeDeploymentPlanSchema = z.object({
  runtime: z.string().min(1).max(128),
  release: z.string().min(1).max(128),
  activeRelease: z.string().min(1).max(128).nullable(),
  artifacts: z.array(z.string().min(1).max(128)).min(1),
  providerConfigRevision: z.string().min(1).max(128),
  healthPath: z.string().min(1).startsWith("/"),
  runtimeStatus: runtimeStatusSchema.optional(),
  requiresStop: z.boolean(),
  staged: z.boolean(),
  rollbackAvailable: z.boolean(),
  disk: z.object({
    additionalBytesRequired: z.number().int().nonnegative(),
    checkedDuringStage: z.boolean(),
  }).strict(),
  allowed: z.boolean(),
  blockers: z.array(z.string().min(1)),
}).strict();

export const catalogReloadPlanSchema = z.object({
  currentRevision: z.string().min(1),
  candidateRevision: z.string().min(1),
  changed: z.boolean(),
  allowed: z.boolean(),
  blockers: z.array(z.string().min(1)),
  summary: z.object({
    nodes: z.number().int().nonnegative(),
    runtimes: z.number().int().nonnegative(),
    routes: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    releases: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const catalogReloadRequestSchema = z.object({
  expectedCurrentRevision: z.string().min(1),
  candidateRevision: z.string().min(1),
}).strict();

export type PublicAllocation = z.infer<typeof publicAllocationSchema>;
export type ControlOperation = z.infer<typeof controlOperationSchema>;
export type PublicRuntimeRelease = z.infer<typeof publicRuntimeReleaseSchema>;
export type RuntimeReleaseSelection = z.infer<typeof runtimeReleaseSelectionSchema>;
export type RuntimeReleasePlanRequest = z.infer<typeof runtimeReleasePlanRequestSchema>;
export type RuntimeDeployment = z.infer<typeof runtimeDeploymentSchema>;
export type RuntimeDeploymentPlan = z.infer<typeof runtimeDeploymentPlanSchema>;
export type CatalogReloadPlan = z.infer<typeof catalogReloadPlanSchema>;
export type CatalogReloadRequest = z.infer<typeof catalogReloadRequestSchema>;

export const API_OPERATIONS = [
  ["get", "/health", "getHealth"],
  ["get", "/ready", "getReadiness"],
  ["get", "/metrics", "getMetrics"],
  ["get", "/openapi.json", "getOpenApi"],
  ["get", "/runtimes", "listRuntimes"],
  ["get", "/runtimes/{id}", "getRuntime"],
  ["get", "/state", "getState"],
  ["get", "/v1/inspection/runtimes", "listInspectionRuntimes"],
  ["get", "/v1/inspection/runtimes/{id}", "getInspectionRuntime"],
  ["get", "/v1/inspection/state", "getInspectionState"],
  ["get", "/operations/{id}", "getLegacyOperation"],
  ["get", "/v1/operations/{id}", "getOperation"],
  ["post", "/v1/allocations", "createAllocation"],
  ["get", "/v1/allocations/{id}", "getAllocation"],
  ["post", "/v1/allocations/{id}/renew", "renewAllocation"],
  ["post", "/v1/allocations/{id}/resolve", "resolveAllocation"],
  ["delete", "/v1/allocations/{id}", "releaseAllocation"],
  ["get", "/v1/agent-profiles", "listAgentProfiles"],
  ["post", "/v1/agent-connections", "createAgentConnection"],
  ["get", "/v1/agent-connections/{id}", "getAgentConnection"],
  ["get", "/v1/agent-connections/{id}/health", "getAgentConnectionHealth"],
  ["get", "/v1/agent-connections/{id}/providers/{name}/health", "getAgentProviderHealth"],
  ["post", "/v1/agent-connections/{id}/claim", "claimAgentConnection"],
  ["post", "/v1/agent-connections/{id}/renew", "renewAgentConnection"],
  ["delete", "/v1/agent-connections/{id}", "releaseAgentConnection"],
  ["post", "/v1/chat/completions", "createChatCompletion"],
  ["get", "/v1/llm/stream", "upgradeLlmStream"],
  ["post", "/v1/audio/transcriptions", "createTranscription"],
  ["post", "/v1/audio/speech", "createSpeech"],
  ["get", "/v1/audio/voices", "listVoices"],
  ["get", "/v1/artifact-operations/{id}", "getArtifactOperation"],
  ["post", "/v1/artifacts/{id}/stage", "stageArtifact"],
  ["get", "/v1/runtime-releases", "listRuntimeReleases"],
  ["post", "/v1/runtime-releases/{id}/stage", "stageRuntimeRelease"],
  ["get", "/v1/deployments/{runtime}", "getRuntimeDeployment"],
  ["post", "/v1/deployments/{runtime}/plan", "planRuntimeDeployment"],
  ["post", "/v1/deployments/{runtime}/activate", "activateRuntimeDeployment"],
  ["post", "/v1/deployments/{runtime}/rollback", "rollbackRuntimeDeployment"],
  ["post", "/v1/catalog/reload/plan", "planCatalogReload"],
  ["post", "/v1/catalog/reload", "reloadCatalog"],
  ["post", "/prepare", "prepareLegacyLease"],
  ["post", "/resolve", "resolveLegacyLease"],
  ["post", "/release", "releaseLegacyLease"],
] as const;

type ApiOperationId = typeof API_OPERATIONS[number][2];

const SUCCESS_STATUSES_BY_OPERATION: Record<ApiOperationId, readonly string[]> = {
  getHealth: ["200"],
  getReadiness: ["200"],
  getMetrics: ["200"],
  getOpenApi: ["200"],
  listRuntimes: ["200"],
  getRuntime: ["200"],
  getState: ["200"],
  listInspectionRuntimes: ["200"],
  getInspectionRuntime: ["200"],
  getInspectionState: ["200"],
  getLegacyOperation: ["200"],
  getOperation: ["200"],
  createAllocation: ["200", "202"],
  getAllocation: ["200"],
  renewAllocation: ["200"],
  resolveAllocation: ["200"],
  releaseAllocation: ["200"],
  listAgentProfiles: ["200"],
  createAgentConnection: ["201", "202"],
  getAgentConnection: ["200"],
  getAgentConnectionHealth: ["200"],
  getAgentProviderHealth: ["200"],
  claimAgentConnection: ["200"],
  renewAgentConnection: ["200"],
  releaseAgentConnection: ["204"],
  createChatCompletion: ["200"],
  upgradeLlmStream: ["101"],
  createTranscription: ["200"],
  createSpeech: ["200"],
  listVoices: ["200"],
  getArtifactOperation: ["200"],
  stageArtifact: ["202"],
  listRuntimeReleases: ["200"],
  stageRuntimeRelease: ["202"],
  getRuntimeDeployment: ["200"],
  planRuntimeDeployment: ["200"],
  activateRuntimeDeployment: ["202"],
  rollbackRuntimeDeployment: ["202"],
  planCatalogReload: ["200"],
  reloadCatalog: ["200"],
  prepareLegacyLease: ["200", "202"],
  resolveLegacyLease: ["200"],
  releaseLegacyLease: ["200"],
};

const SUCCESS_SCHEMA_BY_OPERATION: Record<ApiOperationId, string> = {
  getHealth: "Health",
  getReadiness: "Readiness",
  getMetrics: "Metrics",
  getOpenApi: "OpenApiDocument",
  listRuntimes: "RuntimeList",
  getRuntime: "Runtime",
  getState: "PublicClusterState",
  listInspectionRuntimes: "InspectionRuntimeList",
  getInspectionRuntime: "InspectionRuntime",
  getInspectionState: "InspectionClusterState",
  getLegacyOperation: "ControlOperation",
  getOperation: "ControlOperation",
  createAllocation: "Allocation",
  getAllocation: "Allocation",
  renewAllocation: "Allocation",
  resolveAllocation: "AllocationResolveResponse",
  releaseAllocation: "Allocation",
  listAgentProfiles: "AgentProfileList",
  createAgentConnection: "AgentConnection",
  getAgentConnection: "AgentConnection",
  getAgentConnectionHealth: "AgentConnectionHealth",
  getAgentProviderHealth: "AgentProviderHealth",
  claimAgentConnection: "AgentConnectionClaim",
  renewAgentConnection: "AgentConnection",
  releaseAgentConnection: "AgentConnection",
  createChatCompletion: "UpstreamJson",
  upgradeLlmStream: "WebSocketUpgrade",
  createTranscription: "UpstreamJson",
  createSpeech: "Binary",
  listVoices: "UpstreamJson",
  getArtifactOperation: "ArtifactOperation",
  stageArtifact: "ArtifactOperation",
  listRuntimeReleases: "RuntimeReleaseList",
  stageRuntimeRelease: "ArtifactOperation",
  getRuntimeDeployment: "RuntimeDeployment",
  planRuntimeDeployment: "RuntimeDeploymentPlan",
  activateRuntimeDeployment: "ArtifactOperation",
  rollbackRuntimeDeployment: "ArtifactOperation",
  planCatalogReload: "CatalogReloadPlan",
  reloadCatalog: "CatalogReloadPlan",
  prepareLegacyLease: "LegacyPrepareResponse",
  resolveLegacyLease: "LegacyResolveResponse",
  releaseLegacyLease: "LegacyReleaseResponse",
};

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

export function createOpenApiDocument(version: string): Record<string, unknown> {
  const schemas = {
    ErrorResponse: jsonSchema(errorResponseSchema),
    Health: jsonSchema(daemonHealthSchema),
    Readiness: jsonSchema(readinessSchema),
    Runtime: jsonSchema(publicRuntimeSchema),
    RuntimeList: jsonSchema(runtimeListSchema),
    PublicClusterState: jsonSchema(publicClusterStateSchema),
    InspectionRuntime: jsonSchema(runtimeDefinitionSchema),
    InspectionRuntimeList: jsonSchema(inspectionRuntimeListSchema),
    InspectionClusterState: jsonSchema(clusterStateSchema),
    AllocationRequest: jsonSchema(allocationRequestSchema),
    Allocation: jsonSchema(publicAllocationSchema),
    AllocationRenewRequest: jsonSchema(allocationRenewRequestSchema),
    AllocationResolveRequest: jsonSchema(allocationResolveRequestSchema),
    AllocationResolveResponse: jsonSchema(allocationResolveResponseSchema),
    AgentConnectionRequest: jsonSchema(agentConnectionRequestSchema),
    AgentConnectionRenewRequest: jsonSchema(agentConnectionRenewRequestSchema),
    AgentConnectionClaimRequest: jsonSchema(agentConnectionClaimRequestSchema),
    AgentProfileList: jsonSchema(publicAgentProfileListSchema),
    AgentConnection: jsonSchema(publicAgentConnectionSchema),
    AgentConnectionHealth: jsonSchema(agentConnectionHealthSchema),
    AgentProviderHealth: jsonSchema(agentProviderHealthSchema),
    AgentConnectionClaim: jsonSchema(agentConnectionClaimSchema),
    LegacyPrepareResponse: jsonSchema(legacyPrepareResponseSchema),
    LegacyResolveResponse: jsonSchema(legacyResolveResponseSchema),
    LegacyReleaseResponse: jsonSchema(legacyReleaseResponseSchema),
    Metrics: jsonSchema(metricsResponseSchema),
    OpenApiDocument: jsonSchema(openApiDocumentSchema),
    UpstreamJson: jsonSchema(upstreamJsonResponseSchema),
    Binary: { type: "string", format: "binary" },
    WebSocketUpgrade: { type: "string", description: "saaa.llm-stream.v1 WebSocket frames" },
    ControlOperation: jsonSchema(controlOperationSchema),
    ArtifactOperation: jsonSchema(artifactOperationSchema),
    RuntimeReleaseList: jsonSchema(runtimeReleaseListSchema),
    RuntimeReleaseSelection: jsonSchema(runtimeReleaseSelectionSchema),
    RuntimeReleasePlanRequest: jsonSchema(runtimeReleasePlanRequestSchema),
    RuntimeDeployment: jsonSchema(runtimeDeploymentSchema),
    RuntimeDeploymentPlan: jsonSchema(runtimeDeploymentPlanSchema),
    CatalogReloadPlan: jsonSchema(catalogReloadPlanSchema),
    CatalogReloadRequest: jsonSchema(catalogReloadRequestSchema),
    PrepareRequest: jsonSchema(prepareRequestSchema),
    ResolveRequest: jsonSchema(resolveRequestSchema),
    ReleaseRequest: jsonSchema(releaseRequestSchema),
  };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, operationId] of API_OPERATIONS) {
    const successSchema = SUCCESS_SCHEMA_BY_OPERATION[operationId];
    const requestSchema = (() => {
      if (operationId === "createAllocation") return "AllocationRequest";
      if (operationId === "renewAllocation") return "AllocationRenewRequest";
      if (operationId === "resolveAllocation") return "AllocationResolveRequest";
      if (operationId === "createAgentConnection") return "AgentConnectionRequest";
      if (operationId === "claimAgentConnection") return "AgentConnectionClaimRequest";
      if (operationId === "renewAgentConnection") return "AgentConnectionRenewRequest";
      if (operationId === "planRuntimeDeployment") return "RuntimeReleasePlanRequest";
      if (operationId === "activateRuntimeDeployment") return "RuntimeReleaseSelection";
      if (operationId === "reloadCatalog") return "CatalogReloadRequest";
      if (operationId === "prepareLegacyLease") return "PrepareRequest";
      if (operationId === "resolveLegacyLease") return "ResolveRequest";
      if (operationId === "releaseLegacyLease") return "ReleaseRequest";
      return undefined;
    })();
    const management = path.startsWith("/v1/artifacts/")
      || path.startsWith("/v1/artifact-operations/")
      || path.startsWith("/v1/runtime-releases")
      || path.startsWith("/v1/deployments/")
      || path.startsWith("/v1/catalog/")
      || path.startsWith("/v1/inspection/");
    const publicOperation = operationId === "getHealth" || operationId === "getReadiness";
    const optionalAgentBearerOperation = operationId === "listAgentProfiles"
      || operationId === "createAgentConnection"
      || operationId === "getAgentConnection"
      || operationId === "getAgentConnectionHealth"
      || operationId === "claimAgentConnection"
      || operationId === "renewAgentConnection"
      || operationId === "releaseAgentConnection";
    const providerBearerOperation = operationId === "getAgentProviderHealth"
      || operationId === "createChatCompletion"
      || operationId === "upgradeLlmStream"
      || operationId === "createTranscription"
      || operationId === "createSpeech";
    const successContent = (() => {
      if (operationId === "getMetrics") {
        return { "text/plain": { schema: { $ref: "#/components/schemas/Metrics" } } };
      }
      if (operationId === "createChatCompletion") {
        return {
          "application/json": { schema: { $ref: "#/components/schemas/UpstreamJson" } },
        };
      }
      if (operationId === "upgradeLlmStream") return undefined;
      if (operationId === "createSpeech") {
        return {
          "audio/wav": { schema: { $ref: "#/components/schemas/Binary" } },
          "audio/mpeg": { schema: { $ref: "#/components/schemas/Binary" } },
          "application/octet-stream": { schema: { $ref: "#/components/schemas/Binary" } },
        };
      }
      if (operationId === "releaseAgentConnection") return undefined;
      return { "application/json": { schema: { $ref: `#/components/schemas/${successSchema}` } } };
    })();
    const success = {
      description: "Success",
      ...(successContent ? { content: successContent } : {}),
    };
    paths[path] ??= {};
    paths[path]![method] = {
      operationId,
      security: publicOperation ? [] : management
        ? [{ bearerAuth: [], managementToken: [] }]
        : optionalAgentBearerOperation
        ? [{}, { bearerAuth: [] }]
        : providerBearerOperation
        ? [{ bearerAuth: [] }, { providerBearer: [] }]
        : [{ bearerAuth: [] }],
      ...((operationId === "createAgentConnection" || operationId === "renewAgentConnection")
        ? {
          parameters: [{
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          }],
        }
        : {}),
      ...(requestSchema
        ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: `#/components/schemas/${requestSchema}` } } },
          },
        }
        : {}),
      responses: {
        ...Object.fromEntries(SUCCESS_STATUSES_BY_OPERATION[operationId].map((status) => [status, success])),
        ...(operationId === "getReadiness"
          ? { "503": { description: "Not ready", content: successContent } }
          : {}),
        ...(operationId === "getAgentConnectionHealth" || operationId === "getAgentProviderHealth"
          ? { "503": { description: "Semantic provider not ready", content: successContent } }
          : {}),
        "4XX": {
          description: "Client error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
        "5XX": {
          description: "Service error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "LARM API", version },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        providerBearer: {
          type: "http",
          scheme: "bearer",
          description: "Scoped larm_conn_v1 provider credential",
        },
        managementToken: { type: "apiKey", in: "header", name: "x-larm-management-token" },
      },
      schemas,
    },
  };
}
