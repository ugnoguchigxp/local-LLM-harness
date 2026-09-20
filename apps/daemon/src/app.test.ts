import { expect, test } from "bun:test";
import {
  API_OPERATIONS,
  agentConnectionClaimSchema,
  agentConnectionHealthSchema,
  clusterStateSchema,
  inspectionRuntimeListSchema,
  publicClusterStateSchema,
  publicAgentConnectionSchema,
  publicAgentProfileListSchema,
  publicAgentProfileListV1Schema,
  parseAgentConnectionCatalog,
  personalStateSubjectDigest,
  runtimeListSchema,
  type Registry,
  type RouteShadowComparison,
} from "@larm/core";
import { ArtifactStoreError, type RuntimeBackend, type RuntimeHealth } from "@larm/backends";
import { createApp, publicRuntime, type AppDeps, type FetchLike } from "./app";
import type { ArtifactManager, ArtifactOperation } from "./artifact-manager";
import { ControlPlane, type ControlEvent, type ControlPlaneOptions } from "./controller";
import { MetricsRegistry, RequestTracker } from "./metrics";
import { Observer } from "./observer";
import type { RuntimeReleaseManager } from "./runtime-release-manager";
import type {
  InferenceAuditFinish,
  InferenceAuditStart,
} from "./inference-audit";
import type { PersonalStateController } from "./personal-state-controller";
import { GatewayLifecycle } from "./gateway-lifecycle";
import { verifyGatewayStartup } from "./gateway-startup";

const registry: Registry = {
  nodes: [
    {
      id: "ai395-01",
      displayName: "test",
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
    },
  ],
  runtimes: [
    {
      id: "qwen-general",
      capability: ["llm.general", "llm.reasoning"],
      protocol: "openai.chat-completions.v1",
      backend: "systemd",
      node: "ai395-01",
      policy: { class: "resident" },
      resources: { estimatedMemoryGB: 24, maxConcurrentRequests: 1, maxQueuedRequests: 1, queueTimeoutMs: 100 },
      deployment: {
        service: "llama-server.service",
        healthPort: 8080,
        endpoint: "http://127.0.0.1:8080",
        backendEndpoint: "http://127.0.0.1:8080",
      },
    },
    {
      id: "qwen-worker",
      capability: ["llm.general", "llm.reasoning"],
      protocol: "openai.chat-completions.v1",
      backend: "systemd",
      node: "ai395-01",
      policy: { class: "preferred" },
      resources: {
        estimatedMemoryGB: 24,
        maxConcurrentAllocations: 1,
        maxConcurrentRequests: 1,
        maxQueuedRequests: 1,
        queueTimeoutMs: 100,
      },
      deployment: {
        service: "qwen-tts.service",
        healthPort: 8082,
        endpoint: "http://127.0.0.1:8082",
        backendEndpoint: "http://127.0.0.1:8082",
      },
    },
  ],
  profiles: [
    { id: "default", require: ["llm.general"] },
    { id: "meeting", require: ["llm.general", "speech.stt"] },
  ],
  routes: [
    {
      id: "llm-default",
      capabilities: ["llm.general", "llm.reasoning"],
      explicitOnly: false,
      candidates: [
        { runtime: "qwen-general", purpose: "primary" },
        { runtime: "qwen-worker", purpose: "fallback" },
      ],
    },
    {
      id: "llm-speed",
      capabilities: ["llm.general"],
      explicitOnly: true,
      candidates: [
        { runtime: "qwen-worker", purpose: "primary" },
        { runtime: "qwen-general", purpose: "fallback" },
      ],
    },
  ],
};

const agentConnectionCatalog = parseAgentConnectionCatalog({
  version: 1,
  defaultAgentProfile: "coding",
  audiences: {
    loopback: { network: "loopback", baseUrl: "http://127.0.0.1:9810/v1" },
  },
  agentProfiles: {
    coding: {
      description: "Test coding provider",
      providers: [{
        name: "llm",
        capability: "llm.general",
        route: "llm-default",
        publicModel: "test-model",
        readiness: "llm-inference",
        contextWindow: {
          maxTokens: 65_536,
          outputReserveTokens: 4_096,
          safetyMarginTokens: 1_976,
        },
      }],
    },
  },
}, registry);

const dynamicAgentConnectionCatalog = parseAgentConnectionCatalog({
  version: 1,
  defaultAgentProfile: "coding",
  audiences: {
    remote: { network: "host-private", baseUrl: "request-origin" },
  },
  agentProfiles: {
    coding: {
      description: "Test coding provider",
      providers: [{
        name: "llm",
        capability: "llm.general",
        route: "llm-default",
        publicModel: "test-model",
        readiness: "llm-inference",
      }],
    },
  },
}, registry);

const legacyAgentConnectionCatalog = parseAgentConnectionCatalog({
  version: 1,
  defaultAgentProfile: "coding",
  audiences: {
    remote: { network: "host-private", baseUrl: "request-origin" },
  },
  agentProfiles: {
    coding: {
      description: "Test coding provider",
      providers: [{
        name: "llm",
        capability: "llm.general",
        route: "llm-default",
        publicModel: "test-model",
        readiness: "llm-inference",
      }],
    },
  },
  compatibilityAliases: {
    "deep-reasoning-35b": {
      canonicalProfile: "coding",
      description: "Deprecated SAAA bootstrap alias",
      providerCapabilities: { llm: "llm.reasoning" },
    },
  },
}, registry);

const explicitAgentConnectionCatalog = parseAgentConnectionCatalog({
  version: 1,
  defaultAgentProfile: "coding",
  audiences: {
    loopback: { network: "loopback", baseUrl: "http://127.0.0.1:9810/v1" },
  },
  agentProfiles: {
    coding: {
      description: "Default coding provider",
      providers: [{
        name: "llm",
        capability: "llm.general",
        route: "llm-default",
        publicModel: "test-model",
        readiness: "llm-inference",
      }],
    },
    speed: {
      description: "Explicit speed provider",
      providers: [{
        name: "llm",
        capability: "llm.general",
        route: "llm-speed",
        publicModel: "speed-model",
        readiness: "llm-inference",
      }],
    },
  },
}, registry);

const agentApiToken = "agent-api-token";
const agentSigningKey = new Uint8Array(32).fill(7);

function agentHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${agentApiToken}`,
    ...extra,
  };
}

function validLlmSemanticProbeResponse(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean };
  if (body.stream === true) {
    return new Response([
      `data: ${JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: { content: "0" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  }
  return Response.json({
    id: "chatcmpl-probe",
    object: "chat.completion",
    created: 1,
    model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: "0" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function probe(
  id: string,
  live: boolean,
): RuntimeHealth {
  return {
    runtimeId: id,
    service: live ? "Running" : "Stopped",
    listening: live,
    healthOk: live,
    busy: false,
    httpStatus: live ? 200 : undefined,
  };
}

function stubBackend(probes: Map<string, RuntimeHealth>, log: { ensure: string[]; stop: string[] }): RuntimeBackend {
  return {
    list: async () => [...probes.values()],
    health: async (id) => probes.get(id) ?? probe(id, false),
    ensure: async (runtime) => {
      log.ensure.push(runtime.id);
      probes.set(runtime.id, probe(runtime.id, true));
      return probes.get(runtime.id)!;
    },
    stop: async (id) => {
      log.stop.push(id);
      probes.set(id, probe(id, false));
    },
  };
}

async function makeApp(
  generalHot: boolean,
  workerHot = false,
  controlOptions: ControlPlaneOptions = {},
  appOptions: Omit<Partial<AppDeps>, "registry" | "getState" | "control"> = {},
) {
  const probes = new Map<string, RuntimeHealth>([
    ["qwen-general", probe("qwen-general", generalHot)],
    ["qwen-worker", probe("qwen-worker", workerHot)],
  ]);
  const log = { ensure: [] as string[], stop: [] as string[] };
  const backend = stubBackend(probes, log);
  const observer = new Observer(registry, backend);
  await observer.tick();
  const control = new ControlPlane(registry, backend, observer, {
    idleTtlMs: 0,
    random: () => "fixed",
    onRouteShadowComparison: () => undefined,
    ...controlOptions,
  });
  const app = createApp({
    registry,
    getState: () => observer.getState(),
    control,
    ...appOptions,
  });
  return { app, control, log, observer, probes };
}

test("GET /health", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    status: "ok",
    ready: true,
    version: "test",
    releaseCommit: "development",
    configRevision: "test",
    bootEpoch: "epoch-local",
  });
  expect(res.headers.get("x-larm-boot-epoch")).toBe("epoch-local");
});

test("GET /v1/release-convergence exposes only strict root-authored convergence state", async () => {
  const status = {
    schemaVersion: 1 as const,
    operationId: "a".repeat(64),
    desiredRelease: "b".repeat(40),
    observedRelease: "b".repeat(40),
    stage: "contract_verified" as const,
    result: "succeeded" as const,
    reason: null,
    updatedAt: "2026-09-06T12:00:00.000Z",
  };
  const configured = (await makeApp(true, false, {}, {
    getReleaseConvergenceStatus: () => status,
  })).app;
  const response = await configured.request("/v1/release-convergence");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(status);

  const unavailable = (await makeApp(true)).app;
  expect((await unavailable.request("/v1/release-convergence")).status).toBe(503);
  const invalid = (await makeApp(true, false, {}, {
    getReleaseConvergenceStatus: () => ({ ...status, unexpected: "field" }),
  })).app;
  expect((await invalid.request("/v1/release-convergence")).status).toBe(503);
});

test("GET /v1/activity reports HTTP work without exposing internals", async () => {
  const tracker = new RequestTracker();
  const metrics = new MetricsRegistry();
  const events: ControlEvent[] = [];
  const finishHttp = tracker.begin();
  const { app, control } = await makeApp(true, false, {}, {
    requestTracker: tracker,
    metrics,
    now: () => Date.parse("2026-09-05T17:45:00.000Z"),
    onEvent: (event) => events.push(event),
  });

  const activeResponse = await app.request("/v1/activity");
  expect(activeResponse.status).toBe(200);
  expect(activeResponse.headers.get("cache-control")).toBe("no-store");
  expect(activeResponse.headers.get("retry-after")).toBe("1");
  expect(await activeResponse.json()).toEqual({
    contractVersion: "larm-service-activity.v1",
    state: "active",
    activeWorkloads: 1,
    observedAt: "2026-09-05T17:45:00.000Z",
    validForMs: 1_000,
    retryAfterMs: 1_000,
    reservationGuaranteed: false,
    bootEpoch: "epoch-local",
    configRevision: "test",
  });
  expect(events.at(-1)).toMatchObject({
    name: "service_activity_observed_state_changed",
    labels: { state: "active" },
    value: 1,
  });
  expect(metrics.render()).toContain("larm_service_activity_observed_active_workloads 1");
  expect(metrics.render()).toContain('larm_service_activity_observation_seconds_count{state="active"} 1');
  await app.request("/v1/activity");
  expect(events).toHaveLength(1);

  finishHttp();
  const idleResponse = await app.request("/v1/activity");
  expect(idleResponse.headers.has("retry-after")).toBeFalse();
  expect(await idleResponse.json()).toMatchObject({ state: "idle", activeWorkloads: 0 });
  expect(events.at(-1)).toMatchObject({
    name: "service_activity_observed_state_changed",
    labels: { state: "idle" },
    value: 0,
  });

  control.beginDrain();
  const drainingResponse = await app.request("/v1/activity");
  expect(drainingResponse.status).toBe(200);
  expect(drainingResponse.headers.get("retry-after")).toBe("1");
  expect(await drainingResponse.json()).toMatchObject({ state: "draining", activeWorkloads: 0 });
  expect(events.at(-1)).toMatchObject({
    name: "service_activity_observed_state_changed",
    labels: { state: "draining" },
    value: 0,
  });
});

test("service activity is fail-closed, rejects query input, and follows agent API auth", async () => {
  const unavailable = (await makeApp(true)).app;
  const unavailableResponse = await unavailable.request("/v1/activity");
  expect(unavailableResponse.status).toBe(503);
  expect(unavailableResponse.headers.get("cache-control")).toBe("no-store");
  expect(unavailableResponse.headers.get("retry-after")).toBe("1");

  const tracker = new RequestTracker();
  const secured = (await makeApp(true, false, {}, {
    apiToken: "secret",
    requestTracker: tracker,
  })).app;
  const unauthorized = await secured.request("/v1/activity");
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("cache-control")).toBe("no-store");
  expect((await secured.request("/v1/activity?profile=contextstill-background", {
    headers: { authorization: "Bearer secret" },
  })).status).toBe(400);
  expect((await secured.request(new Request("http://localhost/v1/activity", {
    method: "GET",
    headers: { authorization: "Bearer secret" },
    body: "not-allowed",
  }))).status).toBe(400);

  const anonymous = (await makeApp(true, false, {}, {
    apiToken: "secret",
    allowAnonymousAgentConnections: true,
    requestTracker: tracker,
  })).app;
  expect((await anonymous.request("/v1/activity")).status).toBe(200);
});

