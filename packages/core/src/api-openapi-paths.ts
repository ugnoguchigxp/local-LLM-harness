import { apiOperationGovernance, apiOperationLifecycle, apiOperationPolicy } from "./api-lifecycle";
import { API_OPERATIONS, SUCCESS_SCHEMA_BY_OPERATION, SUCCESS_STATUSES_BY_OPERATION } from "./api-operations";
import { agentProfileSelectorIdSchema } from "./agent-connection";
import { IMAGE_IMPORT_MAX_BODY_BYTES, IMAGE_IMPORT_MAX_BYTES } from "./image-artifact";

export function createOpenApiPaths(): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [method, path, operationId] of API_OPERATIONS) {
    const monitoring = path.startsWith("/v1/monitoring/");
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
      if (operationId === "createChatCompletion" || operationId === "countChatInputTokens") return "ChatCompletionRequest";
      if (operationId === "createSpeech") return "AudioSpeechRequest";
      if (operationId === "createEmbedding") return "EmbeddingRequest";
      if (operationId === "createDecisionTrainingJob") return "DecisionTrainingRequest";
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
    const providerOnlyOperation = operationId === "countChatInputTokens" || operationId === "createEmbedding" || operationId === "createSystemOneDecision"
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
      if (operationId === "getMusicGenerationAudio" || operationId === "getMusicFavoriteAudio" || operationId === "getMusicTrackAudio") {
        return {
          "audio/ogg": { schema: { $ref: "#/components/schemas/Binary" } },
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
        || operationId === "deleteMusicTrack"
      ) return undefined;
      return { "application/json": { schema: { $ref: `#/components/schemas/${successSchema}` } } };
    })();
    const activityNoStoreHeader = operationId === "getServiceActivity" || monitoring
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
      ...(operationId === "importImageArtifact" ? {
        description: `Import one static WebP without re-encoding or metadata rewriting. Image limit ${IMAGE_IMPORT_MAX_BYTES} bytes; multipart body limit ${IMAGE_IMPORT_MAX_BODY_BYTES} bytes; maximum 2000 pixels per axis and 4,000,000 pixels. Fully decodes for validation. Does not invoke a model. Requires configured Control Bearer authentication even in anonymous development mode. UUID key is scoped to the authenticated token; identical bytes and MIME type replay the same artifact, independent of multipart boundary and filename. Different content returns 409. Receipts persist indefinitely across restart; deleted artifacts return 410 and are never recreated by the same key. Failures recorded after admission are terminal: query the receipt, then use a new UUID for an intentional retry. Before admission, 404 permits retry with the same key and content. Import capacity failures do not evict existing images. Journal capped at 64 MiB; exhaustion rejects new keys with 507. Identity content encoding only.`,
        parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "multipart/form-data": { schema: {
          type: "object", required: ["file"], additionalProperties: false,
          properties: { file: { type: "string", format: "binary", contentMediaType: "image/webp" } },
        }, encoding: { file: { contentType: "image/webp" } } } } },
      } : operationId === "getImageImport" ? {
        description: "Look up a UUID scoped to the same authenticated Control token. Receipts persist indefinitely. Returns succeeded with artifact, failed with stored error/httpStatus, or deleted after manual deletion or normal pool retention. A concurrent request waits for the serialized import to settle. 404 means no admitted receipt; resend identical content with the same UUID. No image or GPU work is started. Token rotation changes the receipt scope; the shared image library retains its existing Control ownership.",
        parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      } : {}),
      ...(operationId === "countChatInputTokens" ? {
        description: "Count the complete claimed LLM Chat Completions input, including template, tools, history and image embeddings, without running inference or retaining the payload. Use the same Provider bearer and model as inference. Returns fits=false for a context budget excess; generation rechecks the budget. This is not an inference reservation or an idempotency receipt. Context views and generation-attempt headers are not accepted; supply the complete messages.",
      } : operationId === "createImageGeneration" ? {
        description: "Synchronous Qwen-Image 2.1 Turbo generation with a fixed eight-step schedule. Defaults: 512x512, seed 0, WebP. Width and height independently accept any integer from 100 through 1280. Generation rounds each axis up to a multiple of 32 and resizes to the exact requested output dimensions; PNG is optional. Control starts and loads the selected model, stores the artifact, and stops the worker before returning 200. Optional model must match the advertised service. Read artifacts[0] or artifact; contentUrl is relative to Control and remains available after worker shutdown. Cold startup is included in request latency; do not automatically resubmit POST.",
      } : operationId === "createMusicGeneration" ? {
        description: "Returns a 202 job. instrumental=true selects Stable Audio Small Music; instrumental=false (legacy default) or lyrics selects ACE-Step Normal. task=sound-effect or model=stable-audio-3-small-sfx selects Stable Audio Small SFX. model=auto and legacy ACE aliases use task routing; XL is unavailable. Stable musical controls are prompt hints. durationSeconds accepts fractional seconds: Stable Music/SFX 1 through 120, ACE-Step 1 through 600. Omitted durations default to 120 for instrumental music, 5 for sound effects, and 180 for vocals; explicit values are never shortened. An explicit Stable Music model defaults to instrumental unless instrumental=false is supplied, which is rejected. GET /v1/music/providers includes per-model task, default duration and duration limits. Completed tracks are stored indefinitely by default and listed or searched at GET /v1/music/tracks. Default output is Ogg Opus at a target 128 kbps with variable bitrate (VBR) and 48 kHz; mp3, wav, and flac remain explicit options. Opus is encoded from ACE-Step temporary float32 WAV or Stable Audio in-memory PCM16 WAV; intermediates are deleted on success or failure. Control starts the model on demand; poll the job or follow events. Completed means the artifact is stored and the worker stopped. Download result.audioUrl relative to Control. Submit once; polling does not start a model.",
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
      ...(monitoring ? {
        description: "Read-only saved observations. Partial sensor failures return 200 with per-value status and original observedAt. Events retain up to ten minutes in this daemon boot; 409 resets the stream, 410 detects expired or lost history. Never loads a model, creates a connection, or renews a lease.",
        parameters: [{ name: "contractVersion", in: "query", required: false, schema: { type: "string", const: "larm-monitoring.v1" } },
          ...(operationId === "getMonitoringEvents" ? [{ name: "cursor", in: "query", required: false, schema: { type: "string", minLength: 1, maxLength: 1024 } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000, default: 500 } }] : [])],
      } : operationId === "getPersonalStateCapability"
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
        : operationId === "listMusicTracks" || operationId === "listMusicFavorites" || operationId === "listMusicTags"
        ? {
          parameters: [
            ...(operationId !== "listMusicTags" ? [
              { name: "q", in: "query", required: false, description: "Case-insensitive words matched against title, prompt, lyrics and tags; all words must match.", schema: { type: "string", maxLength: 512 } },
              { name: "tags", in: "query", required: false, description: "Comma-separated exact tags; all tags must match after Unicode normalization and case folding. Discover tags and track counts at GET /v1/music/tags.", schema: { type: "string", maxLength: 512 } },
            ] : []),
            ...(operationId === "listMusicTracks" ? [
              { name: "sort", in: "query", required: false, description: "Sort by creation time or keyword relevance. Relevance weights title and tags above prompt and lyrics; ties use newest creation time.", schema: { type: "string", enum: ["createdAt", "relevance"], default: "createdAt" } },
              { name: "order", in: "query", required: false, schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
              { name: "favorite", in: "query", required: false, schema: { type: "string", enum: ["true", "false"] } },
            ] : []),
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
            { name: "cursor", in: "query", required: false, description: "Continue with nextCursor from this endpoint and preserve search and ordering settings. Restart tag pagination after library changes because tag counts are live.", schema: { type: "string", minLength: 1, maxLength: 8192 } },
          ],
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
              enum: agentProfileSelectorIdSchema.options,
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
      ...(path.startsWith("/v1/decision/") ? {
        description: "Control Bearer required. Data states, questions and labels are never logged. All mutations require Idempotency-Key (1-128 visible ASCII bytes). Dataset JSONL upload is limited to 8 MiB and 2000 examples, with task-exclusive train/calibration/eval splits; train and eval are required. One asynchronous training job at a time. Frozen d1 log-probability heads are immutable, resident in CPU memory (total 16 MiB), and selected through adapter:{id,version} and questionSet:{id,version} on the single inference endpoint. Dataset deletion is blocked while training. Interrupted jobs fail on restart. Calibration rows are reported, never fitted. Deleting an adapter immediately revokes inference, including in-flight results. Feature extraction waits for foreground idle and resumes the same job after preemption; phase waiting_for_idle reports this wait.",
        ...(method !== "get" ? { parameters: [
          ...[...path.matchAll(/\{([^}]+)\}/g)].map(m => ({ name: m[1], in: "path", required: true, schema: { type: "string" } })),
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } },
        ] } : {}),
      } : {}),
      ...(operationId === "createDecisionDataset" ? {
        requestBody: { required: true, content: { "application/x-ndjson": { schema: { type: "string", maxLength: 8388608 } } } },
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
        ...((operationId === "importImageArtifact" || operationId === "getImageImport") ? Object.fromEntries([
          ["400", "invalid_idempotency_key / invalid_multipart / bad_request"],
          ["401", "unauthorized"], ["404", "image_import_not_found (lookup only)"],
          ["409", "idempotency_conflict / image_import_interrupted"], ["410", "image_artifact_deleted"],
          ["413", "body_too_large / image_too_large / image_dimensions_exceeded"],
          ["415", "unsupported_image_format / animated_image_not_supported / unsupported_content_encoding"],
          ["422", "invalid_image"], ["500", "image_storage_failed"], ["503", "not_configured"],
          ["507", "image_storage_full / image_import_journal_full"],
        ].map(([status, description]) => [status, { description, content: {
          "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
        } }])) : {}),
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
          content: { "application/json": { schema: { $ref: monitoring ? "#/components/schemas/MonitoringError" : "#/components/schemas/ErrorResponse" } } },
        },
        "5XX": {
          description: "Service error",
          ...(activityNoStoreHeader ? { headers: { "Cache-Control": activityNoStoreHeader } } : {}),
          content: { "application/json": { schema: { $ref: monitoring ? "#/components/schemas/MonitoringError" : "#/components/schemas/ErrorResponse" } } },
        },
      },
    };
  }
  return paths;
}
