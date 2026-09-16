import { z } from "zod";
import {
  allocationBindingSchema,
  allocationStatusSchema,
} from "./allocation";
import {
  allocationRequirementSchema,
  allocationCapacityPolicySchema,
  allocationPrioritySchema,
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
  publicAgentProfileListV1Schema,
  publicAgentProfileListV3Schema,
} from "./agent-connection";
import { embeddingRequestSchema, embeddingResponseSchema } from "./embedding";
import {
  clusterStateSchema,
  runtimeClassSchema,
  runtimeDefinitionSchema,
  runtimeProtocolSchema,
  runtimeStatusSchema,
} from "./schema";
import {
  saaaAsrHealthSchema,
  saaaServiceHarnessSchema,
} from "./service-harness";
import { serviceActivitySchema } from "./service-activity";
import { openAiModelListSchema } from "./openai-model-catalog";
import {
  contextActivationStateSchema,
  contextDescriptorSchema,
  contextMaterializationModeSchema,
  contextOperationSchema,
  contextRegistrationRequestSchema,
  contextViewItemSchema,
  contextViewOmissionSchema,
  contextViewRequestSchema,
  contextViewStateSchema,
} from "./context";
import {
  canonicalMeasurementReceiptSchema,
  canonicalMeasurementRequestSchema,
  forgetOperationSchema,
  forgetRequestSchema,
  generationAttemptSchema,
  personalStateCapabilitySchema,
  personalStateViewRequestSchema,
  personalStateViewReceiptSchema,
  sourceProvisionReceiptSchema,
} from "./personal-state";

const identifierSchema = z.string().min(1).max(192);

export const errorDetailSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1),
  type: z.string().min(1).max(128).optional(),
  param: z.string().min(1).max(128).nullable().optional(),
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
  z.object({ status: z.literal("stale"), ageMs: z.number() }).strict(),
]);

export const releaseConvergenceStatusSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().regex(/^[a-f0-9]{64}$/),
  desiredRelease: z.string().regex(/^[a-f0-9]{40}$/),
  observedRelease: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  stage: z.enum([
    "approved",
    "validated",
    "activated",
    "contract_verified",
    "canary_verified",
    "consumer_verified",
    "complete",
  ]),
  result: z.enum(["pending", "running", "succeeded", "failed"]),
  reason: z.string().min(1).max(256).nullable(),
  updatedAt: z.string().datetime(),
}).strict();

export const httpProviderSoakEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("http-provider-soak"),
  ok: z.boolean(),
  releaseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  configRevision: z.string().regex(/^[a-f0-9]{64}$/),
  bootEpoch: z.string().min(1).max(128),
  startedAt: z.string().datetime(),
  lastAttemptAt: z.string().datetime(),
  lastSuccessAt: z.string().datetime().nullable(),
  durationSeconds: z.number().int().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  maxGapSeconds: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.ok !== (value.sampleCount > 0 && value.failureCount === 0)) {
    context.addIssue({ code: "custom", message: "ok must reflect samples and failures" });
  }
  if ((value.sampleCount === 0) !== (value.lastSuccessAt === null)) {
    context.addIssue({ code: "custom", message: "lastSuccessAt must reflect sampleCount" });
  }
});

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
  priority: allocationPrioritySchema.optional(),
  capacityPolicy: allocationCapacityPolicySchema.optional(),
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
export const chatCompletionResponseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).passthrough(),
  z.object({ type: z.literal("json_object") }).passthrough(),
  z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: z.string().min(1).max(128).optional(),
      description: z.string().max(1024).optional(),
      strict: z.boolean().optional(),
      schema: z.record(z.string(), z.unknown()),
    }).passthrough(),
  }).passthrough(),
]);
export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.record(z.string(), z.unknown())),
  stream: z.boolean().optional(),
  response_format: chatCompletionResponseFormatSchema.optional(),
}).passthrough();
export const audioSpeechRequestSchema = z.object({
  model: z.string().min(1),
  input: z.string().min(1),
  voice: z.string().min(1).optional(),
  response_format: z.string().min(1).optional(),
  speed: z.number().positive().optional(),
}).passthrough();
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