test("service activity observes a live Gateway request until its response closes", async () => {
  const tracker = new RequestTracker();
  let markUpstreamStarted: (() => void) | undefined;
  const upstreamStarted = new Promise<void>((resolve) => {
    markUpstreamStarted = resolve;
  });
  let releaseUpstream: (() => void) | undefined;
  const upstreamReleased = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });
  const { app } = await makeApp(true, false, {}, {
    requestTracker: tracker,
    gatewayFetch: async () => {
      markUpstreamStarted?.();
      await upstreamReleased;
      return Response.json({ choices: [] });
    },
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const gatewayResponse = app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: JSON.stringify({ model: "test", messages: [] }),
  });
  await upstreamStarted;
  expect(await (await app.request("/v1/activity")).json()).toMatchObject({
    state: "active",
    activeWorkloads: 1,
  });
  releaseUpstream?.();
  await (await gatewayResponse).body?.cancel();
  await Bun.sleep(0);
  expect(await (await app.request("/v1/activity")).json()).toMatchObject({
    state: "idle",
    activeWorkloads: 0,
  });
});

test("GET /openapi.json exposes the machine-readable v1 contract", async () => {
  const { app } = await makeApp(true);
  const response = await app.request("/openapi.json");
  expect(response.status).toBe(200);
  const document = await response.json() as {
    openapi: string;
    paths: Record<string, Record<string, {
      security?: Array<Record<string, unknown>>;
      responses?: Record<string, unknown>;
    }>>;
  };
  expect(document.openapi).toBe("3.1.0");
  expect(document.paths["/v1/allocations"]).toBeDefined();
  expect(document.paths["/v1/runtime-releases"]).toBeDefined();
  expect(document.paths["/v1/models"]?.get?.security).toEqual([{ bearerAuth: [] }]);
  expect(document.paths["/v1/models"]?.get?.responses?.["200"]).toEqual(
    expect.objectContaining({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/OpenAiModelList" },
        },
      },
    }),
  );
});

test("OpenAPI operation inventory cannot drift from daemon routes", async () => {
  const { app } = await makeApp(true);
  const actual = app.routes
    .filter((route) => route.method !== "ALL")
    .map((route) => `${route.method.toLowerCase()} ${route.path.replace(/:([a-zA-Z]+)/g, "{$1}")}`)
    .sort();
  const declared = API_OPERATIONS
    .map(([method, path]) => `${method} ${path}`)
    .sort();
  expect(actual).toEqual(declared);
});

test("allocation pins catalog generation and active runtime release", async () => {
  const { app } = await makeApp(true, false, {
    getCatalogRevision: () => "catalog-r2",
    getRuntimeRelease: () => "qwen-general-r1",
  });
  const response = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
      deploymentPolicy: "existing-only",
      allowFallback: false,
      ttlSeconds: 30,
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    catalogRevision: "catalog-r2",
    bindings: [{ release: "qwen-general-r1" }],
  });
});

test("GET /runtimes lists registry definitions", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/runtimes");
  expect(res.status).toBe(200);
  const body = runtimeListSchema.parse(await res.json());
  expect(body.runtimes.map((r) => r.id)).toEqual(["qwen-general", "qwen-worker"]);
  expect(body.runtimes[0]?.policy.class).toBe("resident");
  expect(body.runtimes[1]?.policy.class).toBe("preferred");
  expect(body.runtimes[0]).not.toHaveProperty("backend");
  expect(body.runtimes[0]).not.toHaveProperty("node");
  expect(body.runtimes[0]).not.toHaveProperty("resources");
  expect(body.runtimes[0]).not.toHaveProperty("deployment");
});

test("public runtime omits management-only swap group metadata", () => {
  const runtime = registry.runtimes[1]!;
  expect(publicRuntime({
    ...runtime,
    policy: { ...runtime.policy, swapGroup: "qwen-worker-slot" },
  })).toEqual({
    id: "qwen-worker",
    capability: ["llm.general", "llm.reasoning"],
    protocol: "openai.chat-completions.v1",
    policy: { class: "preferred" },
  });
});

test("GET /runtimes/:id 404", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/runtimes/does-not-exist");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "runtime does-not-exist is not in the registry" },
  });
});

test("GET /state exposes only capability-centered state", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/state");
  expect(res.status).toBe(200);
  const body = publicClusterStateSchema.parse(await res.json());
  expect(body.runtimes.find((r) => r.id === "qwen-general")?.status).toBe("HOT");
  expect(body).not.toHaveProperty("node");
  expect(body.runtimes[0]).not.toHaveProperty("endpoint");
  expect(body.runtimes[0]).not.toHaveProperty("backend");
  expect(body.runtimes[0]?.health).not.toHaveProperty("detail");
});

test("management inspection preserves full runtime and state detail", async () => {
  const { app } = await makeApp(true, false, {}, { managementToken: "manage" });
  const headers = { "x-larm-management-token": "manage" };
  const runtimesResponse = await app.request("/v1/inspection/runtimes", { headers });
  expect(runtimesResponse.status).toBe(200);
  const runtimes = inspectionRuntimeListSchema.parse(await runtimesResponse.json());
  expect(runtimes.runtimes[0]?.deployment.endpoint).toBe("http://127.0.0.1:8080");
  expect(runtimes.runtimes[0]?.backend).toBe("systemd");

  const stateResponse = await app.request("/v1/inspection/state", { headers });
  expect(stateResponse.status).toBe(200);
  const state = clusterStateSchema.parse(await stateResponse.json());
  expect(state.node.id).toBe("ai395-01");
  expect(state.runtimes[0]?.endpoint).toBe("http://127.0.0.1:8080");
});

test("management inspection fails closed without management credentials", async () => {
  const { app } = await makeApp(true, false, {}, { managementToken: "manage" });
  for (const path of [
    "/v1/inspection/runtimes",
    "/v1/inspection/runtimes/qwen-general",
    "/v1/inspection/state",
  ]) {
    expect((await app.request(path)).status).toBe(403);
  }
});

test("POST /prepare is ready when resident already covers the profile", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile: "default" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { leaseId: string; ready: boolean };
  expect(body.ready).toBe(true);
  expect(body.leaseId.startsWith("lease_")).toBe(true);
});

test("POST /prepare 409 when profile needs missing capabilities", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile: "meeting" }),
  });
  expect(res.status).toBe(409);
});

test("POST /prepare 202 ensures worker when resident is COLD", async () => {
  const { app, control, log } = await makeApp(false);
  const res = await app.request("/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capabilities: ["llm.general"] }),
  });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { operationId: string; ready: boolean };
  expect(body.ready).toBe(false);
  await control.flush();
  expect(log.ensure).toEqual(["qwen-worker"]);
  const op = await app.request(`/operations/${body.operationId}`);
  expect(op.status).toBe(200);
  expect(((await op.json()) as { ready: boolean }).ready).toBe(true);
});

test("direct legacy prepare keeps completed operation history bounded", async () => {
  const directRegistry: Registry = { ...registry, routes: [] };
  const probes = new Map<string, RuntimeHealth>([
    ["qwen-general", probe("qwen-general", false)],
    ["qwen-worker", probe("qwen-worker", false)],
  ]);
  const log = { ensure: [] as string[], stop: [] as string[] };
  const backend = stubBackend(probes, log);
  const observer = new Observer(directRegistry, backend);
  await observer.tick();
  let sequence = 0;
  const control = new ControlPlane(directRegistry, backend, observer, {
    historyLimit: 1,
    idleTtlMs: 0,
    random: () => String(++sequence),
  });

  const first = await control.prepare({ capabilities: ["llm.general"] });
  expect(first.status).toBe(202);
  const firstBody = first.body as { leaseId: string; operationId: string };
  await control.flush();
  expect(control.getOperation(firstBody.operationId)?.status).toBe("succeeded");
  await control.release(firstBody.leaseId);
  await control.flush();
  await backend.stop("qwen-worker");
  await observer.tick();

  const second = await control.prepare({ capabilities: ["llm.general"] });
  expect(second.status).toBe(202);
  const secondBody = second.body as { operationId: string };
  await control.flush();
  expect(control.getOperation(firstBody.operationId)).toBeUndefined();
  expect(control.getOperation(secondBody.operationId)?.status).toBe("succeeded");
  expect(log.ensure).toEqual(["qwen-worker", "qwen-worker"]);
});

test("POST /resolve returns the HOT resident endpoint", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "llm.general" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    runtime: "qwen-general",
    node: "ai395-01",
    endpoint: "http://127.0.0.1:8080",
    status: "HOT",
  });
});

test("POST /resolve is 503 when nothing is HOT", async () => {
  const { app } = await makeApp(false);
  const res = await app.request("/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "llm.general" }),
  });
  expect(res.status).toBe(503);
});

test("legacy resolve and v1 allocation fail closed on stale observation", async () => {
  let now = Date.now();
  const { app } = await makeApp(true, false, {
    now: () => now,
    stateMaxAgeMs: 5,
  });
  now += 60_000;

  const resolved = await app.request("/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "llm.general" }),
  });
  expect(resolved.status).toBe(503);
  expect(await resolved.json()).toEqual({
    error: expect.objectContaining({ code: "stale_state" }),
  });

  const allocated = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  expect(allocated.status).toBe(503);
  expect(await allocated.json()).toEqual({
    error: expect.objectContaining({ code: "stale_state" }),
  });
});

test("POST /resolve reports route shadow differences without changing legacy behavior", async () => {
  const comparisons: RouteShadowComparison[] = [];
  const { app } = await makeApp(false, false, {
    onRouteShadowComparison: (comparison) => comparisons.push(comparison),
  });
  const res = await app.request("/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "llm.general" }),
  });

  expect(res.status).toBe(503);
  expect(comparisons).toEqual([
    {
      capability: "llm.general",
      route: "llm-default",
      legacyRuntime: undefined,
      routeRuntime: "qwen-worker",
      legacyOutcome: "error:not_ready",
      routeOutcome: "runtime:qwen-worker",
      matches: false,
    },
  ]);
});

