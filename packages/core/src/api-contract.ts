import { z } from "zod";
import {
  SUCCESS_SCHEMA_BY_OPERATION,
  SUCCESS_STATUSES_BY_OPERATION,
} from "./api-operations";
export { API_OPERATIONS } from "./api-operations";
import { createOpenApiPaths } from "./api-openapi-paths";
import {
  contextListSchema,
  contextRuntimeStatusSchema,
  contextStatusSchema,
  publicContextDescriptorSchema,
  publicContextOperationSchema,
  publicContextViewSchema,
} from "./context-contract";
export {
  contextListSchema,
  contextRuntimeStatusSchema,
  contextStatusSchema,
  publicContextDescriptorSchema,
  publicContextOperationSchema,
  publicContextViewSchema,
} from "./context-contract";
import {
  audioSpeechRequestSchema,
  audioVoiceDiscoverySchema,
  audioVoiceListSchema,
  audioVoiceSchema,
  audioVoiceStyleSchema,
  chatCompletionRequestSchema,
  chatCompletionResponseFormatSchema,
  type AudioSpeechRequest,
  type AudioVoice,
  type AudioVoiceList,
} from "./openai-contract";

export {
  audioSpeechRequestSchema,
  audioVoiceDiscoverySchema,
  audioVoiceListSchema,
  audioVoiceSchema,
  audioVoiceStyleSchema,
  chatCompletionRequestSchema,
  chatCompletionResponseFormatSchema,
  type AudioSpeechRequest,
  type AudioVoice,
  type AudioVoiceList,
} from "./openai-contract";

export {
  apiOperationGovernance,
  apiOperationLifecycle,
  apiOperationPolicy,
  compatibilityApiOperation,
  type ApiLifecycleClass,
  type ApiOperationGovernance,
  type ApiOperationAuthority,
  type ApiOperationOwner,
} from "./api-lifecycle";
import {
  allocationRenewRequestSchema,
  allocationRequestSchema,
  allocationResolveRequestSchema,
  deploymentPolicySchema,
  prepareRequestSchema,
  releaseRequestSchema,
  resolveRequestSchema,
} from "./api-schema";
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
import { systemOneRequestSchema, systemOneResponseSchema } from "./system-one";
import {
  musicArtifactMetadataSchema,
  musicFavoriteListSchema,
  musicFavoriteSchema,
  musicGenerationJobSchema,
  musicGenerationRequestSchema,
  musicProviderListSchema,
} from "./music";
import {
  imageArtifactDeleteSchema,
  imageArtifactListSchema,
  imageArtifactSchema,
} from "./image-artifact";
import {
  clusterStateSchema,
  runtimeDefinitionSchema,
} from "./schema";
import {
  saaaAsrHealthSchema,
  saaaServiceHarnessSchema,
} from "./service-harness";
import { serviceActivitySchema } from "./service-activity";
import { openAiModelListSchema } from "./openai-model-catalog";
import { contextRegistrationRequestSchema, contextViewRequestSchema } from "./context";
import {
  httpProviderSoakEvidenceSchema,
  publicRuntimeReleaseSchema,
  releaseConvergenceStatusSchema,
  runtimeDeploymentPlanSchema,
  runtimeDeploymentSchema,
  runtimeReleaseListSchema,
  runtimeReleasePlanRequestSchema,
  runtimeReleaseSelectionSchema,
  type HttpProviderSoakEvidence,
  type PublicRuntimeRelease,
  type ReleaseConvergenceStatus,
  type RuntimeDeployment,
  type RuntimeDeploymentPlan,
  type RuntimeReleasePlanRequest,
  type RuntimeReleaseSelection,
} from "./runtime-release-contract";
export {
  httpProviderSoakEvidenceSchema,
  publicRuntimeReleaseSchema,
  releaseConvergenceStatusSchema,
  runtimeDeploymentPlanSchema,
  runtimeDeploymentSchema,
  runtimeReleaseListSchema,
  runtimeReleasePlanRequestSchema,
  runtimeReleaseSelectionSchema,
  type HttpProviderSoakEvidence,
  type PublicRuntimeRelease,
  type ReleaseConvergenceStatus,
  type RuntimeDeployment,
  type RuntimeDeploymentPlan,
  type RuntimeReleasePlanRequest,
  type RuntimeReleaseSelection,
} from "./runtime-release-contract";
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

import {
  errorDetailSchema,
  publicRuntimeSchema,
  runtimeListSchema,
  publicRuntimeSnapshotSchema,
  publicClusterStateSchema,
  inspectionRuntimeListSchema,
  inspectionProviderInstanceListSchema,
  errorResponseSchema,
  daemonHealthSchema,
  readinessSchema,
  publicAllocationBindingSchema,
  publicAllocationSchema,
  allocationResolveResponseSchema,
  legacyPrepareResponseSchema,
  legacyResolveResponseSchema,
  legacyReleaseResponseSchema,
  controlOperationSchema,
  artifactOperationSchema,
  type ControlOperation,
  type PublicAllocation,
} from "./api-control-contract";
export {
  errorDetailSchema,
  publicRuntimeSchema,
  runtimeListSchema,
  publicRuntimeSnapshotSchema,
  publicClusterStateSchema,
  inspectionRuntimeListSchema,
  inspectionProviderInstanceListSchema,
  errorResponseSchema,
  daemonHealthSchema,
  readinessSchema,
  publicAllocationBindingSchema,
  publicAllocationSchema,
  allocationResolveResponseSchema,
  legacyPrepareResponseSchema,
  legacyResolveResponseSchema,
  legacyReleaseResponseSchema,
  controlOperationSchema,
  artifactOperationSchema,
  type ControlOperation,
  type PublicAllocation,
} from "./api-control-contract";

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
    InspectionProviderInstanceList: jsonSchema(inspectionProviderInstanceListSchema),
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
    AudioVoiceList: jsonSchema(audioVoiceListSchema),
    AudioVoiceDiscovery: jsonSchema(audioVoiceDiscoverySchema),
    EmbeddingRequest: jsonSchema(embeddingRequestSchema),
    EmbeddingResponse: jsonSchema(embeddingResponseSchema),
    SystemOneRequest: jsonSchema(systemOneRequestSchema),
    SystemOneResponse: jsonSchema(systemOneResponseSchema),
    MusicGenerationRequest: jsonSchema(musicGenerationRequestSchema),
    MusicGenerationJob: jsonSchema(musicGenerationJobSchema),
    MusicProviderList: jsonSchema(musicProviderListSchema),
    MusicArtifactMetadata: jsonSchema(musicArtifactMetadataSchema),
    MusicFavorite: jsonSchema(musicFavoriteSchema),
    MusicFavoriteList: jsonSchema(musicFavoriteListSchema),
    ImageArtifact: jsonSchema(imageArtifactSchema),
    ImageArtifactList: jsonSchema(imageArtifactListSchema),
    ImageArtifactDelete: jsonSchema(imageArtifactDeleteSchema),
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
  const paths = createOpenApiPaths();
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
