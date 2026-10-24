import { expect, test } from "bun:test";
import { parseAgentConnectionCatalog, type Registry, type PublicAgentConnection } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { AgentConnectionController } from "./agent-connection-controller";
import { ConnectionTokenCodec } from "./connection-token";
import { ControlPlane } from "./controller";
import { Observer } from "./observer";
import type { SemanticReadiness } from "./semantic-readiness";

async function fixture(limit = 8, idleSeconds?: number) {
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
      foreground: { description: "foreground", requestScheduling: "foreground-exclusive", schedulingPriority: 4000, ...(idleSeconds === undefined ? {} : { idleRelease: { enabled: true, idleSeconds, activityProtocols: ["openai.chat-completions.v1"] } }), providers: [provider] },
      background: { description: "background", requestScheduling: "background-when-idle", schedulingPriority: 1000, providers: [provider] },
    }, profileSelectors: { "ornith1.5Strix": { agentProfile: "foreground" }, contextStill: { agentProfile: "background" } },
  }, registry);
  const ready = { name: "llm", capability: "llm.general", ready: true, acceptingRequests: true };
  const controller = new AgentConnectionController({ control, getCatalog: () => catalog, getCatalogRevision: () => "c".repeat(64),
    semantic: { check: async () => ready, peek: () => ready } as unknown as SemanticReadiness,
    tokenCodec: new ConnectionTokenCodec(new Uint8Array(32).fill(7), () => now),
    readyTimeoutMs: 10_000, pollIntervalMs: 1, idempotencyTtlMs: idleSeconds === undefined ? 5 : 300_000, idempotencyLimit: 100, historyLimit: 1,
    random: () => "repeating-source", now: () => now,
  });
  const create = (profile: "ornith1.5Strix" | "contextStill", client: string) => controller.create({ profile, audience: "local", client,
    ttlSeconds: 120, allowFallback: false, deploymentPolicy: "existing-only" }, "owner", client, "http://127.0.0.1:9810/v1/agent-connections");
  const demand = (key: string, principal = "owner", profile: "ornith1.5Strix" | "contextStill" = "ornith1.5Strix", client = "screen", ttlSeconds = 300) =>
    controller.create({ profile, audience: "local", client, ttlSeconds, allowFallback: false, deploymentPolicy: "existing-only" },
      principal, key, "http://127.0.0.1:9810/v1/agent-connections");
  return { control, controller, create, demand, advance: (ms = 10) => { now += ms; }, now: () => now };

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