test("v1 allocation binds the resident default and resolves a fixed endpoint", async () => {
  const { app } = await makeApp(true);
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
      client: "ambient",
      ttlSeconds: 120,
    }),
  });
  expect(created.status).toBe(200);
  const allocation = (await created.json()) as {
    id: string;
    status: string;
    bindings: { runtime: string; endpoint?: string }[];
  };
  expect(allocation.status).toBe("ready");
  expect(allocation.bindings).toEqual([
    expect.objectContaining({ runtime: "qwen-general" }),
  ]);
  expect(allocation.bindings[0]?.endpoint).toBeUndefined();

  const resolved = await app.request(`/v1/allocations/${allocation.id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "llm.general" }),
  });
  expect(resolved.status).toBe(200);
  expect(await resolved.json()).toEqual(expect.objectContaining({
    runtime: "qwen-general",
    endpoint: "http://127.0.0.1:8080",
  }));

  const released = await app.request(`/v1/allocations/${allocation.id}`, {
    method: "DELETE",
  });
  expect(released.status).toBe(200);
  expect((await released.json()) as { status: string }).toEqual(
    expect.objectContaining({ status: "released" }),
  );
});

test("v1 explicit speed allocation starts and pins the preferred runtime", async () => {
  const { app, control, log } = await makeApp(true, false);
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
      ttlSeconds: 120,
    }),
  });
  expect(created.status).toBe(202);
  const allocation = (await created.json()) as { id: string; operationId: string; status: string };
  expect(allocation.status).toBe("pending");
  await control.flush();
  expect(log.ensure).toEqual(["qwen-worker"]);

  const current = await app.request(`/v1/allocations/${allocation.id}`);
  expect(current.status).toBe(200);
  expect(await current.json()).toEqual(expect.objectContaining({
    status: "ready",
    bindings: [expect.objectContaining({ runtime: "qwen-worker" })],
  }));
  const operation = await app.request(`/v1/operations/${allocation.operationId}`);
  expect(await operation.json()).toEqual(expect.objectContaining({
    kind: "allocation",
    status: "succeeded",
    ready: true,
    phase: "runtime-ready",
  }));
});

test("allow-listed allocation chains deployment before runtime startup", async () => {
  const deployed: { runtime: string; allocation?: string }[] = [];
  const { app, control, log } = await makeApp(true, false, {
    deploymentCoordinator: {
      ensureRuntime: async (runtime, allocation) => {
        deployed.push({ runtime, allocation });
      },
    },
  }, { managementToken: "manage" });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-management-token": "manage",
    },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
      deploymentPolicy: "allow-listed",
    }),
  });
  const allocation = (await created.json()) as { id: string; operationId: string };
  expect(created.status).toBe(202);
  await control.flush();
  expect(deployed).toEqual([{ runtime: "qwen-worker", allocation: allocation.id }]);
  expect(log.ensure).toEqual(["qwen-worker"]);
  const current = await app.request(`/v1/allocations/${allocation.id}`);
  expect(await current.json()).toEqual(
    expect.objectContaining({ status: "ready" }),
  );
});

test("allow-listed allocation preserves artifact failure codes", async () => {
  const { app, control } = await makeApp(true, false, {
    deploymentCoordinator: {
      ensureRuntime: async () => {
        throw new ArtifactStoreError("checksum_mismatch", "artifact verification failed");
      },
    },
  }, { managementToken: "manage" });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-management-token": "manage",
    },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
      deploymentPolicy: "allow-listed",
    }),
  });
  const allocation = (await created.json()) as { id: string };
  expect(created.status).toBe(202);
  await control.flush();
  const current = await app.request(`/v1/allocations/${allocation.id}`);
  expect(await current.json()).toEqual(expect.objectContaining({
    status: "failed",
    error: expect.objectContaining({ code: "checksum_mismatch" }),
  }));
});

test("allow-listed deployment is cancelled at the allocation startup deadline", async () => {
  const { app, control } = await makeApp(true, false, {
    startupTimeoutMs: 5,
    deploymentCoordinator: {
      ensureRuntime: async (_runtime, _allocation, _phase, signal) => {
        await new Promise<void>((_resolve, reject) => {
          const cancel = () => reject(signal?.reason ?? new Error("cancelled"));
          if (signal?.aborted) {
            cancel();
          } else {
            signal?.addEventListener("abort", cancel, { once: true });
          }
        });
      },
    },
  }, { managementToken: "manage" });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-management-token": "manage",
    },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
      deploymentPolicy: "allow-listed",
    }),
  });
  const allocation = (await created.json()) as { id: string; operationId: string };
  await control.flush();
  expect(await (await app.request(`/v1/allocations/${allocation.id}`)).json()).toEqual(
    expect.objectContaining({
      status: "failed",
      error: expect.objectContaining({ code: "startup_timeout" }),
    }),
  );
  expect(await (await app.request(`/v1/operations/${allocation.operationId}`)).json()).toEqual(
    expect.objectContaining({ status: "timed_out" }),
  );
});

test("allow-listed allocation requires the deployment management token", async () => {
  const { app, control } = await makeApp(true, false, {
    deploymentCoordinator: { ensureRuntime: async () => undefined },
  }, { managementToken: "manage" });
  const body = JSON.stringify({
    requirements: [{ capability: "llm.general", route: "llm-speed" }],
    deploymentPolicy: "allow-listed",
  });
  expect((await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })).status).toBe(403);
  expect((await app.request("/v1/allocations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-management-token": "manage",
    },
    body,
  })).status).toBe(202);
  await control.flush();
});

test("deployment APIs fail closed when no management token is configured", async () => {
  const operation = {
    id: "artifact_op_disabled",
    kind: "stage",
    artifactId: "tiny-model",
    status: "pending",
    createdAt: "2026-08-28T00:00:00.000Z",
  } as ArtifactOperation;
  const artifactManager = {
    stage: () => operation,
    getOperation: () => operation,
  } as unknown as ArtifactManager;
  const { app } = await makeApp(true, false, {
    deploymentCoordinator: { ensureRuntime: async () => undefined },
  }, { artifactManager });

  expect((await app.request("/v1/artifacts/tiny-model/stage", {
    method: "POST",
  })).status).toBe(503);
  expect((await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
      deploymentPolicy: "allow-listed",
    }),
  })).status).toBe(503);
});

test("releasing a pending deployment cancels startup before backend ensure", async () => {
  let deploymentStarted!: () => void;
  let finishDeployment!: () => void;
  const started = new Promise<void>((resolve) => {
    deploymentStarted = resolve;
  });
  const deployment = new Promise<void>((resolve) => {
    finishDeployment = resolve;
  });
  const { app, control, log } = await makeApp(true, false, {
    deploymentCoordinator: {
      ensureRuntime: async () => {
        deploymentStarted();
        await deployment;
      },
    },
  }, { managementToken: "manage" });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-management-token": "manage",
    },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
      deploymentPolicy: "allow-listed",
    }),
  });
  const allocation = (await created.json()) as { id: string; operationId: string };
  await started;
  expect((await app.request(`/v1/allocations/${allocation.id}`, {
    method: "DELETE",
  })).status).toBe(200);
  finishDeployment();
  await control.flush();

  expect(log.ensure).toEqual([]);
  expect(await (await app.request(`/v1/allocations/${allocation.id}`)).json()).toEqual(
    expect.objectContaining({ status: "released" }),
  );
  expect(await (await app.request(`/v1/operations/${allocation.operationId}`)).json()).toEqual(
    expect.objectContaining({ status: "cancelled" }),
  );
});

test("v1 allocation requires explicit fallback permission", async () => {
  const { app } = await makeApp(false, false);
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
      allowFallback: false,
    }),
  });
  expect(created.status).toBe(409);
  expect(await created.json()).toEqual({
    error: expect.objectContaining({ code: "fallback_not_allowed" }),
  });
});

test("v1 allocation renewal and expiry are bounded and observable", async () => {
  let now = Date.now() + 1_000;
  const { app } = await makeApp(true, false, { now: () => now });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
      ttlSeconds: 1,
    }),
  });
  const allocation = (await created.json()) as { id: string };
  const renewed = await app.request(`/v1/allocations/${allocation.id}/renew`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ttlSeconds: 2 }),
  });
  expect(renewed.status).toBe(200);
  now += 2_001;
  const expired = await app.request(`/v1/allocations/${allocation.id}`);
  expect(expired.status).toBe(200);
  expect(await expired.json()).toEqual(expect.objectContaining({ status: "expired" }));
});

test("v1 admission enforces declared runtime allocation capacity", async () => {
  let sequence = 0;
  const { app, control } = await makeApp(true, false, {
    random: () => String(++sequence),
  });
  const request = () => app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
      ttlSeconds: 120,
    }),
  });
  expect((await request()).status).toBe(202);
  await control.flush();
  const rejected = await request();
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({
    error: expect.objectContaining({ code: "resource_exhausted" }),
  });
});

test("waiting allocations replace an idle swap peer by priority without preempting active work", async () => {
  const priorityRegistry: Registry = {
    nodes: [{
      id: "local-node",
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 100, reservedMemoryGB: 16 },
    }],
    profiles: [],
    runtimes: [
      {
        id: "resident",
        capability: ["llm.general"],
        protocol: "openai.chat-completions.v1",
        backend: "systemd",
        node: "local-node",
        policy: { class: "resident" },
        resources: {
          estimatedMemoryGB: 40,
          maxConcurrentRequests: 1,
          maxQueuedRequests: 1,
          queueTimeoutMs: 1_000,
        },
        deployment: {
          service: "resident.service",
          healthPort: 8080,
          endpoint: "http://127.0.0.1:8080",
        },
      },
      ...["contextstill", "nightworker", "saaa"].map((id, index) => ({
        id,
        capability: ["llm.general"],
        protocol: "openai.chat-completions.v1" as const,
        backend: "llama-swap" as const,
        node: "local-node",
        policy: { class: "preferred" as const, swapGroup: "worker-slot" },
        resources: {
          estimatedMemoryGB: index === 2 ? 44 : 40,
          maxConcurrentAllocations: 1,
          maxConcurrentRequests: 1,
          maxQueuedRequests: 1,
          queueTimeoutMs: 1_000,
        },
        deployment: {
          modelId: id,
          listen: "http://127.0.0.1:8083",
          endpoint: `http://127.0.0.1:8083/upstream/${id}`,
        },
      })),
    ],
    routes: ["contextstill", "nightworker", "saaa"].map((id) => ({
      id: `llm-${id}`,
      capabilities: ["llm.general"],
      explicitOnly: true,
      candidates: [{ runtime: id, purpose: "primary" as const }],
    })),
  };
  const probes = new Map<string, RuntimeHealth>([
    ["resident", probe("resident", true)],
    ["contextstill", probe("contextstill", true)],
    ["nightworker", probe("nightworker", false)],
    ["saaa", probe("saaa", false)],
  ]);
  const ensured: string[] = [];
  const backend: RuntimeBackend = {
    list: async () => [...probes.values()],
    health: async (id) => probes.get(id) ?? probe(id, false),
    ensure: async (runtime) => {
      ensured.push(runtime.id);
      for (const peer of ["contextstill", "nightworker", "saaa"]) {
        probes.set(peer, probe(peer, peer === runtime.id));
      }
      return probes.get(runtime.id)!;
    },
    stop: async (id) => {
      probes.set(id, probe(id, false));
    },
  };
  const observer = new Observer(priorityRegistry, backend);
  await observer.tick();
  const control = new ControlPlane(priorityRegistry, backend, observer, {
    startupTimeoutMs: 1_000,
    pollIntervalMs: 1,
  });
  const request = (client: string, priority: number) => ({
    requirements: [{ capability: "llm.general", route: `llm-${client}` }],
    client,
    allowFallback: false,
    ttlSeconds: 60,
    deploymentPolicy: "existing-only" as const,
    priority,
    capacityPolicy: "wait" as const,
  });

  const contextStill = await control.allocate(request("contextstill", 1_000));
  const nightWorker = await control.allocate(request("nightworker", 2_000));
  const saaa = await control.allocate(request("saaa", 3_000));
  expect(contextStill.body).toMatchObject({ status: "ready", priority: 1_000 });
  expect(nightWorker.body).toMatchObject({ status: "waiting", priority: 2_000 });
  expect(saaa.body).toMatchObject({ status: "waiting", priority: 3_000 });
  expect(ensured).toEqual([]);

  await control.releaseAllocation((contextStill.body as { id: string }).id);
  await control.flush();
  expect(ensured).toEqual(["saaa"]);
  expect(control.getAllocation((saaa.body as { id: string }).id)?.status).toBe("ready");
  expect(control.getAllocation((nightWorker.body as { id: string }).id)?.status).toBe("waiting");

  await control.releaseAllocation((saaa.body as { id: string }).id);
  await control.flush();
  expect(ensured).toEqual(["saaa", "nightworker"]);
  expect(control.getAllocation((nightWorker.body as { id: string }).id)?.status).toBe("ready");

  const finalContextStill = await control.allocate(request("contextstill", 1_000));
  expect(finalContextStill.body).toMatchObject({ status: "waiting" });
  control.beginDrain();
  await control.flush();
  expect(control.getAllocation((finalContextStill.body as { id: string }).id)?.status)
    .toBe("released");
  expect(ensured).toEqual(["saaa", "nightworker"]);
});

test("control plane bounds active allocations even when runtime capacity is unbounded", async () => {
  const { app } = await makeApp(true, false, { maxActiveAllocations: 1 });
  const create = () => app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  expect((await create()).status).toBe(200);
  const full = await create();
  expect(full.status).toBe(503);
  expect(await full.json()).toEqual({
    error: expect.objectContaining({ code: "allocation_capacity" }),
  });
});

test("allocation admission rejects a runtime reserved for artifact mutation", async () => {
  const { app } = await makeApp(true, false, {
    isRuntimeMutating: (runtimeId) => runtimeId === "qwen-worker",
  });
  const response = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
    }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "deployment_in_progress" }),
  });
});

test("OpenAI-compatible model catalog uses standard bearer auth and hides runtime details", async () => {
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    agentConnectionCatalog,
  });

  expect((await app.request("/v1/models")).status).toBe(401);
  const response = await app.request("/v1/models", { headers: agentHeaders() });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    object: "list",
    data: [{ id: "test-model", object: "model", created: 0, owned_by: "larm" }],
  });
  expect(JSON.stringify(await (await app.request("/v1/models", { headers: agentHeaders() })).json()))
    .not.toContain("qwen-general");
});

test("standard Chat Completions needs only bearer and model and releases its internal allocation", async () => {
  const upstream: { url?: string; body?: unknown; allocationHeader?: string | null } = {};
  const events: ControlEvent[] = [];
  const { app, control } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    agentConnectionCatalog,
    onEvent: (event) => events.push(event),
    gatewayFetch: async (input, init) => {
      upstream.url = input.toString();
      upstream.body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as unknown;
      upstream.allocationHeader = new Headers(init?.headers).get("x-larm-allocation-id");
      return Response.json({
        id: "chatcmpl-direct",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
      });
    },
  });
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(expect.objectContaining({
    object: "chat.completion",
    model: "test-model",
  }));
  await Bun.sleep(0);
  expect(upstream.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
  expect(upstream.body).toEqual({
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  });
  expect(upstream.allocationHeader).toBeNull();
  expect(control.getActiveAllocationCount()).toBe(0);
  expect(events).toContainEqual(expect.objectContaining({
    name: "model_broker_prepare_completed",
    labels: expect.objectContaining({ model: "test-model", runtime: "qwen-general" }),
  }));
});

test("exclusive Chat Completions requires the separate management credential", async () => {
  let upstreamCalls = 0;
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    managementToken: "manage",
    agentConnectionCatalog,
    gatewayFetch: async () => {
      upstreamCalls += 1;
      return Response.json({
        id: "chatcmpl-exclusive",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        }],
      });
    },
  });
  const request = (managementToken?: string) => app.request("/v1/chat/completions", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "x-larm-exclusive-execution": "true",
      ...(managementToken ? { "x-larm-management-token": managementToken } : {}),
    }),
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "Reply with OK." }],
    }),
  });

  expect((await request()).status).toBe(403);
  expect(upstreamCalls).toBe(0);
  const accepted = await request("manage");
  expect(accepted.status).toBe(200);
  await accepted.arrayBuffer();
  expect(upstreamCalls).toBe(1);
});

