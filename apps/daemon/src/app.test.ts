import { expect, test } from "bun:test";
import {
  clusterStateSchema,
  type Registry,
} from "@larm/core";
import type { RuntimeBackend, RuntimeHealth } from "@larm/backends";
import { createApp } from "./app";
import { ControlPlane } from "./controller";
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
      backend: "systemd",
      node: "ai395-01",
      policy: { class: "resident" },
      resources: { estimatedMemoryGB: 24 },
      deployment: {
        service: "llama-server.service",
        healthPort: 8080,
        endpoint: "http://127.0.0.1:8080",
        backendEndpoint: "http://127.0.0.1:8080",
      },
    },
    {
      id: "qwen-worker",
      capability: ["llm.general"],
      backend: "systemd",
      node: "ai395-01",
      policy: { class: "preferred" },
      resources: { estimatedMemoryGB: 24 },
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

async function makeApp(generalHot: boolean, workerHot = false) {
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
  });
  const app = createApp({
    registry,
    getState: () => observer.getState(),
    control,
  });
  return { app, control, log, observer };
}

test("GET /health", async () => {
  const { app } = await makeApp(true);
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
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

