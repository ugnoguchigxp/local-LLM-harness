import { expect, test } from "bun:test";
import {
  API_OPERATIONS,
  agentConnectionClaimSchema,
  agentConnectionHealthSchema,
  clusterStateSchema,
  inspectionRuntimeListSchema,
  publicClusterStateSchema,
  publicAgentConnectionSchema,
  parseAgentConnectionCatalog,
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
      }],
    },
  },
}, registry);

const dynamicAgentConnectionCatalog = parseAgentConnectionCatalog({
  version: 1,
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

const agentApiToken = "agent-api-token";
const agentSigningKey = new Uint8Array(32).fill(7);

function agentHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${agentApiToken}`,
    ...extra,
  };
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
    version: "test",
    releaseCommit: "development",
    configRevision: "test",
    bootEpoch: "epoch-local",
  });
  expect(res.headers.get("x-larm-boot-epoch")).toBe("epoch-local");
});

test("GET /openapi.json exposes the machine-readable v1 contract", async () => {
  const { app } = await makeApp(true);
  const response = await app.request("/openapi.json");
  expect(response.status).toBe(200);
  const document = await response.json() as {
    openapi: string;
    paths: Record<string, unknown>;
  };
  expect(document.openapi).toBe("3.1.0");
  expect(document.paths["/v1/allocations"]).toBeDefined();
  expect(document.paths["/v1/runtime-releases"]).toBeDefined();
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

test("catalog reload reservation fails new allocation closed", async () => {
  const { app, control } = await makeApp(true);
  const reservation = control.beginCatalogReload();
  expect(reservation.ok).toBeTrue();
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
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "catalog_reloading" } });
  if (reservation.ok) reservation.release();
});

test("catalog reload closes generation-dependent read APIs", async () => {
  const { app } = await makeApp(true, false, {}, {
    catalogManager: { isReloading: true } as AppDeps["catalogManager"],
    managementToken: "manage",
  });
  for (const [path, headers] of [
    ["/runtimes", undefined],
    ["/runtimes/qwen-general", undefined],
    ["/state", undefined],
    ["/v1/inspection/runtimes", { "x-larm-management-token": "manage" }],
    ["/v1/inspection/runtimes/qwen-general", { "x-larm-management-token": "manage" }],
    ["/v1/inspection/state", { "x-larm-management-token": "manage" }],
  ] as const) {
    const response = await app.request(path, { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "catalog_reloading" } });
  }
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

test("gateway proxies streaming chat through the allocation binding", async () => {
  const metrics = new MetricsRegistry();
  const tracker = new RequestTracker();
  const events: ControlEvent[] = [];
  let upstreamUrl = "";
  let upstreamBody = "";
  const { app } = await makeApp(true, false, {}, {
    metrics,
    requestTracker: tracker,
    onEvent: (event) => events.push(event),
    random: () => "gateway",
    gatewayFetch: async (input, init) => {
      upstreamUrl = String(input);
      upstreamBody = new TextDecoder().decode(init?.body as ArrayBuffer);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: one\n\n"));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
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
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toBe("data: one\n\ndata: [DONE]\n\n");
  expect(upstreamUrl).toBe("http://127.0.0.1:8080/v1/chat/completions");
  expect(JSON.parse(upstreamBody)).toEqual({
    model: "local",
    stream: true,
    messages: [{ role: "user", content: "secret prompt" }],
  });
  expect(tracker.count()).toBe(0);
  expect(metrics.render()).toContain("larm_gateway_request_total");
  expect(events.filter((event) => event.name.startsWith("gateway_")).map((event) => event.name)).toEqual([
    "gateway_request_started",
    "gateway_request_completed",
  ]);
  expect(JSON.stringify(events)).not.toContain("secret prompt");
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
      headers: { "content-type": "text/event-stream" },
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
      headers: { "content-type": "text/event-stream" },
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
      expect(value).toEqual({
        model: "test-model",
        messages: [{ role: "user", content: "0" }],
        temperature: 0,
        max_tokens: 1,
        stream: false,
      });
      return Response.json({
        choices: [{ index: 0, message: { role: "assistant", content: "" } }],
        usage: { completion_tokens: 1 },
      });
    }
    return Response.json({
      choices: [{ index: 0, message: { role: "assistant", content: "done" } }],
      usage: { completion_tokens: 1 },
    });
  };
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog,
    gatewayFetch,
  });

  const profiles = await app.request("/v1/agent-profiles", { headers: agentHeaders() });
  expect(profiles.status).toBe(200);
  expect(await profiles.json()).toMatchObject({
    contractVersion: "agent-connection.v1",
    profiles: [{ id: "coding", providers: [{ model: "test-model" }] }],
  });

  const create = await app.request("/v1/agent-connections", {
    method: "POST",
    headers: agentHeaders({
      "content-type": "application/json",
      "idempotency-key": "agent-create-1",
    }),
    body: JSON.stringify({ agentProfile: "coding", audience: "loopback" }),
  });
  expect(create.status).toBe(201);
  const connection = publicAgentConnectionSchema.parse(await create.json());
  expect(connection.status).toBe("ready");
  expect(connection.providers[0]?.claimable).toBeTrue();

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

  const providerHealth = await app.request(claim.providers[0]!.health.url, {
    headers: { authorization: `Bearer ${credential}` },
  });
  expect(providerHealth.status).toBe(200);
  expect(await providerHealth.json()).toMatchObject({ ready: true, acceptingRequests: true });

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
  expect(await task.json()).toMatchObject({ choices: [{ message: { content: "done" } }] });
  expect(observed).toHaveLength(2);

  const wrongModel = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "another-model", messages: [] }),
  });
  expect(wrongModel.status).toBe(400);
  expect(observed).toHaveLength(2);

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

test("agent connection derives a host-private claim from the request origin", async () => {
  const { app } = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog: dynamicAgentConnectionCatalog,
    gatewayFetch: async () => Response.json({
      choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      usage: { completion_tokens: 1 },
    }),
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

test("agent connection endpoints fail closed when API or signing credentials are absent", async () => {
  const withoutApi = await makeApp(true, false, {}, {
    connectionSigningKey: agentSigningKey,
    agentConnectionCatalog,
  });
  expect((await withoutApi.app.request("/v1/agent-profiles")).status).toBe(503);
  const withoutSigning = await makeApp(true, false, {}, {
    apiToken: agentApiToken,
    agentConnectionCatalog,
  });
  expect((await withoutSigning.app.request("/v1/agent-profiles", {
    headers: agentHeaders(),
  })).status).toBe(503);
});