test("Qwen 3.8 requests disable implicit thinking and normalize named tool choice", async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const { app } = await makeApp(true, false, {}, {
    gatewayFetch: async (_input, init) => {
      upstreamBody = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>;
      return Response.json({
        id: "chatcmpl-tool",
        object: "chat.completion",
        created: 1,
        model: "qwen3.8",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-read",
              type: "function",
              function: { name: "read_context", arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
    },
  });
  const allocation = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requirements: [{ capability: "llm.general", route: "llm-default" }] }),
  });
  const allocationId = ((await allocation.json()) as { id: string }).id;
  const tools = ["read_context", "lookup_status"].map((name) => ({
    type: "function",
    function: { name, parameters: { type: "object", properties: {} } },
  }));
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-larm-allocation-id": allocationId },
    body: JSON.stringify({
      model: "qwen3.8",
      messages: [{ role: "user", content: "Call read_context." }],
      tools,
      tool_choice: { type: "function", function: { name: "read_context" } },
    }),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  expect(upstreamBody).toMatchObject({
    model: "qwen3.8",
    chat_template_kwargs: { enable_thinking: false },
    tool_choice: "required",
    "speculative.n_max": 0,
    tools: [{ function: { name: "read_context" } }],
  });
  expect((upstreamBody?.tools as unknown[])).toHaveLength(1);

  const exact = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-larm-allocation-id": allocationId },
    body: JSON.stringify({
      model: "qwen3.8",
      messages: [{ role: "user", content: "Reply with just OK." }],
      temperature: 0,
    }),
  });
  expect(exact.status).toBe(200);
  expect(upstreamBody).toMatchObject({
    grammar: 'root ::= "OK"',
    "speculative.n_max": 0,
  });
});

test("Qwen 3.8 preserves explicit reasoning controls and rejects unknown named tools", async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const { app } = await makeApp(true, false, {}, {
    gatewayFetch: async (_input, init) => {
      upstreamBody = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
    },
  });
  const allocation = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requirements: [{ capability: "llm.general", route: "llm-default" }] }),
  });
  const allocationId = ((await allocation.json()) as { id: string }).id;
  const headers = { "content-type": "application/json", "x-larm-allocation-id": allocationId };
  const reasoned = await app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "qwen3.8", messages: [], reasoning_effort: "medium" }),
  });
  expect(reasoned.status).toBe(200);
  expect(upstreamBody).not.toHaveProperty("chat_template_kwargs");

  const invalid = await app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "qwen3.8",
      messages: [],
      tools: [{ type: "function", function: { name: "declared" } }],
      tool_choice: { type: "function", function: { name: "missing" } },
    }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: { code: "invalid_tool_choice" } });
});

test("standard Chat Completions preserves JSON Schema and disables Bun's upstream idle timeout", async () => {
  let upstreamBody: unknown;
  let upstreamTimeout: number | boolean | undefined;
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "procedure",
      strict: true,
      schema: {
        type: "object",
        required: ["steps"],
        properties: {
          steps: { type: "array", items: { type: "string" } },
        },
      },
    },
  };
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    agentConnectionCatalog,
    gatewayFetch: async (_input, init) => {
      upstreamBody = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as unknown;
      upstreamTimeout = init?.timeout;
      return Response.json({
        id: "chatcmpl-schema",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: '{"steps":["done"]}' },
          finish_reason: "stop",
        }],
      });
    },
  });
  const request = {
    model: "test-model",
    messages: [{ role: "user", content: "return a procedure" }],
    max_tokens: 4_000,
    response_format: responseFormat,
  };

  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(request),
  });

  expect(response.status).toBe(200);
  expect(upstreamBody).toEqual(request);
  expect(upstreamTimeout).toBeFalse();
});

test("standard Chat Completions streams SSE and single-flights preferred model startup", async () => {
  const upstream = [
    'data: {"id":"chatcmpl-direct","object":"chat.completion.chunk","created":1,"model":"internal-worker.gguf","choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-direct","object":"chat.completion.chunk","created":2,"model":"internal-worker.gguf","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-direct","object":"chat.completion.chunk","created":2,"model":"internal-worker.gguf","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const expected = [
    'data: {"id":"chatcmpl-direct","object":"chat.completion.chunk","created":1,"model":"speed-model","choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-direct","object":"chat.completion.chunk","created":1,"model":"speed-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-direct","object":"chat.completion.chunk","created":1,"model":"speed-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const { app, control, log } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    agentConnectionCatalog: explicitAgentConnectionCatalog,
    gatewayFetch: async () => new Response(upstream, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }),
  });
  const invoke = () => app.request("/v1/chat/completions", {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      model: "speed-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  });

  const firstPending = invoke();
  const secondPending = invoke();
  const first = await firstPending;
  expect(first.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(await first.text()).toBe(expected);
  const second = await secondPending;
  expect(await second.text()).toBe(expected);
  await Bun.sleep(0);
  expect(log.ensure).toEqual(["qwen-worker"]);
  expect(control.getActiveAllocationCount()).toBe(0);
});

test("standard Chat Completions rejects personal-state attempt headers without an explicit allocation", async () => {
  let contacted = false;
  const { app, control } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    agentConnectionCatalog,
    gatewayFetch: async () => {
      contacted = true;
      return Response.json({ unexpected: true });
    },
  });
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "x-larm-attempt-id": "attempt-standard-1",
    }),
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: "allocation_required",
      message: "generation attempts require an explicit allocation or claimed provider",
    },
  });
  expect(contacted).toBeFalse();
  expect(control.getActiveAllocationCount()).toBe(0);
});

test("standard Chat Completions rejects unknown models before allocation or upstream contact", async () => {
  let contacted = false;
  const { app, control } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    agentConnectionCatalog,
    gatewayFetch: async () => {
      contacted = true;
      return Response.json({ unexpected: true });
    },
  });
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ model: "missing", messages: [] }),
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: {
      message: "model missing is not available",
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
    },
  });
  expect(contacted).toBeFalse();
  expect(control.getActiveAllocationCount()).toBe(0);
});

test("standard Chat Completions normalizes the internal JSON model name", async () => {
  const { app, control } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    agentConnectionCatalog,
    gatewayFetch: async () => Response.json({
      id: "chatcmpl-drift",
      object: "chat.completion",
      created: 1,
      model: "internal-runtime-name",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "must not escape" },
        finish_reason: "stop",
      }],
    }),
  });
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: "chatcmpl-drift",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "must not escape" },
      finish_reason: "stop",
    }],
  });
  expect(control.getActiveAllocationCount()).toBe(0);
});

test("standard Chat Completions cancels an unreferenced cold start without leaking an allocation", async () => {
  const probes = new Map<string, RuntimeHealth>([
    ["qwen-general", probe("qwen-general", true)],
    ["qwen-worker", probe("qwen-worker", false)],
  ]);
  let ensureStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    ensureStarted = resolve;
  });
  let startupCancelled = false;
  const backend: RuntimeBackend = {
    list: async () => [...probes.values()],
    health: async (id) => probes.get(id) ?? probe(id, false),
    ensure: async (_runtime, signal) => {
      ensureStarted();
      await new Promise<void>((_resolve, reject) => {
        const cancel = () => {
          startupCancelled = true;
          reject(signal?.reason ?? new Error("cancelled"));
        };
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
      throw new Error("unreachable");
    },
    stop: async () => undefined,
  };
  const observer = new Observer(registry, backend);
  await observer.tick();
  const control = new ControlPlane(registry, backend, observer, {
    idleTtlMs: 0,
    random: () => "cancelled",
    onRouteShadowComparison: () => undefined,
  });
  const app = createApp({
    registry,
    getState: () => observer.getState(),
    control,
    apiToken: agentApiToken,
    agentConnectionCatalog: explicitAgentConnectionCatalog,
    connectionPollIntervalMs: 1,
  });
  const abort = new AbortController();
  const pending = app.request("/v1/chat/completions", {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      model: "speed-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
    signal: abort.signal,
  });

  await started;
  abort.abort(new Error("client disconnected"));
  expect((await pending).status).toBe(400);
  await control.flush();
  expect(startupCancelled).toBeTrue();
  expect(control.getActiveAllocationCount()).toBe(0);
});

test("HTTP gateway streams OpenAI-compatible SSE in the requested format", async () => {
  const upstreamRequest: { accept?: string; body?: unknown } = {};
  const encoder = new TextEncoder();
  const expected = [
    'data: {"id":"chatcmpl-gateway","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-gateway","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-gateway","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const { app } = await makeApp(true, false, {}, {
    gatewayFetch: async (_input, init) => {
      upstreamRequest.accept = new Headers(init?.headers).get("accept") ?? undefined;
      upstreamRequest.body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as unknown;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of expected) controller.enqueue(encoder.encode(event));
          controller.close();
        },
      }), {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: JSON.stringify({
      model: "local",
      stream: true,
      messages: [{ role: "user", content: "secret prompt" }],
    }),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
  expect(response.headers.get("x-accel-buffering")).toBe("no");
  expect(upstreamRequest.accept).toBe("text/event-stream");
  expect(upstreamRequest.body).toEqual({
    model: "local",
    stream: true,
    messages: [{ role: "user", content: "secret prompt" }],
  });
  expect(await response.text()).toBe(expected.join(""));
});

test("HTTP gateway fails an incomplete SSE EOF instead of recording success", async () => {
  const events: ControlEvent[] = [];
  const { app } = await makeApp(true, false, {}, {
    onEvent: (event) => events.push(event),
    gatewayFetch: async () => new Response(
      'data: {"id":"chatcmpl-partial","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: JSON.stringify({ model: "local", messages: [], stream: true }),
  });

  expect(response.status).toBe(200);
  await expect(response.text()).rejects.toThrow("missing_done");
  expect(events).toContainEqual(expect.objectContaining({
    name: "gateway_stream_protocol_error",
    labels: expect.objectContaining({ reason: "missing_done" }),
  }));
  expect(events).not.toContainEqual(expect.objectContaining({
    name: "gateway_stream_terminal_verified",
  }));
});

test("HTTP gateway rejects a successful non-SSE upstream response to a streaming chat", async () => {
  const { app } = await makeApp(true, false, {}, {
    gatewayFetch: async () => Response.json({ unexpected: true }),
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: JSON.stringify({ model: "local", messages: [], stream: true }),
  });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: {
      code: "upstream_response_format_mismatch",
      message: "upstream did not return text/event-stream for a streaming chat request",
    },
  });
});

test("HTTP gateway preserves an upstream JSON error for a streaming chat request", async () => {
  const { app } = await makeApp(true, false, {}, {
    gatewayFetch: async () => Response.json({
      error: { code: "provider_busy", message: "try later" },
    }, {
      status: 429,
      headers: { "retry-after": "2" },
    }),
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: JSON.stringify({ model: "local", messages: [], stream: true }),
  });

  expect(response.status).toBe(429);
  expect(response.headers.get("content-type")).toStartWith("application/json");
  expect(response.headers.get("retry-after")).toBe("2");
  expect(await response.json()).toEqual({
    error: { code: "provider_busy", message: "try later" },
  });
});

test("full-required inference audit captures the exact gateway request and response", async () => {
  let started: InferenceAuditStart | undefined;
  let finished: InferenceAuditFinish | undefined;
  const responseChunks: Uint8Array[] = [];
  const { app } = await makeApp(true, false, {
    getCatalogRevision: () => "allocation-revision",
  }, {
    random: () => "audited",
    getConfigRevision: () => "newer-revision",
    inferenceAuditMode: "full-required",
    inferenceAuditRecorder: {
      begin: async (input) => {
        started = input;
        return {
          captureResponse: (chunk) => responseChunks.push(chunk.slice()),
          finalize: async (input) => {
            finished = input;
          },
        };
      },
    },
    gatewayFetch: async () => new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    }),
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const body = '{"model":"local","messages":[{"role":"user","content":"exact secret"}]}';
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body,
  });
  expect(await response.text()).toBe('{"ok":true}');
  expect(new TextDecoder().decode(started?.requestBody)).toBe(body);
  expect(started).toMatchObject({
    requestId: "req_audited",
    allocationId,
    capability: "llm.general",
    route: "llm-default",
    runtime: "qwen-general",
    configRevision: "allocation-revision",
  });
  expect(new TextDecoder().decode(Buffer.concat(responseChunks))).toBe('{"ok":true}');
  expect(finished).toEqual({ outcome: "http_200", upstreamStatus: 200 });
});

test("response audit capture failure does not interrupt the client stream", async () => {
  const events: ControlEvent[] = [];
  let markedFailed = false;
  let finished: InferenceAuditFinish | undefined;
  const { app } = await makeApp(true, false, {}, {
    random: () => "capture-failure",
    onEvent: (event) => events.push(event),
    inferenceAuditMode: "full-required",
    inferenceAuditRecorder: {
      begin: async () => ({
        captureResponse: () => {
          throw new Error("audit buffer unavailable");
        },
        markResponseCaptureFailed: () => {
          markedFailed = true;
        },
        finalize: async (input) => {
          finished = input;
        },
      }),
    },
    gatewayFetch: async () => new Response("complete response", {
      headers: { "content-type": "text/plain" },
    }),
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: '{"model":"local","messages":[]}',
  });

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("complete response");
  expect(markedFailed).toBe(true);
  expect(finished).toEqual({ outcome: "http_200", upstreamStatus: 200 });
  expect(events).toContainEqual({
    name: "inference_audit_capture_failed",
    labels: { request: "req_capture-failure", phase: "response" },
  });
});