test("a failing existing invalidator does not prevent the cache purge handler", async () => {
  const f = await fixture();
  const invalidated: string[] = [];
  f.controller.setCacheInvalidator(() => { throw new Error("synthetic invalidator failure"); });
  f.controller.setCacheInvalidator(record => { invalidated.push(record.id); });
  try {
    const c = (await f.create("ornith1.5Strix", "synthetic")).body as PublicAgentConnection;
    await f.controller.release(c.id, "owner");
    await Bun.sleep(0);
    expect(invalidated).toEqual([c.id]);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("cache invalidation follows explicit release and TTL expiry once per Connection", async () => {
  const f = await fixture();
  const invalidated: string[] = [];
  f.controller.setCacheInvalidator(record => { invalidated.push(record.id); });
  const a = (await f.create("ornith1.5Strix", "cache-a")).body as PublicAgentConnection;
  const b = (await f.create("ornith1.5Strix", "cache-b")).body as PublicAgentConnection;
  await f.controller.release(a.id, "owner");
  await Bun.sleep(0);
  expect(invalidated).toEqual([a.id]);
  expect(f.controller.get(b.id, "owner").status).toBe(200);
  f.advance(121_000);
  f.controller.get(b.id, "owner");
  await Bun.sleep(0);
  expect(invalidated.sort()).toEqual([a.id, b.id].sort());
  await f.controller.release(a.id, "owner");
  expect(invalidated).toHaveLength(2);
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

test("new POST demand keeps the same connection and allocation beyond six idle minutes; replay does not extend", async () => {
  const f = await fixture(8, 300);
  try {
    const initial = await f.demand("first");
    const first = initial.body as PublicAgentConnection;
    expect(initial.replay).toBeUndefined();
    expect(first.idleReleaseAt).toBeDefined();
    for (let i = 1; i <= 13; i++) {
      f.advance(30_000);
      const result = await f.demand(`new-${i}`);
      const current = result.body as PublicAgentConnection;
      expect(result.status).toBe(201);
      expect(result.replay).toBeUndefined();
      expect(current).toMatchObject({ id: first.id, allocationId: first.allocationId, status: "ready" });
      expect(Date.parse(current.idleReleaseAt!)).toBe(f.now() + 300_000);
      expect(Date.parse(current.expiresAt)).toBe(f.now() + 300_000);
      expect(current.lastForegroundActivityAt).toBeUndefined();
      expect((await f.demand(`background-${i}`, "other", "contextStill", "screen")).status).toBe(409);
    }
    const before = f.controller.get(first.id, "owner").body as PublicAgentConnection;
    f.advance(1_000);
    expect((await f.demand("first")).replay).toBe(true);
    expect(f.controller.get(first.id, "owner").body).toEqual(before);
    expect((await f.demand("new-13")).body).toEqual(before);
    expect(f.control.getAllocation(first.allocationId)?.status).toBe("ready");
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("new demand preserves old signed credentials to their expiry, claim refreshes and explicit renew revokes", async () => {
  const f = await fixture(8, 300);
  const token = (claim: unknown) => (claim as { providers: { credential: { token: string } }[] }).providers[0]!.credential.token;
  try {
    const connection = (await f.demand("first")).body as PublicAgentConnection;
    const old = token((await f.controller.claim(connection.id, "owner", "openai-provider-v1")).body);
    f.advance(240_000);
    await f.demand("second");
    expect(f.controller.verifyProviderToken(old).record.id).toBe(connection.id);
    const fresh = token((await f.controller.claim(connection.id, "owner", "openai-provider-v1")).body);
    f.advance(61_000);
    expect(() => f.controller.verifyProviderToken(old)).toThrow();
    expect(f.controller.verifyProviderToken(fresh).record.id).toBe(connection.id);
    const before = (f.controller.get(connection.id, "owner").body as PublicAgentConnection).idleReleaseAt;
    expect((await f.controller.renew(connection.id, 900, "owner", "renew")).status).toBe(200);
    expect(() => f.controller.verifyProviderToken(fresh)).toThrow();
    const renewed = token((await f.controller.claim(connection.id, "owner", "openai-provider-v1")).body);
    f.advance(1_000);
    const demanded = (await f.demand("third")).body as PublicAgentConnection;
    expect(Date.parse(demanded.expiresAt)).toBeGreaterThanOrEqual(f.now() + 899_000);
    expect(demanded.idleReleaseAt).not.toBe(before);
    expect(f.controller.verifyProviderToken(renewed).record.id).toBe(connection.id);
    await f.controller.release(connection.id, "owner");
    expect(() => f.controller.verifyProviderToken(renewed)).toThrow();
    expect((await f.demand("first")).body).toMatchObject({ id: connection.id });
    expect(f.controller.get(connection.id, "owner").body).toMatchObject({ status: "released" });
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("concurrent demand wins through profile policy regardless of caller or client names and drains existing background execution", async () => {
  const f = await fixture(8, 300);
  try {
    const background = (await f.demand("background", "other", "contextStill", "Eumenes")).body as PublicAgentConnection;
    expect(await f.controller.beginProviderRequest(background.id, "running", "openai.chat-completions.v1")).toBe("accepted");
    const foreground = f.demand("foreground", "owner", "ornith1.5Strix", "ContextStill");
    await Bun.sleep(5);
    expect(f.controller.get(background.id, "other").body).toMatchObject({ status: "failed", error: { code: "foreground_preempted" } });
    expect((await f.demand("race-background", "other", "contextStill", "Eumenes")).status).toBe(409);
    f.controller.finishProviderRequest(background.id, "running");
    expect((await foreground).status).toBe(201);
    const [a, b, c] = await Promise.all([
      f.demand("foreground-again", "owner", "ornith1.5Strix", "ContextStill"),
      f.demand("foreground-again-2", "owner", "ornith1.5Strix", "ContextStill"),
      f.demand("race-background-2", "other", "contextStill", "Eumenes"),
    ]);
    expect((a.body as PublicAgentConnection).id).toBe((b.body as PublicAgentConnection).id);
    expect(c.status).toBe(409);
    expect(f.controller.get((a.body as PublicAgentConnection).id, "other").status).toBe(403);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("stopping new requests returns to real idle release; GET, claim, renew, replay and rejected requests cannot postpone it", async () => {
  const f = await fixture(8, 1);
  try {
    const first = (await f.demand("first")).body as PublicAgentConnection;
    f.advance(500);
    const updated = (await f.demand("second")).body as PublicAgentConnection;
    expect(Date.parse(updated.idleReleaseAt!)).toBe(Date.parse(first.idleReleaseAt!) + 500);
    f.advance(200);
    expect((await f.demand("second")).replay).toBe(true);
    expect((await f.demand("first", "owner", "ornith1.5Strix", "screen", 600)).status).toBe(409);
    expect((await f.demand("different-options", "owner", "ornith1.5Strix", "screen", 600)).status).toBe(409);
    expect((await f.controller.claim(first.id, "owner", "openai-provider-v1")).status).toBe(200);
    expect((await f.controller.renew(first.id, 900, "owner", "renew-only")).status).toBe(200);
    expect((f.controller.get(first.id, "owner").body as PublicAgentConnection).idleReleaseAt).toBe(updated.idleReleaseAt);
    f.advance(800);
    await Bun.sleep(1_050);
    expect(f.controller.get(first.id, "owner").body).toMatchObject({ status: "released", error: { code: "foreground_idle_timeout" } });
    expect((await f.demand("first")).replay).toBe(true);
    expect(f.controller.get(first.id, "owner").body).toMatchObject({ status: "released" });
    expect((await f.demand("worker-after", "other", "contextStill")).status).toBe(201);
    expect((await f.controller.renew(first.id, 300, "owner", "late-renew")).status).toBe(409);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("periodic demands recycle bounded replay capacity while the last key survives idle release", async () => {
  const f = await fixture(8, 300);
  try {
    const first = (await f.demand("first")).body as PublicAgentConnection;
    for (let i = 1; i <= 120; i++) {
      f.advance(30_000);
      const result = await f.demand(`periodic-${i}`);
      expect(result.status).toBe(201);
      expect((result.body as PublicAgentConnection).id).toBe(first.id);
    }
    const last = f.controller.get(first.id, "owner").body as PublicAgentConnection;
    f.advance(300_000);
    // Drive the same timer callback at the fixed deadline without a real
    // five-minute sleep; the independent timer test exercises actual scheduling.
    await (f.controller as unknown as { releaseIdleConnection(id: string, deadline: number): Promise<void> })
      .releaseIdleConnection(first.id, Date.parse(last.idleReleaseAt!));
    expect(f.controller.get(first.id, "owner").body).toMatchObject({ status: "released" });
    expect((await f.demand("periodic-120")).replay).toBe(true);
    expect(f.controller.get(first.id, "owner").body).toMatchObject({ status: "released" });
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("old-epoch control IDs return 410 while Provider credentials use authentication errors", async () => {
  const f = await fixture();
  const old = "aconn_epoch-previous_synthetic";
  try {
    for (const response of [f.controller.get(old, "owner"), await f.controller.health(old, "owner"),
      await f.controller.claim(old, "owner", "openai-provider-v1"), await f.controller.renew(old, 120, "owner", "synthetic-renew"),
      await f.controller.release(old, "owner")]) {
      expect(response).toMatchObject({ status: 410, body: { error: { code: "connection_epoch_expired" } } });
    }
    expect(f.controller.get("aconn_epoch-local_missing", "owner")).toMatchObject({ status: 404, body: { error: { code: "connection_not_found" } } });
    const codec = new ConnectionTokenCodec(new Uint8Array(32).fill(7), f.now);
    const now = Math.floor(f.now() / 1000);
    const token = codec.sign({ v: 1, epoch: "epoch-previous", connection: old, allocation: "old-allocation", provider: "llm", capability: "llm.general",
      audience: "local", generation: 1, iat: now, exp: now + 120 });
    expect(() => f.controller.verifyProviderToken(token)).toThrow(expect.objectContaining({ code: "invalid_token" }));
  } finally { f.control.beginDrain(); await f.control.flush(); }
});
