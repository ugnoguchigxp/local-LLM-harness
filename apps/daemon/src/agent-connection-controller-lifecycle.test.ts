import { expect, test } from "bun:test";
import { parseAgentConnectionCatalog, type Registry, type PublicAgentConnection } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { AgentConnectionController } from "./agent-connection-controller";
import { ConnectionTokenCodec } from "./connection-token";
import { ControlPlane } from "./controller";
import { Observer } from "./observer";
import type { SemanticReadiness } from "./semantic-readiness";

async function fixture(limit = 8) {
  const registry: Registry = {
    nodes: [{ id: "node", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 32, reservedMemoryGB: 2 } }], profiles: [],
    runtimes: [{ id: "llm", capability: ["llm.general"], protocol: "openai.chat-completions.v1", backend: "systemd", node: "node",
      policy: { class: "resident" }, resources: { estimatedMemoryGB: 2, maxConcurrentAllocations: limit, maxConcurrentRequests: 1, maxQueuedRequests: 1, queueTimeoutMs: 100 },
      deployment: { service: "fixture.service", healthPort: 8080, endpoint: "http://127.0.0.1:8080" } }],
    routes: [{ id: "default", explicitOnly: true, capabilities: ["llm.general"], candidates: [{ runtime: "llm", purpose: "primary" }] }],
  };
  const health = { runtimeId: "llm", service: "Running" as const, listening: true, healthOk: true, busy: false };
  const backend: RuntimeBackend = { list: async () => [health], health: async () => health, ensure: async () => health, stop: async () => {} };
  let now = Date.now();
  const observer = new Observer(registry, backend, { now: () => now });
  await observer.tick();
  const control = new ControlPlane(registry, backend, observer, { now: () => now });
  const provider = { name: "llm", capability: "llm.general", route: "default", publicModel: "fixture", readiness: "llm-inference" };
  const catalog = parseAgentConnectionCatalog({ version: 1, defaultAgentProfile: "foreground",
    audiences: { local: { network: "loopback", baseUrl: "http://127.0.0.1:9810/v1" } },
    agentProfiles: {
      foreground: { description: "foreground", requestScheduling: "foreground-exclusive", schedulingPriority: 4000, providers: [provider] },
      background: { description: "background", requestScheduling: "background-when-idle", schedulingPriority: 1000, providers: [provider] },
    }, profileSelectors: { "ornith1.5Strix": { agentProfile: "foreground" }, contextStill: { agentProfile: "background" } },
  }, registry);
  const ready = { name: "llm", capability: "llm.general", ready: true, acceptingRequests: true };
  const controller = new AgentConnectionController({ control, getCatalog: () => catalog, getCatalogRevision: () => "c".repeat(64),
    semantic: { check: async () => ready, peek: () => ready } as unknown as SemanticReadiness,
    tokenCodec: new ConnectionTokenCodec(new Uint8Array(32).fill(7), () => now),
    readyTimeoutMs: 10_000, pollIntervalMs: 1, idempotencyTtlMs: 5, idempotencyLimit: 20, historyLimit: 1,
    random: () => "repeating-source", now: () => now,
  });
  const create = (profile: "ornith1.5Strix" | "contextStill", client: string) => controller.create({ profile, audience: "local", client,
    ttlSeconds: 120, allowFallback: false, deploymentPolicy: "existing-only" }, "owner", client, "http://127.0.0.1:9810/v1/agent-connections");
  return { control, controller, create, advance: () => { now += 10; } };
}

test("connection IDs stay unique with repeated random input; bounded history preserves the newest terminal result", async () => {
  const { controller, create, advance } = await fixture();
  const first = (await create("ornith1.5Strix", "one")).body as PublicAgentConnection;
  const second = (await create("ornith1.5Strix", "two")).body as PublicAgentConnection;
  expect(first.id).not.toBe(second.id);
  expect(first.id).toMatch(/_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  await controller.release(first.id, "owner");
  advance();
  await controller.release(second.id, "owner");
  expect(controller.get(first.id, "owner").status).toBe(404);
  expect(controller.get(second.id, "owner").body).toMatchObject({ status: "released" });
  const replacement = await create("ornith1.5Strix", "one");
  expect(replacement.status).toBe(201);
  expect((replacement.body as PublicAgentConnection).id).not.toBe(first.id);
  await controller.release((replacement.body as PublicAgentConnection).id, "owner");
});

test("foreground waits for background execution cleanup before granting a new connection", async () => {
  const { controller, control, create } = await fixture();
  const background = (await create("contextStill", "background")).body as PublicAgentConnection;
  expect(await controller.beginProviderRequest(background.id, "active", "openai.chat-completions.v1")).toBe("accepted");
  let settled = false;
  const foreground = create("ornith1.5Strix", "foreground").then(result => { settled = true; return result; });
  await Bun.sleep(5);
  expect(settled).toBe(false);
  expect(controller.get(background.id, "owner").body).toMatchObject({ status: "failed", error: { code: "foreground_preempted" } });
  controller.finishProviderRequest(background.id, "active");
  const created = await foreground;
  expect(created.status).toBe(201);
  expect(control.getAllocation(background.allocationId)?.status).toBe("released");
  await controller.release((created.body as PublicAgentConnection).id, "owner");
});

test("pending connection health reports its providers as not ready and release cancels the wait", async () => {
  const { control, controller, create } = await fixture(1);
  const held = await control.allocate({ requirements: [{ capability: "llm.general", route: "default" }], ttlSeconds: 120,
    allowFallback: false, deploymentPolicy: "existing-only", priority: 0, capacityPolicy: "reject" });
  const waiting = await create("contextStill", "waiting");
  expect(waiting).toMatchObject({ status: 202 });
  const connection = waiting.body as PublicAgentConnection;
  const result = await controller.health(connection.id, "owner");
  expect(result.status).toBe(503);
  expect(result.body).toMatchObject({ ready: false, providers: [{ name: "llm", reason: "connection_not_ready" }] });
  await controller.release(connection.id, "owner");
  await control.releaseAllocation((held.body as { id: string }).id);
  await control.flush();
});