test("metadata audit mode emits lifecycle events without requiring payload storage", async () => {
  const events: ControlEvent[] = [];
  const { app } = await makeApp(true, false, {}, {
    random: () => "metadata-audit",
    onEvent: (event) => events.push(event),
    inferenceAuditMode: "metadata",
    gatewayFetch: async () => Response.json({ ok: true }),
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: '{"model":"local","messages":[]}',
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(events).toContainEqual({
    name: "inference_audit_started",
    labels: { request: "req_metadata-audit", mode: "metadata" },
  });
  expect(events).toContainEqual({
    name: "inference_audit_completed",
    labels: { request: "req_metadata-audit", outcome: "http_200" },
  });
});

test("full-required inference audit fails closed before contacting the provider", async () => {
  let contacted = false;
  const { app } = await makeApp(true, false, {}, {
    inferenceAuditMode: "full-required",
    inferenceAuditRecorder: {
      begin: async () => {
        throw new Error("disk unavailable");
      },
    },
    gatewayFetch: async () => {
      contacted = true;
      return Response.json({ unexpected: true });
    },
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: '{"model":"local","messages":[]}',
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "inference_audit_unavailable" }),
  });
  expect(contacted).toBe(false);
});

test("upstream transport timeouts are reported separately from provider unavailability", async () => {
  const events: ControlEvent[] = [];
  const transportTimeout = new Error("The operation timed out") as Error & { code: string };
  transportTimeout.name = "AbortError";
  transportTimeout.code = "ABORT_ERR";
  const { app, control } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    agentConnectionCatalog,
    onEvent: (event) => events.push(event),
    gatewayFetch: async () => {
      throw new Error("fetch failed", { cause: transportTimeout });
    },
  });

  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ model: "test-model", messages: [] }),
  });

  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "upstream_transport_timeout" }),
  });
  expect(events).toContainEqual({
    name: "gateway_upstream_fetch_failed",
    labels: expect.objectContaining({ reason: "timeout", runtime: "qwen-general" }),
  });
  expect(control.getActiveAllocationCount()).toBe(0);
});

test("gateway timeout cancels full-required audit materialization", async () => {
  let contacted = false;
  const tracker = new RequestTracker();
  const { app } = await makeApp(true, false, {}, {
    gatewayTimeoutMs: 5,
    requestTracker: tracker,
    inferenceAuditMode: "full-required",
    inferenceAuditRecorder: {
      begin: async (input) => await new Promise((resolve, reject) => {
        const rejectAbort = () => reject(input.signal?.reason ?? new Error("aborted"));
        if (input.signal?.aborted) rejectAbort();
        else input.signal?.addEventListener("abort", rejectAbort, { once: true });
      }),
    },
    gatewayFetch: async () => {
      contacted = true;
      return Response.json({ unexpected: true });
    },
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: '{"model":"local","messages":[]}',
  });
  expect(response.status).toBe(504);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "gateway_timeout" }),
  });
  expect(contacted).toBe(false);
  expect(tracker.count()).toBe(0);
});

test("v1 API enforces bearer auth when configured", async () => {
  const { app } = await makeApp(true, false, {}, { apiToken: "secret" });
  const body = JSON.stringify({
    requirements: [{ capability: "llm.general", route: "llm-default" }],
  });
  expect((await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })).status).toBe(401);
  expect((await app.request("/v1/allocations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer secret",
    },
    body,
  })).status).toBe(200);
  expect((await app.request("/state")).status).toBe(401);
  expect((await app.request("/health")).status).toBe(200);
});

test("health and chat stay not-ready until the listener lifecycle is verified", async () => {
  let state: import("./gateway-lifecycle").GatewayReadiness = {
    state: "starting",
    ready: false,
    changedAt: "2026-09-20T00:00:00.000Z",
    reason: "process_starting",
  };
  const { app } = await makeApp(true, false, {}, {
    getGatewayReadiness: () => state,
    startupProbeToken: "startup-probe-test-token",
  });
  const health = await app.request("/health");
  expect(health.status).toBe(503);
  expect(await health.json()).toMatchObject({
    status: "starting",
    ready: false,
    readiness: { reason: "process_starting" },
  });
  expect((await app.request("/ready")).status).toBe(503);
  const chat = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(chat.status).toBe(503);
  expect(await chat.json()).toEqual({
    error: { code: "gateway_not_ready", message: "LARM Gateway is not ready" },
  });

  state = {
    state: "verifying",
    ready: false,
    changedAt: "2026-09-20T00:00:00.500Z",
    reason: "listener_bound",
  };
  expect((await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })).status).toBe(503);
  expect((await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-startup-probe": "startup-probe-test-token",
    },
    body: "{}",
  })).status).toBe(400);

  state = {
    state: "ready",
    ready: true,
    changedAt: "2026-09-20T00:00:01.000Z",
    reason: "listener_verified",
  };
  expect((await app.request("/health")).status).toBe(200);
  expect((await app.request("/ready")).status).toBe(200);
});

test("E2E: the real TCP listener never publishes ready before chat works and survives rebind", async () => {
  const token = "e2e-api-token";
  const chatBody = JSON.stringify({
    model: "test-model",
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 8,
    temperature: 0,
  });
  const makeGeneration = async (port: number) => {
    const lifecycle = new GatewayLifecycle({
      bootEpoch: `epoch-e2e-${port}`,
      configRevision: "revision-e2e",
    });
    const startupProbeToken = crypto.randomUUID();
    const { app } = await makeApp(true, false, {}, {
      apiToken: token,
      agentConnectionCatalog,
      getGatewayReadiness: () => lifecycle.snapshot(),
      startupProbeToken,
      gatewayFetch: async () => Response.json({
        id: "chatcmpl-e2e",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        }],
      }),
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    lifecycle.listenerBound(baseUrl);
    return { lifecycle, startupProbeToken, server, baseUrl };
  };
  const requestChat = (baseUrl: string) => fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: chatBody,
  });

  let generation = await makeGeneration(0);
  expect((await fetch(`${generation.baseUrl}/health`)).status).toBe(503);
  expect((await requestChat(generation.baseUrl)).status).toBe(503);
  await verifyGatewayStartup({
    baseUrl: generation.baseUrl,
    apiToken: token,
    model: "test-model",
    startupProbeToken: generation.startupProbeToken,
    timeoutMs: 5_000,
  });
  generation.lifecycle.listenerVerified();
  expect((await fetch(`${generation.baseUrl}/health`)).status).toBe(200);

  for (let index = 0; index < 100; index += 1) {
    const response = await requestChat(generation.baseUrl);
    expect(response.status).toBe(200);
    await response.body?.cancel();
  }

  const reboundPort = generation.server.port;
  if (reboundPort === undefined) throw new Error("E2E listener did not expose its bound port");
  generation.lifecycle.beginDrain("e2e_restart");
  expect((await fetch(`${generation.baseUrl}/health`)).status).toBe(503);
  expect((await requestChat(generation.baseUrl)).status).toBe(503);
  generation.server.stop(true);

  generation = await makeGeneration(reboundPort);
  expect((await fetch(`${generation.baseUrl}/health`)).status).toBe(503);
  await verifyGatewayStartup({
    baseUrl: generation.baseUrl,
    apiToken: token,
    model: "test-model",
    startupProbeToken: generation.startupProbeToken,
    timeoutMs: 5_000,
  });
  generation.lifecycle.listenerVerified();
  expect((await fetch(`${generation.baseUrl}/health`)).status).toBe(200);
  expect((await requestChat(generation.baseUrl)).status).toBe(200);
  generation.lifecycle.beginDrain("e2e_complete");
  generation.server.stop(true);
});

test("gateway rejects oversized requests before contacting upstream", async () => {
  let contacted = false;
  const { app } = await makeApp(true, false, {}, {
    gatewayMaxBodyBytes: 8,
    gatewayFetch: async () => {
      contacted = true;
      return new Response("unexpected");
    },
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: "123456789",
  });
  expect(response.status).toBe(413);
  expect(contacted).toBe(false);
});

test("control API rejects oversized JSON before schema processing", async () => {
  const { app } = await makeApp(true, false, {}, { controlMaxBodyBytes: 32 });
  const response = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: "x".repeat(64) }),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "body_too_large" }),
  });
});

test("gateway timeout releases request tracking even when fetch ignores abort", async () => {
  const tracker = new RequestTracker();
  const events: ControlEvent[] = [];
  const { app } = await makeApp(true, false, {}, {
    requestTracker: tracker,
    gatewayTimeoutMs: 5,
    onEvent: (event) => events.push(event),
    gatewayFetch: async () => await new Promise<Response>(() => undefined),
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: "{}",
  });
  expect(response.status).toBe(504);
  expect(tracker.count()).toBe(0);
  expect(events.at(-1)?.labels?.outcome).toBe("timeout");
});

test("gateway timeout terminates a stalled upstream response stream", async () => {
  const tracker = new RequestTracker();
  const events: ControlEvent[] = [];
  const { app } = await makeApp(true, false, {}, {
    requestTracker: tracker,
    gatewayTimeoutMs: 5,
    onEvent: (event) => events.push(event),
    gatewayFetch: async () => new Response(new ReadableStream({
      pull: async () => await new Promise<void>(() => undefined),
    }), {
      headers: { "content-type": "application/octet-stream" },
    }),
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: "{}",
  });
  expect(response.status).toBe(200);
  await expect(response.text()).rejects.toThrow("gateway timeout");
  expect(tracker.count()).toBe(0);
  expect(events.at(-1)?.labels?.outcome).toBe("timeout");
});

test("gateway timeout releases an unread upstream response stream", async () => {
  const tracker = new RequestTracker();
  const { app } = await makeApp(true, false, {}, {
    requestTracker: tracker,
    gatewayTimeoutMs: 5,
    gatewayFetch: async () => new Response(new ReadableStream({ start() {} }), {
      headers: { "content-type": "application/octet-stream" },
    }),
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: "{}",
  });
  expect(response.status).toBe(200);
  await Bun.sleep(10);
  expect(tracker.count()).toBe(0);
  await expect(response.text()).rejects.toThrow("gateway timeout");
});

test("allocation release cancels both active and queued gateway requests", async () => {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { app } = await makeApp(true, false, {}, {
    gatewayFetch: async (_input, init) => {
      markStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const cancel = () => reject(signal?.reason ?? new Error("cancelled"));
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
    },
  });
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  const invoke = () => app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: "{}",
  });
  const active = invoke();
  await started;
  const queued = invoke();
  await Bun.sleep(1);
  expect((await app.request(`/v1/allocations/${allocationId}`, { method: "DELETE" })).status)
    .toBe(200);
  const responses = await Promise.all([active, queued]);
  expect(responses.map((response) => response.status)).toEqual([409, 409]);
  for (const response of responses) {
    expect(await response.json()).toEqual({
      error: expect.objectContaining({ code: "allocation_not_ready" }),
    });
  }
});

