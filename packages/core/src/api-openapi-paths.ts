import { apiOperationGovernance, apiOperationLifecycle, apiOperationPolicy } from "./api-lifecycle";
import { API_OPERATIONS, SUCCESS_SCHEMA_BY_OPERATION, SUCCESS_STATUSES_BY_OPERATION } from "./api-operations";

export function createOpenApiPaths(): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, operationId] of API_OPERATIONS) {
    const successSchema = SUCCESS_SCHEMA_BY_OPERATION[operationId];
    const requestSchema = (() => {
      if (operationId === "ensureLocalService") return "LocalServiceLeaseRequest";
      if (operationId === "renewLocalServiceLease") return "LocalServiceRenewRequest";
      if (operationId === "stopLocalService") return "LocalServiceStopRequest";
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
      if (operationId === "createSystemOneDecision") return "SystemOneRequest";
      if (operationId === "createMusicGeneration") return "MusicGenerationRequest";
      if (operationId === "createImageGeneration") return "ImageGenerationRequest";
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
      if (operationId === "getMusicGenerationEvents") {
        return {
          "text/event-stream": { schema: { $ref: "#/components/schemas/ServerSentEvents" } },
        };
      }
      if (operationId === "getMusicGenerationAudio" || operationId === "getMusicFavoriteAudio") {
        return {
          "audio/wav": { schema: { $ref: "#/components/schemas/Binary" } },
          "audio/flac": { schema: { $ref: "#/components/schemas/Binary" } },
          "audio/mpeg": { schema: { $ref: "#/components/schemas/Binary" } },
        };
      }
      if (operationId === "getImageArtifactContent") {
        return {
          "image/webp": { schema: { $ref: "#/components/schemas/Binary" } },
          "image/png": { schema: { $ref: "#/components/schemas/Binary" } },
        };
      }
      if (
        operationId === "releaseAgentConnection"
        || operationId === "deleteContext"
        || operationId === "unfavoriteMusicGeneration"
      ) return undefined;
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
      ...(successContent && !["releaseLocalServiceLease", "stopLocalService"].includes(operationId) ? { content: successContent } : {}),
      ...(activityHeaders ? { headers: activityHeaders } : {}),
    };
    const lifecycle = apiOperationLifecycle(path, operationId);
    paths[path] ??= {};
    paths[path]![method] = {
      operationId,
      ...(operationId === "createImageGeneration" ? {
        description: "Synchronous Qwen-Image 2.1 Turbo generation with a fixed eight-step schedule. Defaults: 512x512, seed 0, WebP. Width and height independently accept any integer from 100 through 1280. Generation rounds each axis up to a multiple of 32 and resizes to the exact requested output dimensions; PNG is optional. Control starts and loads the selected model, stores the artifact, and stops the worker before returning 200. Optional model must match the advertised service. Read artifacts[0] or artifact; contentUrl is relative to Control and remains available after worker shutdown. Cold startup is included in request latency; do not automatically resubmit POST.",
      } : operationId === "createMusicGeneration" ? {
        description: "Returns a 202 job. Control starts the model on demand; poll the job or follow events. Completed means the artifact is stored and the worker stopped. Download result.audioUrl relative to Control. Submit once; polling does not start a model.",
      } : {}),
      ...(lifecycle.classification === "compatibility" ? { deprecated: true } : {}),
      "x-larm-lifecycle": lifecycle,
      "x-larm-governance": apiOperationGovernance(path, operationId),
      "x-larm-policy": apiOperationPolicy(path, operationId),
      security: path.startsWith("/v1/management/local-services/") ? [{ localServiceManagementBearer: [] }]
        : /^\/v1\/local-service/.test(path) ? [{ localServiceBearer: [] }]
        : publicOperation ? [] : management
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
        : operationId === "createChatCompletion"
        ? {
          parameters: [{
            name: "X-LARM-Exclusive-Execution",
            in: "header",
            required: false,
            description: "Set to true for a management-authorized request that drains active execution and excludes all other runtimes until completion.",
            schema: { type: "string", const: "true" },
          }, {
            name: "X-LARM-Management-Token",
            in: "header",
            required: false,
            description: "Required when X-LARM-Exclusive-Execution is true.",
            schema: { type: "string", minLength: 1 },
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
        : operationId === "listAgentProfilesV3"
        ? {
          parameters: [{
            name: "profile",
            in: "query",
            required: false,
            description: "Resolve a public consumer profile selector and return its concrete agent profile, providers, and optional services.",
            schema: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
              enum: ["contextStill", "SAAA", "SAAA-w-Image", "SAAA-w-music", "vulnWorkbench"],
            },
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
          }, ...(operationId === "createAgentConnection"
            ? [{
              name: "Prefer",
              in: "header",
              required: false,
              description: "Bounded readiness wait, formatted as wait=N where N is 1 through 300 seconds",
              schema: { type: "string", pattern: "^wait=([1-9][0-9]{0,2})$" },
            }]
            : [])],
        }
        : {})),
      ...(operationId === "ensureLocalService" ? {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true,
          schema: { type: "string", minLength: 1, maxLength: 192 } }],
      } : {}),
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
        ...(operationId === "createAgentConnection"
          ? { "503": { description: "Connection reached a terminal readiness failure", content: successContent } }
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
  return paths;
}
