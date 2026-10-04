import type { ServiceActivityState } from "@larm/core";
import {
  canonicalMeasurementRequestSchema,
  forgetRequestSchema,
  personalStateSubjectDigest,
  personalStateViewRequestSchema,
  prepareRequestSchema,
  releaseRequestSchema,
  resolveRequestSchema,
  getRuntime,
} from "@larm/core";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AppDeps } from "./app-types";
export type { AppDeps } from "./app-types";
import { ExecutionGate } from "./execution-gate";
import type { FetchLike as GatewayFetchLike } from "./gateway";
import { RequestBodyError } from "./http-body";
import type { GatewayRouteOptions } from "./app-gateway-ingress";
import {
  AgentConnectionController,
  agentPrincipal,
  type VerifiedProviderToken,
} from "./agent-connection-controller";
import { ConnectionTokenCodec, ConnectionTokenError } from "./connection-token";
import { SemanticReadiness } from "./semantic-readiness";
import { ModelBroker } from "./model-broker";
import { createGatewayHandler } from "./app-gateway-handler";
import {
  ContextController,
  ContextControllerError,
} from "./context-controller";
import {
  PersonalStateController,
  PersonalStateControllerError,
} from "./personal-state-controller";
import {
  secretMatches,
  SERVICE_HARNESS_ASR_RUNTIME,
} from "./app-auth";
import { createServiceHarnessAsrGateway } from "./service-harness-gateway";
import {
  errorBody,
  publicClusterState,
  publicRuntime,
  readJson,
} from "./app-http";
import { registerHealthRoutes } from "./routes/health";
import { registerAgentProfileRoutes } from "./routes/agent-profiles";
import { registerInspectionRoutes } from "./routes/inspection";
import { registerRuntimeReleaseRoutes } from "./routes/runtime-releases";
import { registerManagedContextRoutes } from "./routes/managed-context";
import { registerPersonalStateRoutes } from "./routes/personal-state";
import { registerInferenceRoutes } from "./routes/inference";
import { registerImageArtifactRoutes } from "./routes/image-artifacts";
import { registerImageGenerationRoutes } from "./routes/image-generations";
import { registerMusicRoutes } from "./routes/music";
import { registerAllocationRoutes } from "./routes/allocations";
import { registerAgentConnectionRoutes } from "./routes/agent-connections";
import { registerLegacyControlRoutes } from "./routes/legacy-control";
import { registerServiceHarnessRoutes } from "./routes/service-harness";
import { registerArtifactRoutes } from "./routes/artifacts";
import { createAppRequestPolicy } from "./app-request-policy";

export { publicClusterState, publicRuntime } from "./app-http";