test("allocation resolve fails closed when its fixed runtime is no longer live", async () => {
  const { app, observer, probes } = await makeApp(true);
  const created = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await created.json()) as { id: string }).id;
  probes.set("qwen-general", probe("qwen-general", false));
  await observer.tick();
  const resolved = await app.request(`/v1/allocations/${allocationId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "llm.general" }),
  });
  expect(resolved.status).toBe(503);
  expect(await resolved.json()).toEqual({
    error: expect.objectContaining({ code: "runtime_not_ready" }),
  });
});

test("generated identifiers remain unique when an injected random source repeats", async () => {
  const { app } = await makeApp(true);
  const allocate = async () => {
    const response = await app.request("/v1/allocations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requirements: [{ capability: "llm.general", route: "llm-default" }],
      }),
    });
    return (await response.json()) as { id: string };
  };
  const first = await allocate();
  const second = await allocate();
  expect(first.id).not.toBe(second.id);
});

test("allocation creation is idempotent and rejects key reuse with a different request", async () => {
  const { app } = await makeApp(true);
  const create = (route: string) => app.request("/v1/allocations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "ambient-turn-1",
    },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route }],
    }),
  });
  const responses = await Promise.all([create("llm-default"), create("llm-default")]);
  const bodies = await Promise.all(
    responses.map((response) => response.json() as Promise<{ id: string; bootEpoch: string }>),
  );
  expect(bodies[1]?.id).toBe(bodies[0]?.id);
  expect(responses.filter((response) =>
    response.headers.get("x-larm-idempotent-replay") === "true"
  )).toHaveLength(1);
  expect(bodies[0]?.bootEpoch).toBe("epoch-local");
  const conflict = await create("llm-speed");
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({
    error: expect.objectContaining({ code: "idempotency_conflict" }),
  });
});

test("allocation idempotency normalizes requirement order", async () => {
  const { app } = await makeApp(true);
  const create = (requirements: { capability: string; route: string }[]) =>
    app.request("/v1/allocations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "ambient-multi-capability",
      },
      body: JSON.stringify({ requirements }),
    });
  const requirements = [
    { capability: "llm.general", route: "llm-default" },
    { capability: "llm.reasoning", route: "llm-default" },
  ];
  const first = await create(requirements);
  const second = await create([...requirements].reverse());
  const firstBody = (await first.json()) as { id: string };
  const secondBody = (await second.json()) as { id: string };
  expect(second.status).toBe(200);
  expect(second.headers.get("x-larm-idempotent-replay")).toBe("true");
  expect(secondBody.id).toBe(firstBody.id);
});

test("idempotency capacity fails closed without evicting live results", async () => {
  const { app } = await makeApp(true, false, {}, { idempotencyLimit: 1 });
  const create = (key: string) => app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const first = await create("capacity-one");
  const firstBody = (await first.json()) as { id: string };
  const full = await create("capacity-two");
  expect(full.status).toBe(503);
  expect(await full.json()).toEqual({
    error: expect.objectContaining({ code: "idempotency_capacity" }),
  });
  const replay = await create("capacity-one");
  expect(replay.status).toBe(200);
  expect(replay.headers.get("x-larm-idempotent-replay")).toBe("true");
  expect((await replay.json() as { id: string }).id).toBe(firstBody.id);
});

test("gateway and idempotency headers reject malformed identifiers", async () => {
  const { app } = await makeApp(true);
  const emptyKey = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  expect(emptyKey.status).toBe(400);

  const invalidAllocation = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": "alloc_epoch-local_bad:identifier",
    },
    body: "{}",
  });
  expect(invalidAllocation.status).toBe(400);

  const invalidCapability = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": "alloc_epoch-local_missing",
      "x-larm-capability": "llm/general",
    },
    body: "{}",
  });
  expect(invalidCapability.status).toBe(400);
});

test("control API rejects invalid UTF-8 JSON", async () => {
  const { app } = await makeApp(true);
  const response = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array([0xff]),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "bad_request" }),
  });
});

test("control API rejects unknown request fields", async () => {
  const { app } = await makeApp(true);
  const response = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
      runtime: "qwen-worker",
    }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "bad_request" }),
  });
});

test("allocation IDs from an earlier boot epoch fail with an explicit lifecycle error", async () => {
  const { app } = await makeApp(true);
  const response = await app.request("/v1/allocations/alloc_epoch-previous_123");
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "allocation_epoch_expired" }),
  });
});

test("startup reconciliation stops only orphaned HOT preferred runtimes", async () => {
  const { control, log } = await makeApp(true, true);
  expect(await control.reconcileOrphanedPreferred()).toEqual(["qwen-worker"]);
  expect(log.stop).toEqual(["qwen-worker"]);
});

test("startup reconciliation preserves a preferred runtime required by a legacy lease", async () => {
  const { control, log } = await makeApp(true, true);
  const leases = (control as unknown as {
    leases: Map<string, { id: string; capabilities: string[]; createdAt: string }>;
  }).leases;
  leases.set("legacy", {
    id: "legacy",
    capabilities: ["llm.general"],
    createdAt: new Date().toISOString(),
  });
  expect(await control.reconcileOrphanedPreferred()).toEqual([]);
  expect(log.stop).toEqual([]);
});

test("allocation fails closed while startup reconciliation is stopping its runtime", async () => {
  const probes = new Map<string, RuntimeHealth>([
    ["qwen-general", probe("qwen-general", true)],
    ["qwen-worker", probe("qwen-worker", true)],
  ]);
  let markStopStarted!: () => void;
  let releaseStop!: () => void;
  const stopStarted = new Promise<void>((resolve) => {
    markStopStarted = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const backend = stubBackend(probes, { ensure: [], stop: [] });
  backend.stop = async (id) => {
    markStopStarted();
    await stopGate;
    probes.set(id, probe(id, false));
  };
  const observer = new Observer(registry, backend);
  await observer.tick();
  const control = new ControlPlane(registry, backend, observer, {
    random: () => "fixed",
  });
  const app = createApp({ registry, getState: () => observer.getState(), control });

  const reconciliation = control.reconcileOrphanedPreferred();
  await stopStarted;
  const allocation = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
    }),
  });
  expect(allocation.status).toBe(409);
  expect(await allocation.json()).toEqual({
    error: expect.objectContaining({ code: "runtime_transition_in_progress" }),
  });
  releaseStop();
  expect(await reconciliation).toEqual(["qwen-worker"]);
});

test("legacy lease is detached if its backing allocation expires", async () => {
  let now = Date.now();
  const { app, control } = await makeApp(true, false, { now: () => now });
  now = Date.now();
  expect((await app.request("/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile: "default" }),
  })).status).toBe(200);
  expect(control.getLeases()).toHaveLength(1);
  now += 86_400_001;
  control.getAllocations();
  expect(control.getLeases()).toHaveLength(0);
});

test("drain rejects new allocations and readiness", async () => {
  const operation = {
    id: "artifact_op_drain",
    kind: "stage",
    artifactId: "tiny-model",
    status: "pending",
    createdAt: "2026-08-28T00:00:00.000Z",
  } as ArtifactOperation;
  const artifactManager = { stage: () => operation } as unknown as ArtifactManager;
  const { app, control } = await makeApp(true, false, {}, {
    artifactManager,
    managementToken: "manage",
  });
  const allocated = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  });
  const allocationId = ((await allocated.json()) as { id: string }).id;
  control.beginDrain();
  expect((await app.request("/ready")).status).toBe(503);
  expect((await app.request("/v1/allocations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-default" }],
    }),
  })).status).toBe(503);
  expect((await app.request("/v1/artifacts/tiny-model/stage", {
    method: "POST",
    headers: { "x-larm-management-token": "manage" },
  })).status).toBe(503);
  expect((await app.request(`/v1/allocations/${allocationId}/renew`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ttlSeconds: 300 }),
  })).status).toBe(503);
  expect((await app.request(`/v1/allocations/${allocationId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: "llm.general" }),
  })).status).toBe(503);
  expect((await app.request("/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability: "llm.general" }),
  })).status).toBe(503);
});

test("drain never schedules a new idle runtime stop", async () => {
  const { app, control, log } = await makeApp(true, true);
  const allocated = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requirements: [{ capability: "llm.general", route: "llm-speed" }],
    }),
  });
  const allocationId = ((await allocated.json()) as { id: string }).id;
  control.beginDrain();
  expect((await app.request(`/v1/allocations/${allocationId}`, { method: "DELETE" })).status)
    .toBe(200);
  await control.flush();
  expect(log.stop).toEqual([]);
});

test("control flush waits for work enqueued by an in-flight task", async () => {
  const { control } = await makeApp(true);
  const order: string[] = [];
  const enqueue = (work: () => Promise<void>) => {
    (control as unknown as { enqueue: (task: () => Promise<void>) => void }).enqueue(work);
  };
  enqueue(async () => {
    order.push("first");
    enqueue(async () => {
      await Bun.sleep(1);
      order.push("second");
    });
  });
  await control.flush();
  expect(order).toEqual(["first", "second"]);
});

test("artifact deployment API requires the separate management token", async () => {
  const operation: ArtifactOperation = {
    id: "artifact_op_test",
    kind: "stage",
    artifactId: "tiny-model",
    status: "pending",
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  const artifactManager = {
    stage: () => operation,
    activateRuntime: () => ({ ...operation, kind: "activate" as const }),
    rollbackRuntime: () => ({ ...operation, kind: "rollback" as const }),
    getOperation: (id: string) => id === operation.id ? operation : undefined,
  } as unknown as ArtifactManager;
  const { app } = await makeApp(true, false, {}, {
    artifactManager,
    managementToken: "manage",
  });
  expect((await app.request("/v1/artifacts/tiny-model/stage", {
    method: "POST",
  })).status).toBe(403);
  const staged = await app.request("/v1/artifacts/tiny-model/stage", {
    method: "POST",
    headers: { "x-larm-management-token": "manage" },
  });
  expect(staged.status).toBe(202);
  expect(await staged.json()).toEqual(operation);
  const fetched = await app.request(`/v1/artifact-operations/${operation.id}`, {
    headers: { "x-larm-management-token": "manage" },
  });
  expect(fetched.status).toBe(200);
});

test("runtime release APIs require management auth and preserve explicit release selection", async () => {
  const calls: unknown[][] = [];
  const releaseOperation: ArtifactOperation = {
    id: "artifact_op_release",
    kind: "activate",
    runtimeId: "qwen-worker",
    releaseId: "worker-r2",
    status: "pending",
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  const runtimeReleaseManager = {
    listReleases: () => [{
      id: "worker-r2",
      runtime: "qwen-worker",
      artifacts: ["worker-artifact-r2"],
      providerConfigRevision: "config-r2",
      estimatedMemoryGB: 24,
      healthPath: "/health",
      default: false,
      digest: "a".repeat(64),
    }],
    getDeployment: () => ({
      runtime: "qwen-worker",
      activeRelease: "worker-r1",
      previousRelease: null,
      desiredRelease: "worker-r1",
      catalogRevision: "catalog",
    }),
    plan: async (...args: unknown[]) => {
      calls.push(args);
      return {
        runtime: "qwen-worker",
        release: "worker-r2",
        activeRelease: "worker-r1",
        artifacts: ["worker-artifact-r2"],
        allowed: true,
        blockers: [],
      };
    },
    activate: async (...args: unknown[]) => {
      calls.push(args);
      return releaseOperation;
    },
  } as unknown as RuntimeReleaseManager;
  const artifactManager = {} as ArtifactManager;
  const { app } = await makeApp(true, false, {}, {
    managementToken: "manage",
    artifactManager,
    runtimeReleaseManager,
  });
  expect((await app.request("/v1/runtime-releases")).status).toBe(403);
  const headers = {
    "content-type": "application/json",
    "x-larm-management-token": "manage",
  };
  const plan = await app.request("/v1/deployments/qwen-worker/plan", {
    method: "POST",
    headers,
    body: JSON.stringify({ release: "worker-r2" }),
  });
  expect(plan.status).toBe(200);
  const activated = await app.request("/v1/deployments/qwen-worker/activate", {
    method: "POST",
    headers,
    body: JSON.stringify({ release: "worker-r2", expectedActiveRelease: "worker-r1" }),
  });
  expect(activated.status).toBe(202);
  expect(calls).toEqual([
    ["qwen-worker", "worker-r2"],
    ["qwen-worker", "worker-r2", "worker-r1"],
  ]);
});

test("POST /release stops idle preferred worker", async () => {
  const { app, control, log } = await makeApp(true, true);
  const prepared = await app.request("/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capabilities: ["llm.general"] }),
  });
  const leaseId = ((await prepared.json()) as { leaseId: string }).leaseId;
  const released = await app.request("/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leaseId }),
  });
  expect(released.status).toBe(200);
  await control.flush();
  expect(log.stop).toEqual(["qwen-worker"]);
});

