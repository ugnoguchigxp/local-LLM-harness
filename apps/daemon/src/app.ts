import type {
  AgentConnectionCatalog,
  ClusterState,
  Registry,
  RuntimeProtocol,
  ServiceActivityState,
} from "@larm/core";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  allocationRenewRequestSchema,
  allocationRequestSchema,
  allocationResolveRequestSchema,
  agentConnectionClaimRequestSchema,
  agentConnectionRenewRequestSchema,
  agentConnectionRequestSchema,
  audioSpeechRequestSchema,
  createOpenApiDocument,
  createServiceActivity,
  chatCompletionRequestSchema,
  contextRegistrationRequestSchema,
  contextViewRequestSchema,
  embeddingRequestSchema,
  prepareRequestSchema,
  releaseRequestSchema,
  releaseConvergenceStatusSchema,
  resolveRequestSchema,
  SAAA_SERVICE_HARNESS_CONTRACT_VERSION,
  getRuntime,
  selectProtocolBinding,
  runtimeReleasePlanRequestSchema,
  runtimeReleaseSelectionSchema,
  type Allocation,
  type AllocationRequest,
  type EmbeddingRequest,
} from "@larm/core";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ControlEvent, ControlPlane } from "./controller";
import type { ArtifactManager } from "./artifact-manager";
import type { MetricsRegistry, RequestTracker } from "./metrics";
import type { DaemonIdentity } from "./identity";
import { ExecutionGate } from "./execution-gate";
import {
  GatewayRequestPreparationError,
  proxyGateway,
  type FetchLike as GatewayFetchLike,
} from "./gateway";
import { readBodyLimited, RequestBodyError } from "./http-body";
import {
  RuntimeReleaseManager,
  RuntimeReleaseManagerError,
} from "./runtime-release-manager";
import {
  AgentConnectionController,
  agentPrincipal,
  type VerifiedProviderToken,
} from "./agent-connection-controller";
import { ConnectionTokenCodec, ConnectionTokenError } from "./connection-token";
import { SemanticReadiness } from "./semantic-readiness";
import type { InferenceAuditRecorder } from "./inference-audit";
import { ModelBroker, ModelBrokerError } from "./model-broker";
import {
  ContextController,
  ContextControllerError,
} from "./context-controller";

export type FetchLike = GatewayFetchLike;

export type AppDeps = {
  registry: Registry;
  getState: () => ClusterState;
  control: ControlPlane;
  apiToken?: string;
  allowAnonymousAgentConnections?: boolean;
  serviceHarnessAuthEnabled?: boolean;
  managementToken?: string;
  artifactManager?: ArtifactManager;
  runtimeReleaseManager?: RuntimeReleaseManager;
  metrics?: MetricsRegistry;
  requestTracker?: RequestTracker;
  gatewayFetch?: FetchLike;
  controlMaxBodyBytes?: number;
  gatewayMaxBodyBytes?: number;
  embeddingMaxBodyBytes?: number;
  gatewayTimeoutMs?: number;
  speechMaxBodyBytes?: number;
  stateMaxAgeMs?: number;
  now?: () => number;
  random?: () => string;
  onEvent?: (event: ControlEvent) => void;
  identity?: DaemonIdentity;
  getConfigRevision?: () => string;
  getReleaseConvergenceStatus?: () => Promise<unknown> | unknown;
  executionGate?: ExecutionGate;
  idempotencyTtlMs?: number;
  idempotencyLimit?: number;
  agentConnectionCatalog?: AgentConnectionCatalog;
  connectionSigningKey?: Uint8Array;
  connectionReadyTimeoutMs?: number;
  providerProbeTimeoutMs?: number;
  connectionPollIntervalMs?: number;
  connectionHistoryLimit?: number;
  inferenceAuditMode?: "off" | "metadata" | "full-required";
  inferenceAuditRecorder?: InferenceAuditRecorder;
  agentConnectionController?: AgentConnectionController;
  modelBroker?: ModelBroker;
  contextController?: ContextController;
};

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function openAiErrorBody(code: string, message: string, param: string | null = null) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      param,
      code,
    },
  };
}

function secretMatches(actual: string | undefined, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual ?? "").digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return actual !== undefined && timingSafeEqual(actualDigest, expectedDigest);
}

function acceptsProviderBearer(method: string, path: string): boolean {
  if (
    method === "POST"
    && new Set([
      "/v1/chat/completions",
      "/v1/audio/transcriptions",
      "/v1/audio/speech",
      "/v1/embed",
    ]).has(path)
  ) return true;
  return method === "GET"
    && /^\/v1\/agent-connections\/[^/]+\/providers\/[^/]+\/health$/.test(path);
}

function acceptsAnonymousAgentApi(method: string, path: string): boolean {
  if (method === "GET" && path === "/v1/activity") return true;
  if (
    method === "GET"
    && (path === "/v1/agent-profiles" || path === "/v2/agent-profiles" || path === "/v3/agent-profiles")
  ) return true;
  if (method === "POST" && path === "/v1/agent-connections") return true;
  if (/^\/v1\/agent-connections\/[^/]+$/.test(path)) {
    return method === "GET" || method === "DELETE";
  }
  if (/^\/v1\/agent-connections\/[^/]+\/health$/.test(path)) return method === "GET";
  return method === "POST"
    && /^\/v1\/agent-connections\/[^/]+\/(claim|renew)$/.test(path);
}

function isServiceHarnessRequest(
  method: string,
  path: string,
  allocationId: string | undefined,
): boolean {
  return (method === "GET" && (path === "/v1/services" || path === "/v1/services/asr/health"))
    || (method === "POST" && path === "/v1/audio/transcriptions" && allocationId === undefined);
}

const SERVICE_HARNESS_ASR_RUNTIME = "qwen-asr";
const SERVICE_HARNESS_ASR_MODEL = "qwen3-asr-1.7b";
const SERVICE_HARNESS_ALLOCATION_ID = "alloc_service_harness";

export function publicRuntime(runtime: Registry["runtimes"][number]) {
  return {
    id: runtime.id,
    capability: runtime.capability,
    protocol: runtime.protocol,
    policy: { class: runtime.policy.class },
  };
}

export function publicClusterState(state: ClusterState) {
  return {
    generatedAt: state.generatedAt,
    online: state.node.online,
    runtimes: state.runtimes.map((runtime) => ({
      id: runtime.id,
      status: runtime.status,
      class: runtime.class,
      capability: runtime.capability,
      observedAt: runtime.observedAt,
      ...(runtime.health ? { health: { ok: runtime.health.ok } } : {}),
    })),
  };
}

function inspectionRuntime(runtime: Registry["runtimes"][number]) {
  return {
    id: runtime.id,
    capability: runtime.capability,
    protocol: runtime.protocol,
    ...(runtime.embedding ? { embedding: runtime.embedding } : {}),
    backend: runtime.backend,
    node: runtime.node,
    policy: runtime.policy,
    resources: runtime.resources,
    deployment: runtime.deployment,
  };
}

export function publicAllocation(allocation: Allocation) {
  return {
    ...allocation,
    bindings: allocation.bindings.map(({ endpoint: _endpoint, ...binding }) => binding),
  };
}

async function readJson(c: { req: { raw: Request } }, maxBytes: number): Promise<unknown> {
  let body: Uint8Array;
  try {
    body = await readBodyLimited(c.req.raw, maxBytes);
  } catch (err) {
    if (err instanceof RequestBodyError) {
      throw err;
    }
    throw new RequestBodyError("bad_request", "request body could not be read", 400);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new RequestBodyError("bad_request", "request body must be valid UTF-8 JSON", 400);
  }
}