export const publicContextDescriptorSchema = contextDescriptorSchema.omit({ principal: true });
export const contextListSchema = z.object({
  contexts: z.array(publicContextDescriptorSchema),
  nextCursor: z.string().min(1).max(512).optional(),
}).strict();
export const contextRuntimeStatusSchema = z.object({
  runtime: z.string().min(1).max(128),
  release: z.string().min(1).max(128).optional(),
  state: contextActivationStateSchema,
  reason: z.string().min(1).max(128),
  modes: z.array(contextMaterializationModeSchema).max(1),
  leaseEpoch: z.number().int().nonnegative(),
  quota: z.object({
    sourceTokensUsed: z.number().int().nonnegative(),
    sourceTokensLimit: z.number().int().nonnegative(),
    sourceBytesUsed: z.number().int().nonnegative(),
    sourceBytesLimit: z.number().int().nonnegative(),
    filesystemFreeFloorBytes: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();
export const contextStatusSchema = z.object({
  enabled: z.boolean(),
  state: contextActivationStateSchema,
  runtimes: z.array(contextRuntimeStatusSchema),
}).strict();
export const publicContextViewSchema = z.object({
  id: z.string().min(1).max(192),
  operationId: z.string().min(1).max(192),
  allocationId: z.string().min(1).max(192),
  runtime: z.string().min(1).max(128),
  release: z.string().min(1).max(128),
  state: contextViewStateSchema,
  mode: z.literal("source-rebuild"),
  canonicalizationVersion: z.enum(["context-view-v1", "context-view-v2"]).optional(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  dataEpoch: z.number().int().nonnegative().optional(),
  tokenCount: z.number().int().nonnegative(),
  inputBudgetTokens: z.number().int().nonnegative(),
  orderedItems: z.array(contextViewItemSchema).max(512),
  omitted: z.array(contextViewOmissionSchema).max(512),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
export const publicContextOperationSchema = contextOperationSchema.omit({
  principal: true,
  idempotencyKeyDigest: true,
});

export type PublicAllocation = z.infer<typeof publicAllocationSchema>;
export type ControlOperation = z.infer<typeof controlOperationSchema>;
export type PublicRuntimeRelease = z.infer<typeof publicRuntimeReleaseSchema>;
export type RuntimeReleaseSelection = z.infer<typeof runtimeReleaseSelectionSchema>;
export type RuntimeReleasePlanRequest = z.infer<typeof runtimeReleasePlanRequestSchema>;
export type RuntimeDeployment = z.infer<typeof runtimeDeploymentSchema>;
export type RuntimeDeploymentPlan = z.infer<typeof runtimeDeploymentPlanSchema>;
export type ReleaseConvergenceStatus = z.infer<typeof releaseConvergenceStatusSchema>;
export type HttpProviderSoakEvidence = z.infer<typeof httpProviderSoakEvidenceSchema>;

export const API_OPERATIONS = [
  ["get", "/health", "getHealth"],
  ["get", "/ready", "getReadiness"],
  ["get", "/v1/activity", "getServiceActivity"],
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
  ["get", "/v1/release-convergence", "getReleaseConvergence"],
  ["post", "/v1/allocations", "createAllocation"],
  ["get", "/v1/allocations/{id}", "getAllocation"],
  ["post", "/v1/allocations/{id}/renew", "renewAllocation"],
  ["post", "/v1/allocations/{id}/resolve", "resolveAllocation"],
  ["delete", "/v1/allocations/{id}", "releaseAllocation"],
  ["get", "/v1/context-status", "getContextStatus"],
  ["post", "/v1/contexts", "createContext"],
  ["get", "/v1/contexts", "listContexts"],
  ["delete", "/v1/contexts/{id}", "deleteContext"],
  ["post", "/v1/context-views", "createContextView"],
  ["get", "/v1/context-operations/{id}", "getContextOperation"],
  ["get", "/v1/personal-state/capability", "getPersonalStateCapability"],
  ["post", "/v1/context-sources", "provisionContextSource"],
  ["get", "/v1/context-source-operations/{incarnation}", "getContextSourceOperation"],
  ["post", "/v1/context-measurements", "createContextMeasurement"],
  ["get", "/v1/context-measurements/{id}", "getContextMeasurement"],
  ["post", "/v2/context-views", "createContextViewV2"],
  ["get", "/v2/context-views/{id}", "getContextViewV2"],
  ["get", "/v1/generation-attempts/{id}", "getGenerationAttempt"],
  ["post", "/v1/generation-attempts/{id}/cancel", "cancelGenerationAttempt"],
  ["post", "/v1/context-forget-operations", "createContextForgetOperation"],
  ["get", "/v1/context-forget-operations/{id}", "getContextForgetOperation"],
  ["get", "/v1/agent-profiles", "listAgentProfilesV1"],
  ["get", "/v2/agent-profiles", "listAgentProfiles"],
  ["get", "/v3/agent-profiles", "listAgentProfilesV3"],
  ["get", "/v1/services", "listServices"],
  ["get", "/v1/services/asr/health", "getAsrServiceHealth"],
  ["post", "/v1/agent-connections", "createAgentConnection"],
  ["get", "/v1/agent-connections/{id}", "getAgentConnection"],
  ["get", "/v1/agent-connections/{id}/health", "getAgentConnectionHealth"],
  ["get", "/v1/agent-connections/{id}/providers/{name}/health", "getAgentProviderHealth"],
  ["post", "/v1/agent-connections/{id}/claim", "claimAgentConnection"],
  ["post", "/v1/agent-connections/{id}/renew", "renewAgentConnection"],
  ["delete", "/v1/agent-connections/{id}", "releaseAgentConnection"],
  ["get", "/v1/models", "listOpenAiModels"],
  ["post", "/v1/chat/completions", "createChatCompletion"],
  ["post", "/v1/audio/transcriptions", "createTranscription"],
  ["post", "/v1/audio/speech", "createSpeech"],
  ["post", "/v1/embed", "createEmbedding"],
  ["get", "/v1/audio/voices", "listVoices"],
  ["get", "/v1/artifact-operations/{id}", "getArtifactOperation"],
  ["post", "/v1/artifacts/{id}/stage", "stageArtifact"],
  ["get", "/v1/runtime-releases", "listRuntimeReleases"],
  ["post", "/v1/runtime-releases/{id}/stage", "stageRuntimeRelease"],
  ["get", "/v1/deployments/{runtime}", "getRuntimeDeployment"],
  ["post", "/v1/deployments/{runtime}/plan", "planRuntimeDeployment"],
  ["post", "/v1/deployments/{runtime}/activate", "activateRuntimeDeployment"],
  ["post", "/v1/deployments/{runtime}/rollback", "rollbackRuntimeDeployment"],
  ["post", "/prepare", "prepareLegacyLease"],
  ["post", "/resolve", "resolveLegacyLease"],
  ["post", "/release", "releaseLegacyLease"],
] as const;

type ApiOperationId = typeof API_OPERATIONS[number][2];

const SUCCESS_STATUSES_BY_OPERATION: Record<ApiOperationId, readonly string[]> = {
  getHealth: ["200"],
  getReadiness: ["200"],
  getServiceActivity: ["200"],
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
  getReleaseConvergence: ["200"],
  createAllocation: ["200", "202"],
  getAllocation: ["200"],
  renewAllocation: ["200"],
  resolveAllocation: ["200"],
  releaseAllocation: ["200"],
  getContextStatus: ["200"],
  createContext: ["200", "201"],
  listContexts: ["200"],
  deleteContext: ["204"],
  createContextView: ["200", "201"],
  getContextOperation: ["200"],
  getPersonalStateCapability: ["200"],
  provisionContextSource: ["200", "201"],
  getContextSourceOperation: ["200"],
  createContextMeasurement: ["200", "201"],
  getContextMeasurement: ["200"],
  createContextViewV2: ["200", "201"],
  getContextViewV2: ["200"],
  getGenerationAttempt: ["200"],
  cancelGenerationAttempt: ["200"],
  createContextForgetOperation: ["200", "202"],
  getContextForgetOperation: ["200"],
  listAgentProfilesV1: ["200"],
  listAgentProfiles: ["200"],
  listAgentProfilesV3: ["200"],
  listServices: ["200"],
  getAsrServiceHealth: ["200"],
  createAgentConnection: ["201", "202"],
  getAgentConnection: ["200"],
  getAgentConnectionHealth: ["200"],
  getAgentProviderHealth: ["200"],
  claimAgentConnection: ["200"],
  renewAgentConnection: ["200"],
  releaseAgentConnection: ["204"],
  listOpenAiModels: ["200"],
  createChatCompletion: ["200"],
  createTranscription: ["200"],
  createSpeech: ["200"],
  createEmbedding: ["200"],
  listVoices: ["200"],
  getArtifactOperation: ["200"],
  stageArtifact: ["202"],
  listRuntimeReleases: ["200"],
  stageRuntimeRelease: ["202"],
  getRuntimeDeployment: ["200"],
  planRuntimeDeployment: ["200"],
  activateRuntimeDeployment: ["202"],
  rollbackRuntimeDeployment: ["202"],
  prepareLegacyLease: ["200", "202"],
  resolveLegacyLease: ["200"],
  releaseLegacyLease: ["200"],
};

const SUCCESS_SCHEMA_BY_OPERATION: Record<ApiOperationId, string> = {
  getHealth: "Health",
  getReadiness: "Readiness",
  getServiceActivity: "ServiceActivity",
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
  getReleaseConvergence: "ReleaseConvergenceStatus",
  createAllocation: "Allocation",
  getAllocation: "Allocation",
  renewAllocation: "Allocation",
  resolveAllocation: "AllocationResolveResponse",
  releaseAllocation: "Allocation",
  getContextStatus: "ContextStatus",
  createContext: "ContextDescriptor",
  listContexts: "ContextList",
  deleteContext: "ContextDescriptor",
  createContextView: "ContextView",
  getContextOperation: "ContextOperation",
  getPersonalStateCapability: "PersonalStateCapability",
  provisionContextSource: "SourceProvisionReceipt",
  getContextSourceOperation: "SourceProvisionReceipt",
  createContextMeasurement: "CanonicalMeasurementReceipt",
  getContextMeasurement: "CanonicalMeasurementReceipt",
  createContextViewV2: "ContextView",
  getContextViewV2: "PersonalStateViewReceipt",
  getGenerationAttempt: "GenerationAttempt",
  cancelGenerationAttempt: "GenerationAttempt",
  createContextForgetOperation: "ForgetOperation",
  getContextForgetOperation: "ForgetOperation",
  listAgentProfilesV1: "AgentProfileListV1",
  listAgentProfiles: "AgentProfileList",
  listAgentProfilesV3: "AgentProfileListV3",
  listServices: "ServiceHarness",
  getAsrServiceHealth: "AsrServiceHealth",
  createAgentConnection: "AgentConnection",
  getAgentConnection: "AgentConnection",
  getAgentConnectionHealth: "AgentConnectionHealth",
  getAgentProviderHealth: "AgentProviderHealth",
  claimAgentConnection: "AgentConnectionClaim",
  renewAgentConnection: "AgentConnection",
  releaseAgentConnection: "AgentConnection",
  listOpenAiModels: "OpenAiModelList",
  createChatCompletion: "UpstreamJson",
  createTranscription: "UpstreamJson",
  createSpeech: "Binary",
  createEmbedding: "EmbeddingResponse",
  listVoices: "UpstreamJson",
  getArtifactOperation: "ArtifactOperation",
  stageArtifact: "ArtifactOperation",
  listRuntimeReleases: "RuntimeReleaseList",
  stageRuntimeRelease: "ArtifactOperation",
  getRuntimeDeployment: "RuntimeDeployment",
  planRuntimeDeployment: "RuntimeDeploymentPlan",
  activateRuntimeDeployment: "ArtifactOperation",
  rollbackRuntimeDeployment: "ArtifactOperation",
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
    ServiceActivity: jsonSchema(serviceActivitySchema),
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
    ContextStatus: jsonSchema(contextStatusSchema),
    ContextRegistrationRequest: jsonSchema(contextRegistrationRequestSchema),
    ContextDescriptor: jsonSchema(publicContextDescriptorSchema),
    ContextList: jsonSchema(contextListSchema),
    ContextViewRequest: jsonSchema(contextViewRequestSchema),
    ContextView: jsonSchema(publicContextViewSchema),
    ContextOperation: jsonSchema(publicContextOperationSchema),
    PersonalStateCapability: jsonSchema(personalStateCapabilitySchema),
    SourceProvisionReceipt: jsonSchema(sourceProvisionReceiptSchema),
    CanonicalMeasurementRequest: jsonSchema(canonicalMeasurementRequestSchema),
    CanonicalMeasurementReceipt: jsonSchema(canonicalMeasurementReceiptSchema),
    PersonalStateViewRequest: jsonSchema(personalStateViewRequestSchema),
    PersonalStateViewReceipt: jsonSchema(personalStateViewReceiptSchema),
    GenerationAttempt: jsonSchema(generationAttemptSchema),
    ForgetRequest: jsonSchema(forgetRequestSchema),
    ForgetOperation: jsonSchema(forgetOperationSchema),
    AgentConnectionRequest: jsonSchema(agentConnectionRequestSchema),
    AgentConnectionRenewRequest: jsonSchema(agentConnectionRenewRequestSchema),
    AgentConnectionClaimRequest: jsonSchema(agentConnectionClaimRequestSchema),
    AgentProfileListV1: jsonSchema(publicAgentProfileListV1Schema),
    AgentProfileList: jsonSchema(publicAgentProfileListSchema),
    AgentProfileListV3: jsonSchema(publicAgentProfileListV3Schema),
    ServiceHarness: jsonSchema(saaaServiceHarnessSchema),
    AsrServiceHealth: jsonSchema(saaaAsrHealthSchema),
    AgentConnection: jsonSchema(publicAgentConnectionSchema),
    AgentConnectionHealth: jsonSchema(agentConnectionHealthSchema),
    AgentProviderHealth: jsonSchema(agentProviderHealthSchema),
    AgentConnectionClaim: jsonSchema(agentConnectionClaimSchema),
    LegacyPrepareResponse: jsonSchema(legacyPrepareResponseSchema),
    LegacyResolveResponse: jsonSchema(legacyResolveResponseSchema),
    LegacyReleaseResponse: jsonSchema(legacyReleaseResponseSchema),
    Metrics: jsonSchema(metricsResponseSchema),
    OpenApiDocument: jsonSchema(openApiDocumentSchema),
    ChatCompletionRequest: jsonSchema(chatCompletionRequestSchema),
    AudioSpeechRequest: jsonSchema(audioSpeechRequestSchema),
    EmbeddingRequest: jsonSchema(embeddingRequestSchema),
    EmbeddingResponse: jsonSchema(embeddingResponseSchema),
    OpenAiModelList: jsonSchema(openAiModelListSchema),
    UpstreamJson: jsonSchema(upstreamJsonResponseSchema),
    ServerSentEvents: {
      type: "string",
      description: "OpenAI-compatible Server-Sent Events, terminated by data: [DONE]",
    },
    Binary: { type: "string", format: "binary" },
    ControlOperation: jsonSchema(controlOperationSchema),
    ReleaseConvergenceStatus: jsonSchema(releaseConvergenceStatusSchema),
    ArtifactOperation: jsonSchema(artifactOperationSchema),
    RuntimeReleaseList: jsonSchema(runtimeReleaseListSchema),
    RuntimeReleaseSelection: jsonSchema(runtimeReleaseSelectionSchema),
    RuntimeReleasePlanRequest: jsonSchema(runtimeReleasePlanRequestSchema),
    RuntimeDeployment: jsonSchema(runtimeDeploymentSchema),
    RuntimeDeploymentPlan: jsonSchema(runtimeDeploymentPlanSchema),
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
      if (operationId === "createContext") return "ContextRegistrationRequest";
      if (operationId === "createContextView") return "ContextViewRequest";
      if (operationId === "createContextMeasurement") return "CanonicalMeasurementRequest";
      if (operationId === "createContextViewV2") return "PersonalStateViewRequest";
      if (operationId === "createContextForgetOperation") return "ForgetRequest";
      if (operationId === "createAgentConnection") return "AgentConnectionRequest";
      if (operationId === "createChatCompletion") return "ChatCompletionRequest";
      if (operationId === "createSpeech") return "AudioSpeechRequest";
      if (operationId === "createEmbedding") return "EmbeddingRequest";
      if (operationId === "claimAgentConnection") return "AgentConnectionClaimRequest";
      if (operationId === "renewAgentConnection") return "AgentConnectionRenewRequest";
      if (operationId === "planRuntimeDeployment") return "RuntimeReleasePlanRequest";
      if (operationId === "activateRuntimeDeployment") return "RuntimeReleaseSelection";
      if (operationId === "prepareLegacyLease") return "PrepareRequest";
      if (operationId === "resolveLegacyLease") return "ResolveRequest";
      if (operationId === "releaseLegacyLease") return "ReleaseRequest";
      return undefined;
    })();
    const management = path.startsWith("/v1/artifacts/")
      || path.startsWith("/v1/artifact-operations/")
      || path.startsWith("/v1/runtime-releases")
      || path.startsWith("/v1/deployments/")
      || path.startsWith("/v1/inspection/");
    const publicOperation = operationId === "getHealth" || operationId === "getReadiness";
    const optionalAgentBearerOperation = operationId === "listAgentProfilesV1"
      || operationId === "listAgentProfiles"
      || operationId === "listAgentProfilesV3"
      || operationId === "getServiceActivity"
      || operationId === "createAgentConnection"
      || operationId === "getAgentConnection"
      || operationId === "getAgentConnectionHealth"
      || operationId === "claimAgentConnection"
      || operationId === "renewAgentConnection"
      || operationId === "releaseAgentConnection";
    const configurableServiceBearerOperation = operationId === "listServices"
      || operationId === "getAsrServiceHealth"
      || operationId === "createTranscription";
    const providerBearerOperation = operationId === "getAgentProviderHealth"
      || operationId === "createChatCompletion"
      || operationId === "createTranscription"
      || operationId === "createSpeech"
      || operationId === "createContext";
    const providerOnlyOperation = operationId === "createEmbedding"
      || operationId === "getPersonalStateCapability"
      || operationId === "provisionContextSource"
      || operationId === "getContextSourceOperation"
      || operationId === "createContextMeasurement"
      || operationId === "getContextMeasurement"
      || operationId === "createContextViewV2"
      || operationId === "getContextViewV2"
      || operationId === "getGenerationAttempt"
      || operationId === "cancelGenerationAttempt"
      || operationId === "createContextForgetOperation"
      || operationId === "getContextForgetOperation";
    const successContent = (() => {
      if (operationId === "getMetrics") {
        return { "text/plain": { schema: { $ref: "#/components/schemas/Metrics" } } };
      }
      if (operationId === "createChatCompletion") {
        return {
          "application/json": { schema: { $ref: "#/components/schemas/UpstreamJson" } },
          "text/event-stream": { schema: { $ref: "#/components/schemas/ServerSentEvents" } },
        };
      }
      if (operationId === "createSpeech") {
        return {
          "audio/wav": { schema: { $ref: "#/components/schemas/Binary" } },
          "audio/mpeg": { schema: { $ref: "#/components/schemas/Binary" } },
          "application/octet-stream": { schema: { $ref: "#/components/schemas/Binary" } },
        };
      }
      if (operationId === "releaseAgentConnection" || operationId === "deleteContext") return undefined;
      return { "application/json": { schema: { $ref: `#/components/schemas/${successSchema}` } } };
    })();
    const activityNoStoreHeader = operationId === "getServiceActivity"
      ? {
        description: "Activity snapshots and errors must not be cached",
        schema: { type: "string", const: "no-store" },
      }
      : undefined;
    const activityHeaders = activityNoStoreHeader
      ? {
        "Cache-Control": activityNoStoreHeader,
        "Retry-After": {
          description: "Whole seconds before polling again; present for active, draining, and unavailable states",
          schema: { type: "integer", minimum: 1 },
        },
      }
      : undefined;
    const success = {
      description: "Success",
      ...(successContent ? { content: successContent } : {}),
      ...(activityHeaders ? { headers: activityHeaders } : {}),
    };
    paths[path] ??= {};
    paths[path]![method] = {
      operationId,
      security: publicOperation ? [] : management
        ? [{ bearerAuth: [], managementToken: [] }]
        : providerOnlyOperation
        ? [{ providerBearer: [] }]
        : configurableServiceBearerOperation
        ? [{}, { bearerAuth: [] }, ...(operationId === "createTranscription"
          ? [{ providerBearer: [] }]
          : [])]
        : optionalAgentBearerOperation
        ? [{}, { bearerAuth: [] }]
        : providerBearerOperation
        ? [{ bearerAuth: [] }, { providerBearer: [] }]
        : [{ bearerAuth: [] }],
      ...(operationId === "getPersonalStateCapability"
        ? {
          parameters: [{
            name: "X-LARM-Allocation-ID",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 192 },
          }, {
            name: "X-LARM-Runtime",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 128 },
          }],
        }
        : operationId === "listVoices"
        ? {
          parameters: [{
            name: "model",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1 },
          }],
        }
        : operationId === "provisionContextSource"
        ? {
          parameters: [{
            name: "X-LARM-Source-Incarnation",
            in: "header",
            required: true,
            schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
          }, {
            name: "X-LARM-Allocation-ID",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 192 },
          }, {
            name: "X-LARM-Runtime",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 1, maxLength: 128 },
          }, {
            name: "X-LARM-Source-Digest",
            in: "header",
            required: true,
            schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
          }],
        }
        : operationId === "listContexts"
        ? {
          parameters: [{
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", minLength: 1, maxLength: 512 },
          }, {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          }],
        }
        : ((operationId === "createAgentConnection"
        || operationId === "renewAgentConnection"
        || operationId === "createContext"
        || operationId === "createContextView"
        || operationId === "createContextViewV2"
        || operationId === "deleteContext")
        ? {
          parameters: [{
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          }],
        }
        : {})),
      ...(operationId === "provisionContextSource"
        ? {
          requestBody: {
            required: true,
            content: { "text/plain; charset=utf-8": { schema: { type: "string" } } },
          },
        }
        : requestSchema
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
        ...(operationId === "getServiceActivity"
          ? {
            "503": {
              description: "Activity tracking unavailable",
              headers: activityHeaders,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
              },
            },
          }
          : {}),
        "4XX": {
          description: "Client error",
          ...(activityNoStoreHeader ? { headers: { "Cache-Control": activityNoStoreHeader } } : {}),
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
        "5XX": {
          description: "Service error",
          ...(activityNoStoreHeader ? { headers: { "Cache-Control": activityNoStoreHeader } } : {}),
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