test("agent connection claims a scoped OpenAI provider and revokes generations", async () => {
  const observed: Array<Record<string, unknown>> = [];
  const gatewayFetch: FetchLike = async (_input, init) => {
    const raw = init?.body instanceof Uint8Array
      ? new TextDecoder().decode(init.body)
      : String(init?.body);
    const value = JSON.parse(raw) as Record<string, unknown>;
    observed.push(value);
    if (value.max_tokens === 1) {
      const expected = {
        model: "test-model",
        messages: [{ role: "user", content: "0" }],
        temperature: 0,
        max_tokens: 1,
        stream: value.stream,
      };
      expect(value).toEqual(expected);
      return validLlmSemanticProbeResponse(init);
    }
    if (value.stream === true) {
      return new Response([
        'data: {"id":"chatcmpl-agent","object":"chat.completion.chunk","created":1,"model":"/models/internal.gguf","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-agent","object":"chat.completion.chunk","created":1,"model":"/models/internal.gguf","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      id: "chatcmpl-agent",
      object: "chat.completion",
      created: 1,
      model: "/models/internal.gguf",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "done" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    allowAnonymousAgentConnections: true,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog,
    gatewayFetch,
    personalStateController: {
      capability: async (input: { principal: string; allocationId: string; runtime: string }) => ({
        contractVersion: "larm-personal-state.v1",
        bootEpoch: "00000000-0000-4000-8000-000000000001",
        subjectDigest: personalStateSubjectDigest(input.principal),
        allocationId: input.allocationId,
        runtime: input.runtime,
        release: "release-test",
        leaseEpoch: 1,
        leaseExpiresAt: "2026-09-13T00:10:00.000Z",
        credentialExpiresAt: "2026-09-13T00:10:00.000Z",
        tokenizerDigest: "a".repeat(64),
        chatTemplateDigest: "b".repeat(64),
        contextLimitTokens: 262_144,
        outputReserveTokens: 32_768,
        safetyMarginTokens: 4_096,
        sourceTokenLimit: 20_000_000,
        maxSourceBytes: 268_435_456,
        maxTotalSourceBytes: 549_755_813_888,
        maxMaterializedBytes: 268_435_456,
        scopes: [
          "context.source.provision",
          "context.measure",
          "context.view.create",
          "context.generate",
          "context.attempt.cancel",
          "context.forget",
          "context.operation.read",
        ],
      }),
    } as unknown as PersonalStateController,
  });

  const discovery = await app.request("/v3/agent-profiles", { headers: agentHeaders() });
  expect(discovery.status).toBe(200);
  expect(await discovery.json()).toMatchObject({
    contractVersion: "agent-connection.v3",
    profiles: [{
      id: "coding",
      providers: [{
        contextWindow: {
          maxTokens: 65_536,
          outputReserveTokens: 4_096,
          safetyMarginTokens: 1_976,
        },
      }],
    }],
  });

  const forgedProvider = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer larm_conn_v1.forged",
      "content-type": "application/json",
    },
    body: "not-json",
  });
  expect(forgedProvider.status).toBe(401);

  const profiles = await app.request("/v2/agent-profiles", { headers: agentHeaders() });
  expect(profiles.status).toBe(200);
  expect(await profiles.json()).toMatchObject({
    contractVersion: "agent-connection.v2",
    defaultAgentProfile: "coding",
    profiles: [{
      id: "coding",
      canonicalProfile: "coding",
      selectionPolicy: "default",
      deprecated: false,
      providers: [{
        model: "test-model",
        supportedCapabilities: ["llm.general", "llm.reasoning"],
      }],
    }],
  });

  const create = await app.request("/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "agent-create-1",
    }),
    body: JSON.stringify({ audience: "loopback" }),
  });
  expect(create.status).toBe(201);
  const connection = publicAgentConnectionSchema.parse(await create.json());
  expect(connection.status).toBe("ready");
  expect(connection.agentProfile).toBe("coding");
  expect(connection.providers[0]?.claimable).toBeTrue();

  const unauthenticatedClaim = await app.request(`/v1/agent-connections/${connection.id}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "openai-provider-v1" }),
  });
  expect(unauthenticatedClaim.status).toBe(403);
  expect((await app.request(`/v1/agent-connections/${connection.id}`)).status).toBe(403);
  expect((await app.request(`/v1/agent-connections/${connection.id}/health`)).status).toBe(403);
  expect((await app.request(`/v1/agent-connections/${connection.id}/renew`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "anonymous-renew-authenticated-connection",
    },
    body: JSON.stringify({ ttlSeconds: 600 }),
  })).status).toBe(403);
  expect((await app.request(`/v1/agent-connections/${connection.id}`, {
    method: "DELETE",
  })).status).toBe(403);

  const replay = await app.request("/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "agent-create-1",
    }),
    body: JSON.stringify({ agentProfile: "coding", audience: "loopback" }),
  });
  expect(replay.headers.get("x-larm-idempotent-replay")).toBe("true");
  expect((await replay.json() as { id: string }).id).toBe(connection.id);

  const claimResponse = await app.request(`/v1/agent-connections/${connection.id}/claim`, {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ format: "openai-provider-v1" }),
  });
  expect(claimResponse.status).toBe(200);
  const claim = agentConnectionClaimSchema.parse(await claimResponse.json());
  const credential = claim.providers[0]!.credential.token;
  expect(credential).toStartWith("larm_conn_v1.");
  expect(claim.providers[0]).not.toHaveProperty("streaming");
  expect(claim.contextControl).toMatchObject({
    contractVersion: "larm-personal-state.v1",
    scopes: [
      "context.source.provision",
      "context.measure",
      "context.view.create",
      "context.generate",
      "context.attempt.cancel",
      "context.forget",
      "context.operation.read",
    ],
  });

  const staticCredential = await app.request("/v1/personal-state/capability", {
    headers: agentHeaders({
      "x-larm-allocation-id": claim.allocationId,
      "x-larm-runtime": "qwen-general",
    }),
  });
  expect(staticCredential.status).toBe(401);
  const contextCapability = await app.request("/v1/personal-state/capability", {
    headers: {
      authorization: `Bearer ${credential}`,
      "x-larm-allocation-id": claim.allocationId,
      "x-larm-runtime": "qwen-general",
    },
  });
  expect(contextCapability.status).toBe(200);
  expect(await contextCapability.json()).toMatchObject({
    subjectDigest: claim.contextControl!.subjectDigest,
    allocationId: claim.allocationId,
  });

  const legacyContextList = await app.request("/v1/contexts", {
    headers: { authorization: `Bearer ${credential}` },
  });
  expect(legacyContextList.status).toBe(401);

  const ambiguousSourceEncoding = await app.request("/v1/context-sources", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "text/plain",
      "x-larm-source-incarnation": "source-without-charset",
      "x-larm-allocation-id": claim.allocationId,
      "x-larm-runtime": "qwen-general",
      "x-larm-source-digest": "a".repeat(64),
    },
    body: "synthetic",
  });
  expect(ambiguousSourceEncoding.status).toBe(400);
  expect(ambiguousSourceEncoding.headers.get("cache-control")).toBe("no-store");
  expect(await ambiguousSourceEncoding.json()).toMatchObject({
    error: { code: "personal_state_request_invalid" },
  });

  const providerHealth = await app.request(claim.providers[0]!.health.url, {
    headers: { authorization: `Bearer ${credential}` },
  });
  expect(providerHealth.status).toBe(200);
  expect(await providerHealth.json()).toMatchObject({
    ready: true,
    acceptingRequests: true,
    capacity: {
      ready: true,
      activeRequests: 0,
      maxConcurrentRequests: 1,
      queueDepth: 0,
      maxQueuedRequests: 1,
      queueTimeoutMs: 100,
      retryAfterMs: 0,
      completionGuaranteed: false,
    },
  });

  const task = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "perform a real task" }],
      max_tokens: 4,
    }),
  });
  expect(task.status).toBe(200);
  expect(await task.json()).toMatchObject({
    model: "test-model",
    choices: [{ message: { content: "done" } }],
  });
  expect(observed).toHaveLength(3);

  const streamingTask = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "stream a real task" }],
      stream: true,
    }),
  });
  expect(streamingTask.status).toBe(200);
  expect(streamingTask.headers.get("content-type")).toBe("text/event-stream");
  const streamingBody = await streamingTask.text();
  expect(streamingBody).toEndWith("data: [DONE]\n\n");
  expect(streamingBody).toContain('"model":"test-model"');
  expect(streamingBody).not.toContain("/models/internal.gguf");
  expect(observed).toHaveLength(4);

  const wrongModel = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "another-model", messages: [] }),
  });
  expect(wrongModel.status).toBe(400);
  expect(observed).toHaveLength(4);

  const renewedResponse = await app.request(`/v1/agent-connections/${connection.id}/renew`, {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "agent-renew-1",
    }),
    body: JSON.stringify({ ttlSeconds: 600 }),
  });
  expect(renewedResponse.status).toBe(200);
  const revoked = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "test-model", messages: [] }),
  });
  expect(revoked.status).toBe(401);

  const nextClaim = agentConnectionClaimSchema.parse(await (await app.request(
    `/v1/agent-connections/${connection.id}/claim`,
    {
      method: "POST",
      headers: agentHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ format: "openai-provider-v1" }),
    },
  )).json());
  expect(nextClaim.providers[0]!.credential.token).not.toBe(credential);

  const renewReplay = await app.request(`/v1/agent-connections/${connection.id}/renew`, {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "agent-renew-1",
    }),
    body: JSON.stringify({ ttlSeconds: 600 }),
  });
  expect(renewReplay.status).toBe(200);
  expect(renewReplay.headers.get("x-larm-idempotent-replay")).toBe("true");
  const replayedClaim = agentConnectionClaimSchema.parse(await (await app.request(
    `/v1/agent-connections/${connection.id}/claim`,
    {
      method: "POST",
      headers: agentHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ format: "openai-provider-v1" }),
    },
  )).json());
  expect(replayedClaim.providers[0]!.credential.token).toBe(
    nextClaim.providers[0]!.credential.token,
  );

  const released = await app.request(`/v1/agent-connections/${connection.id}`, {
    method: "DELETE",
    headers: agentHeaders(),
  });
  expect(released.status).toBe(204);
  expect(await released.text()).toBe("");
  const releasedAgain = await app.request(`/v1/agent-connections/${connection.id}`, {
    method: "DELETE",
    headers: agentHeaders(),
  });
  expect(releasedAgain.status).toBe(204);
});

test("embedding Agent Connection claims, validates, renews, and releases a scoped provider", async () => {
  const embeddingSpace = {
    contractVersion: "larm-embedding.v1" as const,
    workload: "embedding" as const,
    model: {
      id: "intfloat/multilingual-e5-small",
      revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
      artifactDigest: "6".repeat(64),
    },
    dimension: 384,
    inputTypes: ["query", "passage"] as ["query", "passage"],
    prefixes: { query: "query: ", passage: "passage: " },
    normalization: "l2" as const,
    tokenization: {
      kind: "sentencepiece-bpe",
      tokenizerDigest: "0".repeat(64),
      maxTokens: 512,
      truncation: "end" as const,
      pooling: "mean" as const,
    },
  };
  const embeddingRegistry = structuredClone(registry);
  embeddingRegistry.runtimes.push({
    id: "embedding-runtime",
    capability: ["embedding.multilingual-e5-small"],
    protocol: "larm.embedding.v1",
    embedding: embeddingSpace,
    backend: "systemd",
    node: "ai395-01",
    policy: { class: "preferred" },
    resources: {
      estimatedMemoryGB: 1,
      maxConcurrentAllocations: 8,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 4,
      queueTimeoutMs: 500,
    },
    deployment: {
      service: "larm-embedding.service",
      healthPort: 44512,
      healthPath: "/health",
      endpoint: "http://127.0.0.1:44512",
    },
  });
  embeddingRegistry.routes.push({
    id: "embedding-route",
    capabilities: ["embedding.multilingual-e5-small"],
    explicitOnly: true,
    candidates: [{ runtime: "embedding-runtime", purpose: "primary" }],
  });
  const catalog = parseAgentConnectionCatalog({
    version: 1,
    defaultAgentProfile: "coding",
    audiences: { loopback: { network: "loopback", baseUrl: "http://127.0.0.1:9810/v1" } },
    agentProfiles: {
      coding: {
        description: "Test coding provider",
        providers: [{
          name: "llm",
          capability: "llm.general",
          route: "llm-default",
          publicModel: "test-model",
          readiness: "llm-inference",
        }],
      },
      embedding: {
        description: "Test embedding provider",
        providers: [{
          name: "embedding",
          capability: "embedding.multilingual-e5-small",
          route: "embedding-route",
          publicModel: "multilingual-e5-small",
          readiness: "embedding",
        }],
      },
    },
  }, embeddingRegistry);
  const probes = new Map<string, RuntimeHealth>([
    ["qwen-general", probe("qwen-general", true)],
    ["qwen-worker", probe("qwen-worker", false)],
    ["embedding-runtime", probe("embedding-runtime", true)],
  ]);
  const log = { ensure: [] as string[], stop: [] as string[] };
  const backend = stubBackend(probes, log);
  const observer = new Observer(embeddingRegistry, backend);
  await observer.tick();
  const control = new ControlPlane(embeddingRegistry, backend, observer, {
    idleTtlMs: 0,
    random: () => "embedding-fixed",
    onRouteShadowComparison: () => undefined,
  });
  let responseMode: "valid" | "wrong-dimension" | "redirect" = "valid";
  const upstream: Array<{ path: string; body?: unknown }> = [];
  const gatewayFetch: FetchLike = async (input, init) => {
    expect(init?.redirect).toBe("manual");
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(
      init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body),
    ) as Record<string, unknown> : undefined;
    upstream.push({ path, ...(body ? { body } : {}) });
    if (path === "/health") {
      return Response.json({
        ready: true,
        modelLoaded: true,
        service: "embeddingd",
        activeRequests: 0,
        queueDepth: 0,
      });
    }
    if (responseMode === "redirect") {
      return new Response(null, { status: 307, headers: { location: "http://example.invalid/embed" } });
    }
    const type = body?.type === "passage" ? "passage" : "query";
    const dimension = responseMode === "wrong-dimension" ? 383 : 384;
    return Response.json({
      embeddings: [[1, ...Array.from({ length: dimension - 1 }, () => 0)]],
      dimension,
      count: 1,
      type,
      normalize: true,
      queueWaitMs: 0,
      encodeMs: 1,
    });
  };
  const app = createApp({
    registry: embeddingRegistry,
    getState: () => observer.getState(),
    control,
    apiToken: agentApiToken,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog: catalog,
    gatewayFetch,
    personalStateController: {} as PersonalStateController,
  });

  const legacyProfiles = await app.request("/v2/agent-profiles", { headers: agentHeaders() });
  expect((await legacyProfiles.json() as { profiles: Array<{ id: string }> }).profiles)
    .not.toContainEqual(expect.objectContaining({ id: "embedding" }));
  const profiles = await app.request("/v3/agent-profiles", { headers: agentHeaders() });
  const profileBody = await profiles.json() as {
    contractVersion: string;
    profiles: Array<{ id: string; providers: unknown[] }>;
  };
  expect(profileBody.contractVersion).toBe("agent-connection.v3");
  expect(profileBody.profiles.find((profile) => profile.id === "embedding")).toMatchObject({
    id: "embedding",
    providers: [{
      protocol: "larm.embedding.v1",
      embeddingSpace: { dimension: 384 },
    }],
  });

  const created = await app.request("/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json", "idempotency-key": "embed-create" }),
    body: JSON.stringify({
      agentProfile: "embedding",
      explicitAgentProfile: true,
      audience: "loopback",
      ttlSeconds: 60,
    }),
  });
  expect(created.status).toBe(201);
  const connection = publicAgentConnectionSchema.parse(await created.json());
  expect(connection).toMatchObject({
    status: "ready",
    providers: [{ protocol: "larm.embedding.v1", claimable: true }],
  });
  expect(upstream.slice(0, 3).map((entry) => entry.path)).toEqual(["/health", "/embed", "/embed"]);

  const wrongFormat = await app.request(`/v1/agent-connections/${connection.id}/claim`, {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ format: "openai-provider-v1" }),
  });
  expect(wrongFormat.status).toBe(409);
  const claimResponse = await app.request(`/v1/agent-connections/${connection.id}/claim`, {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ format: "larm-embedding-provider-v1" }),
  });
  expect(claimResponse.status).toBe(200);
  const claim = agentConnectionClaimSchema.parse(await claimResponse.json());
  const provider = claim.providers[0]!;
  expect(provider).toMatchObject({
    apiStyle: "larm-embedding",
    endpoint: "http://127.0.0.1:9810/v1/embed",
    model: "multilingual-e5-small",
    embeddingSpace: {
      model: { revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3" },
      dimension: 384,
    },
    capacity: { ready: true, queueDepth: 0, maxQueuedRequests: 4 },
  });
  const credential = provider.credential.token;
  expect(claim.contextControl).toBeUndefined();
  const embeddingCredentialPayload = JSON.parse(
    Buffer.from(credential.split(".")[1]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  expect(embeddingCredentialPayload).not.toHaveProperty("subject");
  expect(embeddingCredentialPayload).not.toHaveProperty("scopes");

  expect((await app.request("/v1/embed", {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ texts: ["blocked"], type: "query", normalize: true, priority: "normal" }),
  })).status).toBe(401);
  expect((await app.request("/v1/embed", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ texts: ["missing type"], normalize: true, priority: "normal" }),
  })).status).toBe(400);

  const embedded = await app.request("/v1/embed", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ texts: ["document"], type: "passage", normalize: true, priority: "normal" }),
  });
  expect(embedded.status).toBe(200);
  expect(await embedded.json()).toMatchObject({ dimension: 384, count: 1, type: "passage" });

  responseMode = "wrong-dimension";
  expect((await app.request("/v1/embed", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ texts: ["query"], type: "query", normalize: true, priority: "low" }),
  })).status).toBe(502);
  responseMode = "redirect";
  expect((await app.request("/v1/embed", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ texts: ["query"], type: "query", normalize: true, priority: "low" }),
  })).status).toBe(502);

  const released = await app.request(`/v1/agent-connections/${connection.id}`, {
    method: "DELETE",
    headers: agentHeaders(),
  });
  expect(released.status).toBe(204);
  await control.flush();
  expect(log.stop).toContain("embedding-runtime");
  expect((await app.request("/v1/embed", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ texts: ["revoked"], type: "query", normalize: true, priority: "low" }),
  })).status).toBe(401);
});

test("non-default Agent Profiles require an explicit selection signal", async () => {
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog: explicitAgentConnectionCatalog,
  });
  const profiles = await app.request("/v2/agent-profiles", { headers: agentHeaders() });
  expect(await profiles.json()).toMatchObject({
    defaultAgentProfile: "coding",
    profiles: [
      { id: "coding", selectionPolicy: "default" },
      { id: "speed", selectionPolicy: "explicit-only" },
    ],
  });
  const rejected = await app.request("/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "implicit-speed-profile",
    }),
    body: JSON.stringify({ agentProfile: "speed", audience: "loopback" }),
  });
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({
    error: { code: "explicit_agent_profile_required" },
  });

  const accepted = await app.request("/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "explicit-speed-profile",
    }),
    body: JSON.stringify({
      agentProfile: "speed",
      explicitAgentProfile: true,
      audience: "loopback",
    }),
  });
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({
    agentProfile: "speed",
    providers: [{ route: "llm-speed", publicModel: "speed-model" }],
  });
});

test("commissioned v1 SAAA bootstrap migrates the legacy profile to standard HTTP", async () => {
  const events: ControlEvent[] = [];
  const { app, control, log } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    allowAnonymousAgentConnections: true,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog: legacyAgentConnectionCatalog,
    onEvent: (event) => events.push(event),
    gatewayFetch: async (_input, init) => validLlmSemanticProbeResponse(init),
  });

  const legacyProfilesResponse = await app.request("/v1/agent-profiles");
  expect(legacyProfilesResponse.status).toBe(200);
  const legacyProfiles = publicAgentProfileListV1Schema.parse(await legacyProfilesResponse.json());
  expect(Object.keys(legacyProfiles).sort()).toEqual([
    "audiences",
    "catalogRevision",
    "contractVersion",
    "profiles",
  ]);
  expect(legacyProfiles.profiles.find((profile) => profile.id === "deep-reasoning-35b"))
    .toEqual({
      id: "deep-reasoning-35b",
      description: "Deprecated SAAA bootstrap alias",
      providers: [{
        name: "llm",
        capability: "llm.reasoning",
        protocol: "openai.chat-completions.v1",
        model: "test-model",
      }],
    });

  const modernProfiles = publicAgentProfileListSchema.parse(await (await app.request(
    "/v2/agent-profiles",
  )).json());
  expect(modernProfiles.defaultAgentProfile).toBe("coding");
  expect(modernProfiles.profiles.find((profile) => profile.id === "deep-reasoning-35b"))
    .toMatchObject({
      canonicalProfile: "coding",
      selectionPolicy: "compatibility",
      deprecated: true,
      providers: [{
        capability: "llm.reasoning",
        model: "test-model",
      }],
    });

  const create = await app.request("http://gnosis.local:9810/v1/agent-connections", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "legacy-saaa-create",
    },
    body: JSON.stringify({
      agentProfile: "deep-reasoning-35b",
      audience: "remote",
      client: "saaa-desktop",
      ttlSeconds: 300,
      allowFallback: false,
      deploymentPolicy: "existing-only",
    }),
  });
  expect(create.status).toBe(201);
  const connection = publicAgentConnectionSchema.parse(await create.json());
  expect(connection).toMatchObject({
    agentProfile: "deep-reasoning-35b",
    status: "ready",
    providers: [{
      capability: "llm.reasoning",
      route: "llm-default",
      publicModel: "test-model",
      claimable: true,
    }],
  });

  const claimResponse = await app.request(`/v1/agent-connections/${connection.id}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "openai-provider-v1" }),
  });
  expect(claimResponse.status).toBe(200);
  const claim = agentConnectionClaimSchema.parse(await claimResponse.json());
  expect(claim.providers[0]).toMatchObject({
    capability: "llm.reasoning",
    model: "test-model",
  });
  expect(control.getAllocation(connection.allocationId)).toMatchObject({
    allowFallback: false,
    deploymentPolicy: "existing-only",
    bindings: [{
      capability: "llm.reasoning",
      route: "llm-default",
      runtime: "qwen-general",
      fallback: false,
    }],
  });
  expect(log.ensure).toEqual([]);
  expect(events).toContainEqual({
    name: "agent_profile_catalog_served",
    labels: { contract: "agent-connection.v1" },
  });
  expect(events).toContainEqual({
    name: "agent_connection_create_accepted",
    labels: {
      requestedProfile: "deep-reasoning-35b",
      canonicalProfile: "coding",
      status: "201",
    },
  });
  expect(events).toContainEqual({
    name: "agent_connection_claim_accepted",
    labels: { status: "200", providers: "1" },
  });
  expect((await app.request(`/v1/agent-connections/${connection.id}`, {
    method: "DELETE",
  })).status).toBe(204);
  expect(events).toContainEqual({
    name: "agent_connection_release_completed",
    labels: { status: "204" },
  });
  expect((await app.request(claim.providers[0]!.health.url, {
    headers: { authorization: `Bearer ${claim.providers[0]!.credential.token}` },
  })).status).toBe(401);
});