export type FetchLike = GatewayFetchLike;

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
      readyTimeoutMs: deps.connectionReadyTimeoutMs ?? 300_000,
      pollIntervalMs: deps.connectionPollIntervalMs ?? 500,
      idempotencyTtlMs: deps.idempotencyTtlMs ?? 300_000,
      idempotencyLimit: deps.idempotencyLimit ?? 1_000,
      historyLimit: deps.connectionHistoryLimit ?? 1_000,
      personalStateAvailable: deps.personalStateController !== undefined,
      onEvent: deps.onEvent,
      now: deps.now,
      random: deps.random,
    })
    : undefined);
  const modelBroker = deps.modelBroker ?? (deps.agentConnectionCatalog
    ? new ModelBroker(deps.control, deps.agentConnectionCatalog, {
      startupTimeoutMs: deps.connectionReadyTimeoutMs ?? 300_000,
      pollIntervalMs: deps.connectionPollIntervalMs ?? 50,
      leaseTtlSeconds: Math.min(
        86_400,
        Math.max(1, Math.ceil(((deps.connectionReadyTimeoutMs ?? 300_000) + (deps.gatewayTimeoutMs ?? 300_000)) / 1_000) + 60),
      ),
      now: deps.now,
      onEvent: deps.onEvent,
    })
    : undefined);
  let lastObservedActivityState: ServiceActivityState | undefined;

  app.onError((err, c) => {
    if (err instanceof RequestBodyError) {
      return c.json(errorBody(err.code, err.message), err.status);
    }
    console.error(`request handler failed: ${err instanceof Error ? err.message : String(err)}`);
    return c.json(errorBody("internal_error", "internal server error"), 500);
  });

  app.use("*", createAppRequestPolicy(deps, identity));

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
  const agentRequestPrincipal = (c: Context) => secretMatches(
      c.req.header("authorization"),
      `Bearer ${deps.apiToken}`,
    )
    ? principal()
    : agentPrincipal("larm-anonymous-agent-connection");
  const contextCaller = (c: Context): { principal: string; scoped?: VerifiedProviderToken } | Response => {
    const authorization = c.req.header("authorization");
    if (deps.apiToken && secretMatches(authorization, `Bearer ${deps.apiToken}`)) {
      return { principal: principal() };
    }
    if (authorization?.startsWith("Bearer larm_conn_v1.")) {
      const feature = agentFeature(c);
      if (feature instanceof Response) return feature;
      try {
        const scoped = feature.verifyProviderToken(authorization.slice(7));
        return { principal: scoped.record.principal, scoped };
      } catch (error) {
        if (error instanceof ConnectionTokenError) {
          const idleReleased = error.code === "connection_idle_released";
          return c.json(
            errorBody(idleReleased ? error.code : "unauthorized", error.message),
            idleReleased ? 409 : 401,
          );
        }
        throw error;
      }
    }
    return { principal: principal() };
  };
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
  const personalStateFeature = (
    c: Context,
    scope: import("@larm/core").PersonalStateScope,
    allocationId?: string,
  ): { controller: PersonalStateController; caller: VerifiedProviderToken } | Response => {
    if (!deps.personalStateController) {
      return c.json(errorBody("personal_state_disabled", "Personal State delivery is disabled"), 503);
    }
    const caller = contextCaller(c);
    if (caller instanceof Response) return caller;
    if (!caller.scoped) {
      return c.json(errorBody(
        "connection_provider_token_required",
        "Personal State APIs require a claimed provider bearer token",
      ), 401);
    }
    if (
      caller.scoped.provider.protocol !== "openai.chat-completions.v1"
      || caller.scoped.payload.subject !== personalStateSubjectDigest(caller.principal)
      || !caller.scoped.payload.scopes?.includes(scope)
    ) {
      return c.json(errorBody("connection_forbidden", `provider token lacks ${scope}`), 403);
    }
    if (allocationId !== undefined && caller.scoped.record.allocationId !== allocationId) {
      return c.json(errorBody("connection_forbidden", "allocation does not match provider token"), 403);
    }
    return { controller: deps.personalStateController, caller: caller.scoped };
  };

  const personalStateError = (c: Context, error: unknown): Response => {
    if (error instanceof PersonalStateControllerError) {
      return c.json(errorBody(error.code, error.message), error.status);
    }
    if (error instanceof ContextControllerError) return contextError(c, error);
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

  const handleGateway = createGatewayHandler({
    deps,
    identity,
    executionGate,
    modelBroker,
    agentConnections,
    agentFeature,
    principal,
    contextFeature,
    personalStateFeature,
    personalStateError,
  });

  const serviceHarnessAsr = createServiceHarnessAsrGateway({
    registry: deps.registry,
    getState: deps.getState,
    identity,
    executionGate,
    speechMaxBodyBytes: deps.speechMaxBodyBytes,
    gatewayTimeoutMs: deps.gatewayTimeoutMs,
    gatewayFetch: deps.gatewayFetch,
    metrics: deps.metrics,
    requestTracker: deps.requestTracker,
    now: deps.now,
    random: deps.random,
    onEvent: deps.onEvent,
  });

  registerHealthRoutes(app, { ...deps, identity }, {
    get current() { return lastObservedActivityState; },
    set current(value) { lastObservedActivityState = value; },
  });

  registerServiceHarnessRoutes(app, {
    asrRuntime: getRuntime(deps.registry, SERVICE_HARNESS_ASR_RUNTIME),
    getConfigRevision: () => deps.getConfigRevision?.() ?? identity.configRevision,
    isAsrReady: serviceHarnessAsr.isReady,
    speechMaxBodyBytes: deps.speechMaxBodyBytes ?? 257 * 1024 * 1024,
    handleGateway: (context, request) => handleGateway(context, request),
    handleTranscription: serviceHarnessAsr.handleTranscription,
  });

  const agentResult = (c: Context, result: {
    status: number;
    body: unknown;
    replay?: boolean;
    location?: string;
    retryAfterSeconds?: number;
  }): Response => {
    if (result.replay) c.header("x-larm-idempotent-replay", "true");
    if (result.location) c.header("location", result.location);
    if (result.retryAfterSeconds) c.header("retry-after", String(result.retryAfterSeconds));
    else if (result.status === 202 || result.status === 503) c.header("retry-after", "1");
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

  registerManagedContextRoutes(app, {
    contextFeature,
    contextCaller,
    personalStateFeature,
    idempotencyKey,
    contextError,
  }, { controlMaxBodyBytes });

  registerPersonalStateRoutes(app, {
    feature: personalStateFeature,
    idempotencyKey,
    handleError: personalStateError,
  }, {
    controlMaxBodyBytes,
    gatewayMaxBodyBytes: deps.gatewayMaxBodyBytes ?? 4 * 1024 * 1024,
    personalStateMaxSourceBytes: deps.personalStateMaxSourceBytes ?? 256 * 1024 * 1024,
  });

  registerAgentProfileRoutes(app, deps, agentFeature, agentResult);

  registerAgentConnectionRoutes(app, {
    apiToken: deps.apiToken,
    managementToken: deps.managementToken,
    catalog: deps.agentConnectionCatalog,
    maxBodyBytes: controlMaxBodyBytes,
    feature: agentFeature,
    idempotencyKey,
    requestPrincipal: agentRequestPrincipal,
    principal,
    result: agentResult,
    onEvent: deps.onEvent,
  });

  registerInspectionRoutes(app, deps);

  registerAllocationRoutes(app, {
    control: deps.control,
    managementToken: deps.managementToken,
    maxBodyBytes: controlMaxBodyBytes,
    idempotencyTtlMs: deps.idempotencyTtlMs ?? 300_000,
    idempotencyLimit: deps.idempotencyLimit ?? 1_000,
    now: deps.now,
  });

  registerInferenceRoutes(app, {
    modelBroker,
    gatewayMaxBodyBytes: deps.gatewayMaxBodyBytes ?? 4 * 1024 * 1024,
    embeddingMaxBodyBytes: deps.embeddingMaxBodyBytes ?? 2 * 1024 * 1024,
    handleGateway,
  });

  registerImageArtifactRoutes(app, deps.imageArtifactManager);
  registerImageGenerationRoutes(app, deps.imageGenerationProvider);

  registerMusicRoutes(app, {
    manager: deps.musicManager,
    maxBodyBytes: deps.gatewayMaxBodyBytes ?? 4 * 1024 * 1024,
  });

  registerArtifactRoutes(app, deps.artifactManager);

  registerRuntimeReleaseRoutes(app, { runtimeReleaseManager: deps.runtimeReleaseManager, controlMaxBodyBytes });

  registerLegacyControlRoutes(app, { control: deps.control, maxBodyBytes: controlMaxBodyBytes });

  app.notFound((c) => c.json(errorBody("not_found", "not found"), 404));

  return { app, agentConnections, modelBroker };
}

export function createApp(deps: AppDeps) {
  return createAppComponents(deps).app;
}