function normalizedAllocationRequestHash(request: AllocationRequest): string {
  const normalized = {
    ...request,
    requirements: [...request.requirements].sort((left, right) => {
      const leftKey = `${left.capability}\0${left.route}`;
      const rightKey = `${right.capability}\0${right.route}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function createAppComponents(deps: AppDeps) {
  const app = new Hono();
  const controlMaxBodyBytes = deps.controlMaxBodyBytes ?? 64 * 1024;
  const identity = deps.identity ?? {
    version: "test",
    releaseCommit: "development",
    configRevision: "test",
    bootEpoch: deps.control.getBootEpoch(),
  };
  const executionGate = deps.executionGate ?? new ExecutionGate({
    now: deps.now,
    onState: (runtime, state) => {
      deps.metrics?.setGauge("execution_active", { runtime }, state.active);
      deps.metrics?.setGauge("execution_queued", { runtime }, state.queued);
    },
    onEvent: (event) => {
      deps.metrics?.record(event);
      deps.onEvent?.(event);
    },
  });
  const semanticReadiness = new SemanticReadiness({
    control: deps.control,
    getRegistry: () => deps.registry,
    executionGate,
    timeoutMs: deps.providerProbeTimeoutMs ?? 15_000,
    fetchImpl: deps.gatewayFetch,
    now: deps.now,
  });
  const agentConnections = deps.agentConnectionController ?? (deps.connectionSigningKey
    ? new AgentConnectionController({
      control: deps.control,
      getCatalog: () => deps.agentConnectionCatalog,
      getCatalogRevision: () => deps.getConfigRevision?.() ?? identity.configRevision,
      semantic: semanticReadiness,
      tokenCodec: new ConnectionTokenCodec(deps.connectionSigningKey, deps.now),
      readyTimeoutMs: deps.connectionReadyTimeoutMs ?? 120_000,
      pollIntervalMs: deps.connectionPollIntervalMs ?? 500,
      idempotencyTtlMs: deps.idempotencyTtlMs ?? 300_000,
      idempotencyLimit: deps.idempotencyLimit ?? 1_000,
      historyLimit: deps.connectionHistoryLimit ?? 1_000,
      now: deps.now,
      random: deps.random,
    })
    : undefined);
  const modelBroker = deps.modelBroker ?? (deps.agentConnectionCatalog
    ? new ModelBroker(deps.control, deps.agentConnectionCatalog, {
      startupTimeoutMs: deps.connectionReadyTimeoutMs ?? 120_000,
      pollIntervalMs: deps.connectionPollIntervalMs ?? 50,
      leaseTtlSeconds: Math.min(
        86_400,
        Math.max(1, Math.ceil(((deps.connectionReadyTimeoutMs ?? 120_000) + (deps.gatewayTimeoutMs ?? 300_000)) / 1_000) + 60),
      ),
      now: deps.now,
      onEvent: deps.onEvent,
    })
    : undefined);
  type AllocationApiResult = {
    status: 200 | 202 | 400 | 403 | 404 | 409 | 503;
    body: unknown;
  };
  const idempotency = new Map<string, {
    requestHash: string;
    result: Promise<AllocationApiResult>;
    expiresAt: number;
    settled: boolean;
  }>();
  let lastObservedActivityState: ServiceActivityState | undefined;
  const pruneIdempotency = () => {
    const now = deps.now?.() ?? Date.now();
    for (const [key, entry] of idempotency) {
      if (entry.settled && entry.expiresAt <= now) {
        idempotency.delete(key);
      }
    }
  };

  app.onError((err, c) => {
    if (err instanceof RequestBodyError) {
      return c.json(errorBody(err.code, err.message), err.status);
    }
    console.error(`request handler failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.json(errorBody("internal_error", "internal server error"), 500);
  });

  app.use("*", async (c, next) => {
    c.header("x-larm-boot-epoch", identity.bootEpoch);
    c.header("x-larm-config-revision", deps.getConfigRevision?.() ?? identity.configRevision);
    if (c.req.path === "/v1/activity") c.header("cache-control", "no-store");
    const publicPath = c.req.path === "/health" || c.req.path === "/ready";
    const anonymousAgentConnection = deps.allowAnonymousAgentConnections === true
      && acceptsAnonymousAgentApi(c.req.method, c.req.path);
    const anonymousServiceHarness = deps.serviceHarnessAuthEnabled !== true
      && c.req.header("authorization") === undefined
      && isServiceHarnessRequest(
        c.req.method,
        c.req.path,
        c.req.header("x-larm-allocation-id"),
      );
    if (deps.apiToken && !publicPath && !anonymousAgentConnection && !anonymousServiceHarness) {
      const expected = `Bearer ${deps.apiToken}`;
      const authorization = c.req.header("authorization");
      const providerBearer = authorization?.startsWith("Bearer larm_conn_v1.") === true
        && acceptsProviderBearer(c.req.method, c.req.path);
      if (!secretMatches(authorization, expected) && !providerBearer) {
        return c.json(errorBody("unauthorized", "valid bearer token required"), 401);
      }
    }
    await next();
  });

  const agentFeature = (c: Context): AgentConnectionController | Response => {
    if (!deps.apiToken) {
      return c.json(errorBody(
        "connection_auth_not_configured",
        "LARM_API_TOKEN is required for agent connection APIs",
      ), 503);
    }
    if (!agentConnections) {
      return c.json(errorBody(
        "connection_credentials_unavailable",
        "LARM_CONNECTION_SIGNING_KEY is required for agent connection APIs",
      ), 503);
    }
    if (!deps.agentConnectionCatalog) {
      return c.json(errorBody(
        "agent_connections_not_configured",
        "agent connection catalog is unavailable",
      ), 503);
    }
    return agentConnections;
  };
  const principal = () => agentPrincipal(deps.apiToken!);
  const contextFeature = (c: Context): ContextController | Response => {
    if (!deps.apiToken) {
      return c.json(errorBody(
        "context_auth_not_configured",
        "LARM_API_TOKEN is required for context APIs",
      ), 503);
    }
    if (!deps.contextController) {
      return c.json(errorBody(
        "context_not_configured",
        "managed context is not configured",
      ), 503);
    }
    return deps.contextController;
  };

  const contextError = (c: Context, error: unknown): Response => {
    if (error instanceof ContextControllerError) {
      return c.json(errorBody(error.code, error.message), error.status);
    }
    throw error;
  };

  const requireManagement: MiddlewareHandler = async (c, next) => {
    if (!deps.managementToken) {
      return c.json(errorBody("management_not_configured", "management API is disabled"), 503);
    }
    if (!secretMatches(c.req.header("x-larm-management-token"), deps.managementToken)) {
      return c.json(errorBody("forbidden", "valid management token required"), 403);
    }
    if (deps.control.isDraining()) {
      return c.json(errorBody("draining", "control plane is draining"), 503);
    }
    await next();
  };
  app.use("/v1/artifacts/*", requireManagement);
  app.use("/v1/deployments/*", requireManagement);
  app.use("/v1/artifact-operations/*", requireManagement);
  app.use("/v1/runtime-releases", requireManagement);
  app.use("/v1/runtime-releases/*", requireManagement);
  app.use("/v1/inspection/*", requireManagement);

  const handleGateway = async (
    c: Context,
    options: {
      protocol: RuntimeProtocol;
      upstreamPath: string;
      bodyMode: "buffered" | "stream" | "none";
      maxBodyBytes: number;
      capability?: string;
    },
  ): Promise<Response> => {
    if (deps.control.isDraining()) {
      return c.json(errorBody("draining", "control plane is draining"), 503);
    }
    const declaredAllocationId = c.req.header("x-larm-allocation-id");
    const contextViewId = c.req.header("x-larm-context-view-id");
    if (contextViewId !== undefined) {
      if (options.protocol !== "openai.chat-completions.v1") {
        return c.json(errorBody("context_request_invalid", "context views are valid only for Chat Completions"), 400);
      }
      if (!/^view_[a-zA-Z0-9._-]{1,186}$/.test(contextViewId)) {
        return c.json(errorBody("context_request_invalid", "x-larm-context-view-id is invalid"), 400);
      }
      if (declaredAllocationId === undefined) {
        return c.json(errorBody("allocation_required", "context views require x-larm-allocation-id"), 400);
      }
    }
    const authorization = c.req.header("authorization");
    const providerToken = authorization?.startsWith("Bearer larm_conn_v1.")
      ? authorization.slice(7)
      : undefined;
    let scoped: VerifiedProviderToken | undefined;
    if (providerToken) {
      const feature = agentFeature(c);
      if (feature instanceof Response) return feature;
      try {
        scoped = feature.verifyProviderToken(providerToken);
      } catch (error) {
        if (error instanceof ConnectionTokenError) {
          return c.json(errorBody("unauthorized", error.message), 401);
        }
        throw error;
      }
      if (scoped.provider.protocol !== options.protocol) {
        return c.json(errorBody("connection_forbidden", "provider token is not valid for this endpoint"), 403);
      }
      if (declaredAllocationId !== undefined && declaredAllocationId !== scoped.record.allocationId) {
        return c.json(errorBody("connection_forbidden", "allocation header does not match provider token"), 403);
      }
      const declaredCapability = c.req.header("x-larm-capability");
      if (declaredCapability !== undefined && declaredCapability !== scoped.provider.capability) {
        return c.json(errorBody("connection_forbidden", "capability header does not match provider token"), 403);
      }
    }
    if (options.protocol === "larm.embedding.v1" && !scoped) {
      return c.json(errorBody(
        "connection_provider_token_required",
        "embedding requests require a claimed provider bearer token",
      ), 401);
    }
    let chatRequest: unknown;
    let chatRequestBytes: Uint8Array | undefined;
    let chatResponseFormat: "sse" | undefined;
    let embeddingRequest: EmbeddingRequest | undefined;
    let embeddingRequestBytes: Uint8Array | undefined;
    if (options.protocol === "larm.embedding.v1") {
      try {
        const bytes = await readBodyLimited(c.req.raw.clone() as unknown as Request, options.maxBodyBytes);
        const parsed = embeddingRequestSchema.safeParse(JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ));
        if (!parsed.success) {
          return c.json(errorBody(
            "invalid_embedding_request",
            "texts, explicit type, normalize=true, and priority are required",
          ), 400);
        }
        embeddingRequest = parsed.data;
        embeddingRequestBytes = new TextEncoder().encode(JSON.stringify(parsed.data));
      } catch (error) {
        if (error instanceof RequestBodyError) {
          return c.json(errorBody(error.code, error.message), error.status);
        }
        return c.json(errorBody("bad_request", "request body must be valid UTF-8 JSON"), 400);
      }
    }
    if (options.protocol === "openai.chat-completions.v1") {
      try {
        const bytes = await readBodyLimited(c.req.raw.clone() as unknown as Request, options.maxBodyBytes);
        chatRequestBytes = bytes;
        chatRequest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
        if (
          chatRequest
          && typeof chatRequest === "object"
          && !Array.isArray(chatRequest)
          && (chatRequest as Record<string, unknown>).stream === true
        ) {
          chatResponseFormat = "sse";
        }
      } catch (error) {
        if (error instanceof RequestBodyError) {
          return c.json(errorBody(error.code, error.message), error.status);
        }
        return c.json(errorBody("bad_request", "request body must be valid UTF-8 JSON"), 400);
      }
    }
    let directModel: string | undefined;
    let directRequestBytes: Uint8Array | undefined;
    let directSpeechFormat: string | undefined;
    if (!scoped && declaredAllocationId === undefined && modelBroker) {
      if (options.protocol === "openai.audio-speech.v1") {
        try {
          directRequestBytes = await readBodyLimited(
            c.req.raw.clone() as unknown as Request,
            options.maxBodyBytes,
          );
          const parsed = audioSpeechRequestSchema.safeParse(JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(directRequestBytes),
          ));
          if (!parsed.success) {
            return c.json(openAiErrorBody(
              "invalid_request",
              "model and input are required",
              parsed.error.issues.some((issue) => issue.path[0] === "model") ? "model" : null,
            ), 400);
          }
          directModel = parsed.data.model;
          directSpeechFormat = parsed.data.response_format;
        } catch (error) {
          if (error instanceof RequestBodyError) {
            return c.json(openAiErrorBody(error.code, error.message), error.status);
          }
          return c.json(openAiErrorBody("invalid_request", "request body must be valid UTF-8 JSON"), 400);
        }
      } else if (options.protocol === "openai.audio-transcriptions.v1") {
        try {
          directRequestBytes = await readBodyLimited(
            c.req.raw.clone() as unknown as Request,
            options.maxBodyBytes,
          );
          const parsedRequest = new Response(directRequestBytes, {
            headers: { "content-type": c.req.header("content-type") ?? "" },
          });
          const form = await parsedRequest.formData();
          const models = form.getAll("model");
          const files = form.getAll("file");
          if (
            models.length !== 1
            || typeof models[0] !== "string"
            || models[0].length === 0
          ) {
            return c.json(openAiErrorBody("invalid_request", "exactly one model field is required", "model"), 400);
          }
          if (files.length !== 1 || !(files[0] instanceof Blob) || files[0].size === 0) {
            return c.json(openAiErrorBody("invalid_request", "exactly one non-empty file is required", "file"), 400);
          }
          directModel = models[0];
        } catch (error) {
          if (error instanceof RequestBodyError) {
            return c.json(openAiErrorBody(error.code, error.message), error.status);
          }
          return c.json(openAiErrorBody("invalid_request", "request must be valid multipart form data"), 400);
        }
      }
    }
    if (scoped) {
      try {
        let modelValues: unknown[];
        if (options.protocol === "larm.embedding.v1") {
          modelValues = [scoped.provider.publicModel];
        } else if (options.protocol === "openai.chat-completions.v1") {
          modelValues = typeof chatRequest === "object" && chatRequest !== null && !Array.isArray(chatRequest)
            ? [(chatRequest as Record<string, unknown>).model]
            : [];
        } else {
          const clone = c.req.raw.clone();
          const bytes = await readBodyLimited(clone as unknown as Request, options.maxBodyBytes);
          if (options.protocol === "openai.audio-transcriptions.v1") {
            const parsedRequest = new Response(bytes, {
              headers: {
                "content-type": clone.headers.get("content-type") ?? "",
              },
            });
            const form = await parsedRequest.formData();
            modelValues = form.getAll("model");
          } else {
            let value: unknown;
            try {
              value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
            } catch {
              return c.json(errorBody("bad_request", "request body must be valid UTF-8 JSON"), 400);
            }
            modelValues = typeof value === "object" && value !== null && !Array.isArray(value)
              ? [(value as Record<string, unknown>).model]
              : [];
          }
        }
        if (
          modelValues.length !== 1
          || typeof modelValues[0] !== "string"
          || modelValues[0] !== scoped.provider.publicModel
        ) {
          return c.json(errorBody(
            "model_mismatch",
            `model must equal ${scoped.provider.publicModel}`,
          ), 400);
        }
      } catch (error) {
        if (error instanceof RequestBodyError) {
          return c.json(errorBody(error.code, error.message), error.status);
        }
        return c.json(errorBody("bad_request", "request body could not be validated"), 400);
      }
    }
    if (
      !scoped
      && declaredAllocationId === undefined
      && modelBroker
      && options.bodyMode !== "none"
    ) {
      if (options.protocol === "openai.chat-completions.v1") {
        const parsed = chatCompletionRequestSchema.safeParse(chatRequest);
        if (!parsed.success) {
          return c.json(openAiErrorBody(
            "invalid_request",
            "model and messages are required",
            parsed.error.issues.some((issue) => issue.path[0] === "model") ? "model" : null,
          ), 400);
        }
        directModel = parsed.data.model;
        directRequestBytes = chatRequestBytes;
      }
      if (!directModel || !directRequestBytes) {
        return c.json(openAiErrorBody(
          "invalid_request",
          "a model is required for this endpoint",
          "model",
        ), 400);
      }
      let lease;
      try {
        lease = await modelBroker.acquire(directModel, options.protocol, c.req.raw.signal);
      } catch (error) {
        if (error instanceof ModelBrokerError) {
          if (error.retryAfterSeconds) c.header("retry-after", String(error.retryAfterSeconds));
          return c.json(openAiErrorBody(
            error.code,
            error.message,
            error.code === "model_not_found" ? "model" : null,
          ), error.status);
        }
        throw error;
      }
      const runtime = getRuntime(deps.registry, lease.runtime);
      if (!runtime || runtime.protocol !== options.protocol) {
        await lease.close();
        return c.json(openAiErrorBody(
          "model_unavailable",
          "resolved model runtime does not support Chat Completions",
          "model",
        ), 503);
      }
      try {
        return await proxyGateway({
          request: c.req.raw,
          requestBody: directRequestBytes,
          allocationId: lease.allocationId,
          protocol: options.protocol,
          upstreamPath: options.upstreamPath,
          runtime,
          bodyMode: "buffered",
          maxBodyBytes: options.maxBodyBytes,
          timeoutMs: deps.gatewayTimeoutMs ?? 300_000,
          bootEpoch: identity.bootEpoch,
          executionGate,
          fetchImpl: deps.gatewayFetch,
          metrics: deps.metrics,
          requestTracker: deps.requestTracker,
          lifecycleSignal: lease.lifecycleSignal,
          priority: lease.priority,
          now: deps.now,
          random: deps.random,
          onEvent: deps.onEvent,
          inferenceAuditMode: deps.inferenceAuditMode,
          inferenceAuditRecorder: deps.inferenceAuditRecorder,
          auditContext: {
            capability: lease.capability,
            route: lease.route,
            ...(lease.release ? { runtimeRelease: lease.release } : {}),
            configRevision: lease.catalogRevision
              ?? deps.getConfigRevision?.()
              ?? identity.configRevision,
          },
          responseFormat: chatResponseFormat,
          validateChatResponse: options.protocol === "openai.chat-completions.v1",
          validateTranscriptionResponse: options.protocol === "openai.audio-transcriptions.v1",
          validateSpeechResponse: options.protocol === "openai.audio-speech.v1",
          expectedSpeechFormat: directSpeechFormat,
          expectedModel: directModel,
          errorFormat: "openai",
          onFinish: () => lease.close(),
          revalidate: () => {
            const current = deps.control.resolveAllocation(lease.allocationId, lease.capability);
            if (current.status !== 200 || !("endpoint" in current.body)) {
              return {
                ok: false,
                status: current.status,
                body: openAiErrorBody("model_unavailable", "model binding is no longer ready", "model"),
              };
            }
            if (current.body.runtime !== lease.runtime || current.body.endpoint !== lease.endpoint) {
              return {
                ok: false,
                status: 409,
                body: openAiErrorBody("model_binding_changed", "model binding changed", "model"),
              };
            }
            return { ok: true, binding: current.body };
          },
        });
      } catch (error) {
        await lease.close();
        throw error;
      }
    }
    const allocationId = scoped?.record.allocationId ?? declaredAllocationId;
    if (allocationId === undefined) {
      return c.json(errorBody("allocation_required", "x-larm-allocation-id is required"), 400);
    }
    if (!/^alloc_[a-zA-Z0-9._-]{1,186}$/.test(allocationId)) {
      return c.json(errorBody("bad_request", "x-larm-allocation-id is invalid"), 400);
    }
    const requestedCapability = scoped?.provider.capability
      ?? options.capability
      ?? c.req.header("x-larm-capability");
    if (
      requestedCapability !== undefined
      && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(requestedCapability)
    ) {
      return c.json(errorBody("bad_request", "x-larm-capability is invalid"), 400);
    }
    const allocation = deps.control.getAllocation(allocationId);
    if (!allocation) {
      const missing = deps.control.allocationLookupError(allocationId);
      return c.json(missing.body, missing.status);
    }
    const selected = selectProtocolBinding({
      registry: deps.registry,
      allocation,
      protocol: options.protocol,
      capability: requestedCapability,
    });
    if (!selected.ok) {
      const status = selected.reason === "capability_not_allocated"
        || selected.reason === "protocol_not_allocated"
        ? 404
        : 409;
      return c.json(errorBody(selected.reason, selected.reason.replaceAll("_", " ")), status);
    }
    const resolved = deps.control.resolveAllocation(allocationId, selected.binding.capability);
    if (resolved.status !== 200 || !("endpoint" in resolved.body)) {
      return c.json(resolved.body, resolved.status as 404 | 409 | 503);
    }
    const runtime = getRuntime(deps.registry, resolved.body.runtime);
    if (!runtime || runtime.protocol !== options.protocol) {
      return c.json(errorBody("protocol_mismatch", "allocated runtime protocol does not match"), 409);
    }
    if (
      options.protocol === "openai.chat-completions.v1"
      && !contextViewId
      && runtime.context?.class === "managed-context"
    ) {
      const event = { name: "context_bypass", labels: { reason: "view_not_requested" } };
      deps.metrics?.record(event);
      deps.onEvent?.(event);
    }
    const release = selected.binding.release;
    if (contextViewId && !release) {
      return c.json(errorBody("context_view_stale", "allocated runtime has no release binding"), 409);
    }
    if (options.protocol === "larm.embedding.v1") {
      if (
        !embeddingRequest
        || !embeddingRequestBytes
        || !scoped?.provider.embeddingSpace
        || !runtime.embedding
        || JSON.stringify(scoped.provider.embeddingSpace) !== JSON.stringify(runtime.embedding)
      ) {
        return c.json(errorBody(
          "embedding_space_mismatch",
          "claimed and resolved embedding spaces do not match",
        ), 409);
      }
    }

    return await proxyGateway({
      request: c.req.raw,
      ...((embeddingRequestBytes ?? chatRequestBytes)
        ? { requestBody: embeddingRequestBytes ?? chatRequestBytes }
        : {}),
      ...(contextViewId
        ? {
          prepareRequestBody: async (body: Uint8Array, signal: AbortSignal) => {
            const feature = contextFeature(c);
            if (feature instanceof Response) {
              throw new GatewayRequestPreparationError(
                feature.status,
                "context_not_configured",
                "managed context is not configured",
              );
            }
            try {
              return await feature.prepareChatRequest({
                viewId: contextViewId,
                principal: principal(),
                allocationId,
                runtime: runtime.id,
                release: release!,
                requestBody: body,
                signal,
              });
            } catch (error) {
              if (error instanceof ContextControllerError) {
                throw new GatewayRequestPreparationError(error.status, error.code, error.message);
              }
              throw error;
            }
          },
          onTerminal: async (result: { outcome: string; upstreamStatus?: number }) => {
            const feature = contextFeature(c);
            if (feature instanceof Response) return;
            await feature.finishChat(
              contextViewId,
              result.outcome === "http_200" && result.upstreamStatus === 200,
            );
          },
        }
        : {}),
      allocationId,
      protocol: options.protocol,
      upstreamPath: options.upstreamPath,
      runtime,
      bodyMode: options.bodyMode,
      maxBodyBytes: options.maxBodyBytes,
      timeoutMs: deps.gatewayTimeoutMs ?? 300_000,
      bootEpoch: identity.bootEpoch,
      executionGate,
      fetchImpl: deps.gatewayFetch,
      metrics: deps.metrics,
      requestTracker: deps.requestTracker,
      lifecycleSignal: deps.control.getAllocationSignal(allocationId),
      priority: allocation.priority ?? 0,
      now: deps.now,
      random: deps.random,
      onEvent: deps.onEvent,
      inferenceAuditMode: deps.inferenceAuditMode,
      inferenceAuditRecorder: deps.inferenceAuditRecorder,
      auditContext: {
        capability: selected.binding.capability,
        route: selected.binding.route,
        ...(selected.binding.release ? { runtimeRelease: selected.binding.release } : {}),
        configRevision: allocation.catalogRevision
          ?? deps.getConfigRevision?.()
          ?? identity.configRevision,
      },
      responseFormat: chatResponseFormat,
      validateTranscriptionResponse: options.protocol === "openai.audio-transcriptions.v1",
      validateSpeechResponse: options.protocol === "openai.audio-speech.v1",
      ...(embeddingRequest && runtime.embedding
        ? { validateEmbeddingResponse: { request: embeddingRequest, space: runtime.embedding } }
        : {}),
      revalidate: () => {
        if (providerToken && agentConnections) {
          try {
            const latest = agentConnections.verifyProviderToken(providerToken);
            if (
              latest.record.allocationId !== allocationId
              || latest.provider.capability !== selected.binding.capability
              || latest.provider.protocol !== options.protocol
            ) {
              return {
                ok: false as const,
                status: 403,
                body: errorBody("connection_forbidden", "provider token scope changed"),
              };
            }
          } catch (error) {
            return {
              ok: false as const,
              status: 401,
              body: errorBody(
                "unauthorized",
                "provider bearer token is no longer valid",
              ),
            };
          }
        }
        const current = deps.control.resolveAllocation(allocationId, selected.binding.capability);
        if (current.status !== 200 || !("endpoint" in current.body)) {
          return { ok: false, status: current.status, body: current.body };
        }
        return { ok: true, binding: current.body };
      },
    });
  };

  const serviceHarnessAsrBinding = () => {
    const runtime = getRuntime(deps.registry, SERVICE_HARNESS_ASR_RUNTIME);
    if (
      !runtime
      || runtime.protocol !== "openai.audio-transcriptions.v1"
      || !runtime.capability.includes("speech.stt")
    ) {
      return undefined;
    }
    const snapshot = deps.getState().runtimes.find((candidate) => candidate.id === runtime.id);
    if (!snapshot || (snapshot.status !== "HOT" && snapshot.status !== "BUSY")) {
      return undefined;
    }
    return {
      runtime,
      binding: {
        endpoint: runtime.deployment.endpoint,
        runtime: runtime.id,
      },
    };
  };

  const handleServiceHarnessTranscription = async (c: Context): Promise<Response> => {
    const selected = serviceHarnessAsrBinding();
    if (!selected) {
      return c.json(errorBody("asr_unavailable", "ASR service is not ready"), 503);
    }
    return await proxyGateway({
      request: c.req.raw,
      allocationId: SERVICE_HARNESS_ALLOCATION_ID,
      protocol: "openai.audio-transcriptions.v1",
      upstreamPath: "/v1/audio/transcriptions",
      runtime: selected.runtime,
      bodyMode: "stream",
      maxBodyBytes: deps.speechMaxBodyBytes ?? 257 * 1024 * 1024,
      timeoutMs: deps.gatewayTimeoutMs ?? 300_000,
      bootEpoch: identity.bootEpoch,
      executionGate,
      fetchImpl: deps.gatewayFetch,
      metrics: deps.metrics,
      requestTracker: deps.requestTracker,
      now: deps.now,
      random: deps.random,
      onEvent: deps.onEvent,
      revalidate: () => {
        const current = serviceHarnessAsrBinding();
        if (!current) {
          return {
            ok: false as const,
            status: 503,
            body: errorBody("asr_unavailable", "ASR service is not ready"),
          };
        }
        return { ok: true as const, binding: current.binding };
      },
    });
  };

  app.get("/health", (c) => c.json({
    status: "ok",
    version: identity.version,
    releaseCommit: identity.releaseCommit,
    configRevision: deps.getConfigRevision?.() ?? identity.configRevision,
    bootEpoch: identity.bootEpoch,
  }));

  app.get("/v1/release-convergence", async (c) => {
    c.header("cache-control", "no-store");
    if (!deps.getReleaseConvergenceStatus) {
      return c.json(errorBody("release_convergence_unavailable", "release convergence status is not configured"), 503);
    }
    try {
      const parsed = releaseConvergenceStatusSchema.safeParse(await deps.getReleaseConvergenceStatus());
      if (!parsed.success) {
        return c.json(errorBody("release_convergence_invalid", "release convergence status is invalid"), 503);
      }
      return c.json(parsed.data);
    } catch {
      return c.json(errorBody("release_convergence_unavailable", "release convergence status is unavailable"), 503);
    }
  });

  app.get("/ready", (c) => {
    const generated = Date.parse(deps.getState().generatedAt);
    const age = (deps.now?.() ?? Date.now()) - generated;
    if (deps.control.isDraining()) {
      return c.json({ status: "draining" }, 503);
    }
    if (!Number.isFinite(age) || age < 0 || age > (deps.stateMaxAgeMs ?? 10_000)) {
      return c.json({ status: "stale", ageMs: age }, 503);
    }
    return c.json({ status: "ready" });
  });

  app.get("/v1/activity", (c) => {
    if (new URL(c.req.url).search || c.req.raw.body !== null) {
      return c.json(errorBody("invalid_request", "activity request cannot use query parameters or a body"), 400);
    }
    if (!deps.requestTracker) {
      c.header("retry-after", "1");
      return c.json(errorBody("activity_unavailable", "service activity tracking is unavailable"), 503);
    }
    const startedAt = performance.now();
    const activity = createServiceActivity({
      httpActiveWorkloads: deps.requestTracker.count(),
      draining: deps.control.isDraining(),
      observedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
      bootEpoch: identity.bootEpoch,
      configRevision: deps.getConfigRevision?.() ?? identity.configRevision,
    });
    deps.metrics?.setGauge("service_activity_observed_active_workloads", {}, activity.activeWorkloads);
    deps.metrics?.record({
      name: "service_activity_observation_seconds",
      labels: { state: activity.state },
      value: Math.max(0, (performance.now() - startedAt) / 1_000),
    });
    if (activity.state !== lastObservedActivityState) {
      lastObservedActivityState = activity.state;
      deps.onEvent?.({
        name: "service_activity_observed_state_changed",
        labels: { state: activity.state },
        value: activity.activeWorkloads,
      });
    }
    if (activity.retryAfterMs > 0) {
      c.header("retry-after", String(Math.max(1, Math.ceil(activity.retryAfterMs / 1_000))));
    }
    return c.json(activity);
  });

  app.get("/metrics", (c) => c.text(deps.metrics?.render() ?? ""));

  app.get("/openapi.json", (c) => c.json(createOpenApiDocument(identity.version)));

  app.get("/v1/services", (c) => {
    c.header("cache-control", "no-store");
    const origin = new URL(c.req.url).origin;
    const asr = getRuntime(deps.registry, SERVICE_HARNESS_ASR_RUNTIME);
    return c.json({
      contractVersion: SAAA_SERVICE_HARNESS_CONTRACT_VERSION,
      revision: deps.getConfigRevision?.() ?? identity.configRevision,
      services: asr
        && asr.protocol === "openai.audio-transcriptions.v1"
        && asr.capability.includes("speech.stt")
        ? [{
          capability: "asr" as const,
          protocol: "openai.audio-transcriptions.v1" as const,
          baseUrl: `${origin}/v1`,
          model: SERVICE_HARNESS_ASR_MODEL,
          language: "auto" as const,
          healthUrl: `${origin}/v1/services/asr/health`,
        }]
        : [],
    });
  });

  app.get("/v1/services/asr/health", (c) => {
    c.header("cache-control", "no-store");
    if (!serviceHarnessAsrBinding()) {
      return c.json(errorBody("asr_unavailable", "ASR service is not ready"), 503);
    }
    return c.json({ status: "ok" as const, model: SERVICE_HARNESS_ASR_MODEL });
  });

  app.get("/v1/context-status", (c) => {
    const feature = contextFeature(c);
    if (feature instanceof Response) return feature;
    c.header("cache-control", "no-store");
    return c.json(feature.statuses(principal()));
  });

  app.post("/v1/contexts", async (c) => {
    const feature = contextFeature(c);
    if (feature instanceof Response) return feature;
    const key = idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = contextRegistrationRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("context_request_invalid", "invalid context descriptor"), 400);
    }
    try {
      const result = await feature.register(parsed.data, principal(), key);
      if (result.replay) c.header("x-larm-idempotent-replay", "true");
      c.header("location", `/v1/contexts/${encodeURIComponent(result.descriptor.id)}`);
      return c.json(result.descriptor, result.replay ? 200 : 201);
    } catch (error) {
      return contextError(c, error);
    }
  });

  app.get("/v1/contexts", (c) => {
    const feature = contextFeature(c);
    if (feature instanceof Response) return feature;
    try {
      const rawLimit = c.req.query("limit");
      return c.json(feature.list(principal(), {
        ...(c.req.query("cursor") ? { cursor: c.req.query("cursor") } : {}),
        ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}),
      }));
    } catch (error) {
      return contextError(c, error);
    }
  });

  app.delete("/v1/contexts/:id", async (c) => {
    const feature = contextFeature(c);
    if (feature instanceof Response) return feature;
    const key = idempotencyKey(c);
    if (key instanceof Response) return key;
    try {
      const result = await feature.delete(principal(), c.req.param("id"), key);
      if (result.replay) c.header("x-larm-idempotent-replay", "true");
      return c.body(null, 204);
    } catch (error) {
      return contextError(c, error);
    }
  });

  app.post("/v1/context-views", async (c) => {
    const feature = contextFeature(c);
    if (feature instanceof Response) return feature;
    const key = idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = contextViewRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("context_request_invalid", "invalid context view request"), 400);
    }
    try {
      const result = await feature.createView(parsed.data, principal(), key);
      if (result.replay) c.header("x-larm-idempotent-replay", "true");
      c.header("location", `/v1/context-views/${encodeURIComponent(result.view.id)}`);
      return c.json(result.view, result.replay ? 200 : 201);
    } catch (error) {
      return contextError(c, error);
    }
  });

  app.get("/v1/context-operations/:id", (c) => {
    const feature = contextFeature(c);
    if (feature instanceof Response) return feature;
    try {
      c.header("cache-control", "no-store");
      return c.json(feature.getOperation(principal(), c.req.param("id")));
    } catch (error) {
      return contextError(c, error);
    }
  });

  const agentResult = (c: Context, result: {
    status: number;
    body: unknown;
    replay?: boolean;
    location?: string;
  }): Response => {
    if (result.replay) c.header("x-larm-idempotent-replay", "true");
    if (result.location) c.header("location", result.location);
    if (result.status === 202 || result.status === 503) c.header("retry-after", "1");
    if (result.status === 204) return c.body(null, 204);
    return c.json(result.body, result.status as 200 | 201 | 202 | 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503);
  };
  const idempotencyKey = (c: Context): string | Response => {
    const value = c.req.header("idempotency-key");
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
      return c.json(errorBody("invalid_request", "a valid Idempotency-Key is required"), 400);
    }
    return value;
  };

  app.get("/v1/agent-profiles", (c) => {
    const feature = agentFeature(c);
    if (feature instanceof Response) return feature;
    const result = feature.listProfilesV1();
    if (result.status === 200) {
      deps.onEvent?.({ name: "agent_profile_catalog_served", labels: { contract: "agent-connection.v1" } });
    }
    return agentResult(c, result);
  });

  app.get("/v2/agent-profiles", (c) => {
    const feature = agentFeature(c);
    if (feature instanceof Response) return feature;
    const result = feature.listProfilesV2();
    if (result.status === 200) {
      deps.onEvent?.({ name: "agent_profile_catalog_served", labels: { contract: "agent-connection.v2" } });
    }
    return agentResult(c, result);
  });

  app.get("/v3/agent-profiles", (c) => {
    const feature = agentFeature(c);
    if (feature instanceof Response) return feature;
    const result = feature.listProfilesV3();
    if (result.status === 200) {
      deps.onEvent?.({ name: "agent_profile_catalog_served", labels: { contract: "agent-connection.v3" } });
    }
    return agentResult(c, result);
  });

  app.post("/v1/agent-connections", async (c) => {
    const feature = agentFeature(c);
    if (feature instanceof Response) return feature;
    const key = idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = agentConnectionRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) return c.json(errorBody("invalid_request", "invalid agent connection request"), 400);
    if (parsed.data.deploymentPolicy === "allow-listed") {
      if (!deps.managementToken) {
        return c.json(errorBody("management_not_configured", "allow-listed deployment is disabled"), 503);
      }
      if (!secretMatches(c.req.header("x-larm-management-token"), deps.managementToken)) {
        return c.json(errorBody("forbidden", "valid management token required for deployment"), 403);
      }
    }
    const result = await feature.create(parsed.data, principal(), key, c.req.url);
    const catalog = deps.agentConnectionCatalog;
    const selectedProfile = parsed.data.agentProfile ?? catalog?.defaultAgentProfile;
    const errorCode = typeof result.body === "object" && result.body !== null && "error" in result.body
      && typeof result.body.error === "object" && result.body.error !== null && "code" in result.body.error
      ? String(result.body.error.code)
      : undefined;
    deps.onEvent?.({
      name: result.status === 201 || result.status === 202
        ? "agent_connection_create_accepted"
        : "agent_connection_create_rejected",
      labels: {
        requestedProfile: parsed.data.agentProfile ?? "(default)",
        canonicalProfile: catalog?.profiles.find((profile) => profile.id === selectedProfile)
          ?.canonicalProfile ?? "(unknown)",
        status: String(result.status),
        ...(errorCode ? { code: errorCode } : {}),
      },
    });
    return agentResult(c, result);
  });

  app.get("/v1/agent-connections/:id", (c) => {
    const feature = agentFeature(c);
    if (feature instanceof Response) return feature;
    return agentResult(c, feature.get(c.req.param("id"), principal()));
  });

  app.get("/v1/agent-connections/:id/health", async (c) => {
    const feature = agentFeature(c);
    if (feature instanceof Response) return feature;
    c.header("cache-control", "no-store");
    const result = await feature.health(c.req.param("id"), principal());
    deps.onEvent?.({
      name: "agent_connection_health_checked",
      labels: { status: String(result.status) },
    });
    return agentResult(c, result);
  });

  app.get("/v1/agent-connections/:id/providers/:name/health", async (c) => {
    const feature = agentFeature(c);
    if (feature instanceof Response) return feature;
    c.header("cache-control", "no-store");
    const authorization = c.req.header("authorization");
    if (secretMatches(authorization, `Bearer ${deps.apiToken}`)) {
      return agentResult(c, await feature.providerHealth(
        c.req.param("id"),
        c.req.param("name"),
        principal(),
      ));
    }
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    try {
      const verified = feature.verifyProviderToken(token);
      if (verified.record.id !== c.req.param("id") || verified.provider.name !== c.req.param("name")) {
        return c.json(errorBody(
          "connection_forbidden",
          "provider token scope does not match this health endpoint",
        ), 403);
      }
      return agentResult(c, await feature.providerHealth(c.req.param("id"), c.req.param("name")));
    } catch (error) {
      if (error instanceof ConnectionTokenError) {
        return c.json(errorBody("unauthorized", error.message), 401);
      }
      throw error;
    }
  });

  app.post("/v1/agent-connections/:id/claim", async (c) => {
    const feature = agentFeature(c);
    if (feature instanceof Response) return feature;
    if (c.req.header("idempotency-key") !== undefined) {
      return c.json(errorBody("invalid_request", "claim does not accept Idempotency-Key"), 400);
    }
    const parsed = agentConnectionClaimRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) return c.json(errorBody("invalid_request", "invalid claim request"), 400);
    const result = await feature.claim(c.req.param("id"), principal(), parsed.data.format);
    const providers = typeof result.body === "object" && result.body !== null && "providers" in result.body
      && Array.isArray(result.body.providers)
      ? result.body.providers
      : [];
    deps.onEvent?.({
      name: result.status === 200
        ? "agent_connection_claim_accepted"
        : "agent_connection_claim_rejected",
      labels: {
        status: String(result.status),
        providers: String(providers.length),
      },
    });
    return agentResult(c, result);
  });

  app.post("/v1/agent-connections/:id/renew", async (c) => {
    const feature = agentFeature(c);
    if (feature instanceof Response) return feature;
    const key = idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = agentConnectionRenewRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) return c.json(errorBody("invalid_request", "invalid renewal request"), 400);
    return agentResult(c, await feature.renew(
      c.req.param("id"),
      parsed.data.ttlSeconds,
      principal(),
      key,
    ));
  });

  app.delete("/v1/agent-connections/:id", async (c) => {
    const feature = agentFeature(c);
    if (feature instanceof Response) return feature;
    const result = await feature.release(c.req.param("id"), principal());
    deps.onEvent?.({
      name: "agent_connection_release_completed",
      labels: { status: String(result.status) },
    });
    return agentResult(c, result);
  });

  app.get("/runtimes", (c) => {
    return c.json({
      runtimes: deps.registry.runtimes.map(publicRuntime),
    });
  });

  app.get("/runtimes/:id", (c) => {
    const id = c.req.param("id");
    const runtime = deps.registry.runtimes.find((item) => item.id === id);
    if (!runtime) {
      return c.json(errorBody("not_found", `runtime ${id} is not in the registry`), 404);
    }
    return c.json(publicRuntime(runtime));
  });

  app.get("/state", (c) => {
    return c.json(publicClusterState(deps.getState()));
  });

  app.get("/v1/inspection/runtimes", (c) => {
    return c.json({ runtimes: deps.registry.runtimes.map(inspectionRuntime) });
  });

  app.get("/v1/inspection/runtimes/:id", (c) => {
    const id = c.req.param("id");
    const runtime = deps.registry.runtimes.find((item) => item.id === id);
    if (!runtime) {
      return c.json(errorBody("not_found", `runtime ${id} is not in the registry`), 404);
    }
    return c.json(inspectionRuntime(runtime));
  });

  app.get("/v1/inspection/state", (c) => {
    return c.json(deps.getState());
  });

  app.get("/operations/:id", (c) => {
    const operation = deps.control.getOperation(c.req.param("id"));
    if (!operation) {
      return c.json(errorBody("not_found", "operation not found"), 404);
    }
    return c.json(operation);
  });

  app.get("/v1/operations/:id", (c) => {
    const operation = deps.control.getOperation(c.req.param("id"));
    if (!operation) {
      return c.json(errorBody("not_found", "operation not found"), 404);
    }
    return c.json(operation);
  });

  app.post("/v1/allocations", async (c) => {
    const parsed = allocationRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "invalid allocation request"), 400);
    }
    if (parsed.data.deploymentPolicy === "allow-listed") {
      if (!deps.managementToken) {
        return c.json(errorBody("management_not_configured", "allow-listed deployment is disabled"), 503);
      }
      if (!secretMatches(c.req.header("x-larm-management-token"), deps.managementToken)) {
        return c.json(errorBody("forbidden", "valid management token required for deployment"), 403);
      }
    }
    const idempotencyKey = c.req.header("idempotency-key");
    if (idempotencyKey !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      return c.json(errorBody("bad_request", "Idempotency-Key is invalid"), 400);
    }
    const requestHash = normalizedAllocationRequestHash(parsed.data);
    if (idempotencyKey !== undefined) {
      pruneIdempotency();
      const existing = idempotency.get(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return c.json(errorBody(
            "idempotency_conflict",
            "Idempotency-Key was already used for a different allocation request",
          ), 409);
        }
        const replay = await existing.result;
        c.header("x-larm-idempotent-replay", "true");
        return c.json(replay.body, replay.status);
      }
      if (idempotency.size >= (deps.idempotencyLimit ?? 1_000)) {
        return c.json(errorBody(
          "idempotency_capacity",
          "idempotency result capacity is temporarily exhausted",
        ), 503);
      }
    }
    const allocationResult = (async (): Promise<AllocationApiResult> => {
      const result = await deps.control.allocate(parsed.data);
      return {
        status: result.status,
        body: "id" in result.body ? publicAllocation(result.body as Allocation) : result.body,
      };
    })();
    const entry = idempotencyKey !== undefined
      ? {
        requestHash,
        result: allocationResult,
        expiresAt: (deps.now?.() ?? Date.now()) + (deps.idempotencyTtlMs ?? 300_000),
        settled: false,
      }
      : undefined;
    if (idempotencyKey !== undefined && entry) {
      idempotency.set(idempotencyKey, entry);
      void allocationResult.then(
        (result) => {
          entry.settled = true;
          if (result.status !== 200 && result.status !== 202) {
            if (idempotency.get(idempotencyKey) === entry) {
              idempotency.delete(idempotencyKey);
            }
          }
        },
        () => {
          entry.settled = true;
          if (idempotency.get(idempotencyKey) === entry) {
            idempotency.delete(idempotencyKey);
          }
        },
      );
    }
    const result = await allocationResult;
    return c.json(result.body, result.status);
  });

  app.get("/v1/allocations/:id", (c) => {
    const allocation = deps.control.getAllocation(c.req.param("id"));
    if (!allocation) {
      const missing = deps.control.allocationLookupError(c.req.param("id"));
      return c.json(missing.body, missing.status);
    }
    return c.json(publicAllocation(allocation));
  });

  app.post("/v1/allocations/:id/renew", async (c) => {
    const parsed = allocationRenewRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "invalid allocation renewal"), 400);
    }
    const result = deps.control.renewAllocation(c.req.param("id"), parsed.data.ttlSeconds);
    const body = "id" in result.body ? publicAllocation(result.body as Allocation) : result.body;
    return c.json(body, result.status as 200 | 404 | 409 | 503);
  });

  app.post("/v1/allocations/:id/resolve", async (c) => {
    const parsed = allocationResolveRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "capability is required"), 400);
    }
    const result = deps.control.resolveAllocation(c.req.param("id"), parsed.data.capability);
    return c.json(result.body, result.status as 200 | 404 | 409 | 503);
  });

  app.delete("/v1/allocations/:id", async (c) => {
    const result = await deps.control.releaseAllocation(c.req.param("id"));
    const body = "id" in result.body ? publicAllocation(result.body as Allocation) : result.body;
    return c.json(body, result.status as 200 | 404 | 409);
  });

  app.get("/v1/models", (c) => {
    if (!modelBroker) {
      return c.json(openAiErrorBody(
        "model_catalog_unavailable",
        "OpenAI-compatible model catalog is not configured",
      ), 503);
    }
    return c.json(modelBroker.listModels());
  });

  app.post("/v1/chat/completions", (c) => handleGateway(c, {
    protocol: "openai.chat-completions.v1",
    upstreamPath: "/v1/chat/completions",
    bodyMode: "buffered",
    maxBodyBytes: deps.gatewayMaxBodyBytes ?? 4 * 1024 * 1024,
  }));

  app.post("/v1/audio/transcriptions", (c) => {
    const providerBearer = c.req.header("authorization")?.startsWith("Bearer larm_conn_v1.") === true;
    const bearer = c.req.header("authorization")?.startsWith("Bearer ") === true;
    if (c.req.header("x-larm-allocation-id") === undefined && !providerBearer && !bearer) {
      return handleServiceHarnessTranscription(c);
    }
    return handleGateway(c, {
      protocol: "openai.audio-transcriptions.v1",
      upstreamPath: "/v1/audio/transcriptions",
      bodyMode: "stream",
      maxBodyBytes: deps.speechMaxBodyBytes ?? 257 * 1024 * 1024,
    });
  });

  app.post("/v1/audio/speech", (c) => handleGateway(c, {
    protocol: "openai.audio-speech.v1",
    upstreamPath: "/v1/audio/speech",
    bodyMode: "buffered",
    maxBodyBytes: deps.gatewayMaxBodyBytes ?? 4 * 1024 * 1024,
  }));

  app.post("/v1/embed", (c) => handleGateway(c, {
    protocol: "larm.embedding.v1",
    upstreamPath: "/embed",
    bodyMode: "buffered",
    maxBodyBytes: deps.embeddingMaxBodyBytes ?? 2 * 1024 * 1024,
  }));

  app.get("/v1/audio/voices", (c) => handleGateway(c, {
    protocol: "openai.audio-speech.v1",
    upstreamPath: "/v1/audio/voices",
    bodyMode: "none",
    maxBodyBytes: 0,
  }));

  app.get("/v1/artifact-operations/:id", (c) => {
    if (!deps.artifactManager) {
      return c.json(errorBody("not_configured", "artifact management is not configured"), 503);
    }
    const operation = deps.artifactManager.getOperation(c.req.param("id"));
    if (!operation) {
      return c.json(errorBody("not_found", "artifact operation not found"), 404);
    }
    return c.json(operation);
  });

  app.post("/v1/artifacts/:id/stage", async (c) => {
    if (!deps.artifactManager) {
      return c.json(errorBody("not_configured", "artifact management is not configured"), 503);
    }
    return c.json(await deps.artifactManager.stage(c.req.param("id")), 202);
  });

  app.get("/v1/runtime-releases", (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    return c.json({ releases: deps.runtimeReleaseManager.listPublicReleases() });
  });

  app.post("/v1/runtime-releases/:id/stage", async (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    try {
      return c.json(await deps.runtimeReleaseManager.stageRelease(c.req.param("id")), 202);
    } catch (error) {
      if (error instanceof RuntimeReleaseManagerError) {
        return c.json(errorBody(error.code, error.message), 404);
      }
      throw error;
    }
  });

  app.get("/v1/deployments/:runtime", (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    try {
      return c.json(deps.runtimeReleaseManager.getDeployment(c.req.param("runtime")));
    } catch (error) {
      if (error instanceof RuntimeReleaseManagerError) {
        return c.json(errorBody(error.code, error.message), 404);
      }
      throw error;
    }
  });

  app.post("/v1/deployments/:runtime/plan", async (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    const parsed = runtimeReleasePlanRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "invalid runtime release selection"), 400);
    }
    try {
      return c.json(await deps.runtimeReleaseManager.plan(
        c.req.param("runtime"),
        parsed.data.release,
      ));
    } catch (error) {
      if (error instanceof RuntimeReleaseManagerError) {
        const status = error.code === "release_not_found" || error.code === "runtime_not_found" ? 404 : 409;
        return c.json(errorBody(error.code, error.message), status);
      }
      throw error;
    }
  });

  app.post("/v1/deployments/:runtime/activate", async (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    const parsed = runtimeReleaseSelectionSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "invalid runtime release selection"), 400);
    }
    try {
      return c.json(await deps.runtimeReleaseManager.activate(
        c.req.param("runtime"),
        parsed.data.release,
        parsed.data.expectedActiveRelease,
      ), 202);
    } catch (error) {
      if (error instanceof RuntimeReleaseManagerError) {
        const status = error.code === "release_not_found" || error.code === "runtime_not_found" ? 404 : 409;
        return c.json(errorBody(error.code, error.message), status);
      }
      throw error;
    }
  });

  app.post("/v1/deployments/:runtime/rollback", async (c) => {
    if (!deps.runtimeReleaseManager) {
      return c.json(errorBody("not_configured", "runtime release management is not configured"), 503);
    }
    try {
      return c.json(await deps.runtimeReleaseManager.rollback(c.req.param("runtime")), 202);
    } catch (error) {
      if (error instanceof RuntimeReleaseManagerError) {
        const status = error.code === "runtime_not_found" ? 404 : 409;
        return c.json(errorBody(error.code, error.message), status);
      }
      throw error;
    }
  });

  app.post("/prepare", async (c) => {
    const parsed = prepareRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "profile or capabilities is required"), 400);
    }
    const result = await deps.control.prepare(parsed.data);
    return c.json(result.body, result.status as 200 | 202 | 400 | 404 | 409 | 503);
  });

  app.post("/release", async (c) => {
    const parsed = releaseRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "leaseId is required"), 400);
    }
    const result = await deps.control.release(parsed.data.leaseId);
    return c.json(result.body, result.status as 200 | 404);
  });

  app.post("/resolve", async (c) => {
    const parsed = resolveRequestSchema.safeParse(await readJson(c, controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "capability is required"), 400);
    }
    const result = deps.control.resolve(parsed.data.capability);
    return c.json(result.body, result.status as 200 | 404 | 503);
  });

  app.notFound((c) => c.json(errorBody("not_found", "not found"), 404));

  return { app, agentConnections };
}

export function createApp(deps: AppDeps) {
  return createAppComponents(deps).app;
}