test("agent connection derives a host-private claim from the request origin", async () => {
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog: dynamicAgentConnectionCatalog,
    gatewayFetch: async (_input, init) => validLlmSemanticProbeResponse(init),
  });
  const create = await app.request("http://gnosis.local:9810/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "dynamic-origin-create",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https",
    }),
    body: JSON.stringify({ agentProfile: "coding", audience: "remote" }),
  });
  expect(create.status).toBe(201);
  const connection = publicAgentConnectionSchema.parse(await create.json());
  const claimResponse = await app.request(`/v1/agent-connections/${connection.id}/claim`, {
    method: "POST",
    headers: agentHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ format: "openai-provider-v1" }),
  });
  const claim = agentConnectionClaimSchema.parse(await claimResponse.json());
  expect(claim.providers[0]).toMatchObject({
    scheme: "http",
    host: "gnosis.local",
    port: 9810,
    baseUrl: "http://gnosis.local:9810/v1",
    health: {
      url: `http://gnosis.local:9810/v1/agent-connections/${connection.id}/providers/llm/health`,
    },
    configuration: {
      fields: { baseURL: "http://gnosis.local:9810/v1", model: "test-model" },
    },
  });

  const conflictingOrigin = await app.request("http://192.168.50.23:9810/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "dynamic-origin-create",
    }),
    body: JSON.stringify({ agentProfile: "coding", audience: "remote" }),
  });
  expect(conflictingOrigin.status).toBe(409);
  expect(await conflictingOrigin.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
});

test("host-private request-origin audiences reject loopback ingress", async () => {
  const { app, log } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog: dynamicAgentConnectionCatalog,
  });
  const response = await app.request("http://127.0.0.1:9810/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "loopback-origin-rejected",
    }),
    body: JSON.stringify({ agentProfile: "coding", audience: "remote" }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "connection_audience_unavailable" } });
  expect(log.ensure).toEqual([]);
});

test("agent semantic health rejects an HTTP-alive model that does not complete exactly one token", async () => {
  let probes = 0;
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog,
    gatewayFetch: async () => {
      probes += 1;
      return Response.json({
        choices: [{ index: 0, message: { role: "assistant", content: "alive" } }],
        usage: { completion_tokens: 2 },
      });
    },
  });
  const created = await app.request("/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "bad-semantic-model",
    }),
    body: JSON.stringify({ agentProfile: "coding", audience: "loopback" }),
  });
  expect(created.status).toBe(202);
  const connection = publicAgentConnectionSchema.parse(await created.json());
  expect(connection.status).toBe("probing");
  const health = await app.request(`/v1/agent-connections/${connection.id}/health`, {
    headers: agentHeaders(),
  });
  expect(health.status).toBe(503);
  expect(health.headers.get("cache-control")).toBe("no-store");
  expect(agentConnectionHealthSchema.parse(await health.json())).toMatchObject({
    ready: false,
    providers: [{ reason: "invalid_response" }],
  });
  expect(probes).toBe(1);
});

test("agent connection fails immediately when a provider rejects the fixed readiness request", async () => {
  let probes = 0;
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog,
    gatewayFetch: async () => {
      probes += 1;
      return Response.json({ error: { code: "invalid_model" } }, { status: 400 });
    },
  });
  const created = await app.request("/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "provider-contract-mismatch",
    }),
    body: JSON.stringify({ agentProfile: "coding", audience: "loopback" }),
  });
  expect(created.status).toBe(202);
  expect(publicAgentConnectionSchema.parse(await created.json())).toMatchObject({
    status: "failed",
    error: { code: "provider_contract_mismatch" },
  });
  expect(probes).toBe(1);
});

test("agent connection endpoints fail closed when API or signing credentials are absent", async () => {
  const withoutApi = await makeApp(true, false, {}, {
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog,
  });
  expect((await withoutApi.app.request("/v1/agent-profiles")).status).toBe(503);
  expect((await withoutApi.app.request("/v2/agent-profiles")).status).toBe(503);
  const withoutSigning = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    agentConnectionCatalog,
  });
  expect((await withoutSigning.app.request("/v1/agent-profiles", {
    headers: agentHeaders(),
  })).status).toBe(503);
});

test("anonymous Agent Connection lifecycle still issues a scoped provider credential", async () => {
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    allowAnonymousAgentConnections: true,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog,
    gatewayFetch: async (_input, init) => validLlmSemanticProbeResponse(init),
    personalStateController: {} as PersonalStateController,
  });

  expect((await app.request("/v1/agent-profiles")).status).toBe(200);
  expect((await app.request("/v2/agent-profiles")).status).toBe(200);
  expect((await app.request("/v1/agent-profiles", {
    headers: { authorization: "Bearer invalid" },
  })).status).toBe(401);
  expect((await app.request("/runtimes")).status).toBe(401);
  const createdResponse = await app.request("/v1/agent-connections", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "anonymous-create-1",
    },
    body: JSON.stringify({ agentProfile: "coding", audience: "loopback" }),
  });
  expect(createdResponse.status).toBe(201);
  const created = publicAgentConnectionSchema.parse(await createdResponse.json());
  expect((await app.request(`/v1/agent-connections/${created.id}`, {
    headers: agentHeaders(),
  })).status).toBe(403);
  expect((await app.request(`/v1/agent-connections/${created.id}`)).status).toBe(200);
  expect((await app.request(`/v1/agent-connections/${created.id}/health`)).status).toBe(200);
  expect((await app.request(`/v1/agent-connections/${created.id}/renew`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "anonymous-renew-1",
    },
    body: JSON.stringify({ ttlSeconds: 600 }),
  })).status).toBe(200);
  const claimResponse = await app.request(`/v1/agent-connections/${created.id}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "openai-provider-v1" }),
  });
  expect(claimResponse.status).toBe(200);
  const claim = agentConnectionClaimSchema.parse(await claimResponse.json());
  const credential = claim.providers[0]!.credential.token;
  expect(credential).toStartWith("larm_conn_v1.");
  expect(claim.contextControl).toBeUndefined();
  const credentialPayload = JSON.parse(
    Buffer.from(credential.split(".")[1]!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  expect(credentialPayload).not.toHaveProperty("subject");
  expect(credentialPayload).not.toHaveProperty("scopes");
  expect((await app.request(claim.providers[0]!.health.url)).status).toBe(401);
  expect((await app.request(claim.providers[0]!.health.url, {
    headers: { authorization: `Bearer ${credential}` },
  })).status).toBe(200);
  expect((await app.request(`/v1/agent-connections/${created.id}`, {
    method: "DELETE",
  })).status).toBe(204);
});
