import { expect, test } from "bun:test";
import {
  clusterStateSchema,
  type Registry,
  type RouteShadowComparison,
} from "@larm/core";
import { ArtifactStoreError, type RuntimeBackend, type RuntimeHealth } from "@larm/backends";
import { createApp, type AppDeps } from "./app";
import type { ArtifactManager, ArtifactOperation } from "./artifact-manager";
import { ControlPlane, type ControlEvent, type ControlPlaneOptions } from "./controller";
import { MetricsRegistry, RequestTracker } from "./metrics";
import { Observer } from "./observer";

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
    configRevision: "test",
    bootEpoch: "epoch-local",
  });
  expect(res.headers.get("x-larm-boot-epoch")).toBe("epoch-local");
});

test("GET /runtimes lists registry definitions", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/runtimes");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { runtimes: { id: string; policy: { class: string } }[] };
  expect(body.runtimes.map((r) => r.id)).toEqual(["qwen-general", "qwen-worker"]);
  expect(body.runtimes[0]?.policy.class).toBe("resident");
  expect(body.runtimes[1]?.policy.class).toBe("preferred");
});

test("GET /runtimes/:id 404", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/runtimes/does-not-exist");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "runtime does-not-exist is not in the registry" },
  });
});

test("GET /state matches ClusterState schema", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/state");
  expect(res.status).toBe(200);
  const body = clusterStateSchema.parse(await res.json());
  expect(body.runtimes.find((r) => r.id === "qwen-general")?.status).toBe("HOT");
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
