import { expect, test } from "bun:test";
import { parseAgentConnectionCatalog, daemonHealthSchema, agentConnectionClaimSchema, publicAgentConnectionSchema, type Registry } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { createAppComponents } from "./app";
import { ControlPlane } from "./controller";
import { Observer } from "./observer";
import { AgentConnectionController } from "./agent-connection-controller";
import { ConnectionTokenCodec } from "./connection-token";
import type { SemanticReadiness } from "./semantic-readiness";
import { gatewayStartupVerificationIntent, retainedGatewayStartupModel, verifyGatewayStartup } from "./gateway-startup";

async function fixture(warmWorker = false, ownershipClock = false) {
  let now = 0;
  const epoch = Date.now();
  const wallNow = ownershipClock ? () => epoch + now : Date.now;
  const loaded = new Set<string>();
  const starts: string[] = [], stops: string[] = [];
  const registry: Registry = {
    nodes: [{ id: "node", displayName: "test", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 64, reservedMemoryGB: 0 } }],
    profiles: [],
    runtimes: ["a", "b"].map((id, i) => ({
      id, node: "node", capability: ["llm.general"], protocol: "openai.chat-completions.v1", backend: "systemd",
      policy: { class: "preferred", lifecycle: "managed", warm: { minInstances: 0, idleTtlSeconds: 0 }, swapGroup: "llm" },
      resources: { estimatedMemoryGB: 1, maxConcurrentRequests: 1, maxQueuedRequests: 4, queueTimeoutMs: 1000 },
      deployment: { service: `${id}.service`, healthPort: 9000 + i, endpoint: `http://127.0.0.1:${9000 + i}` },
    })),
    routes: ["a", "b"].map(id => ({ id: `route-${id}`, capabilities: ["llm.general"], explicitOnly: true, candidates: [{ runtime: id, purpose: "primary" }] })),
  };
  const backend: RuntimeBackend = {
    list: async () => registry.runtimes.map(runtime => ({ runtimeId: runtime.id, service: loaded.has(runtime.id) ? "Running" : "Stopped", listening: loaded.has(runtime.id), healthOk: loaded.has(runtime.id), busy: false })),
    health: async id => ({ runtimeId: id, service: loaded.has(id) ? "Running" : "Stopped", listening: loaded.has(id), healthOk: loaded.has(id), busy: false }),
    ensure: async runtime => { starts.push(runtime.id); loaded.add(runtime.id); return { runtimeId: runtime.id, service: "Running", listening: true, healthOk: true, busy: false }; },
    stop: async id => { stops.push(id); loaded.delete(id); },
  };
  const observer = new Observer(registry, backend, { now: wallNow });
  await observer.tick();
  const control = new ControlPlane(registry, backend, observer, { idleTtlMs: 0, pollIntervalMs: 60_000, now: wallNow });
  if (warmWorker) {
    registry.runtimes[1]!.policy.warm = { minInstances: 1, idleTtlSeconds: 0 };
    await control.reconcileProviderInstances();
  }
  const catalog = parseAgentConnectionCatalog({ version: 1, defaultAgentProfile: "voice", audiences: { local: { network: "loopback", baseUrl: "http://127.0.0.1:9810/v1" } }, agentProfiles: {
    voice: { description: "protected", requestScheduling: "foreground-exclusive", schedulingPriority: 4000, usageProtection: { idleSeconds: 600, retention: "until-next-profile" }, idleRelease: { enabled: true, idleSeconds: 300, activityProtocols: ["openai.chat-completions.v1"] }, providers: [{ name: "llm", capability: "llm.general", route: "route-a", publicModel: "model-a", readiness: "llm-inference" }] },
    worker: { description: "worker", requestScheduling: "background-when-idle", schedulingPriority: 1000, providers: [{ name: "llm", capability: "llm.general", route: "route-b", publicModel: "model-b", readiness: "llm-inference" }] },
  }, profileSelectors: { "ornith1.5Strix": { agentProfile: "voice" }, contextStill: { agentProfile: "worker" } } }, registry);
  let failReadiness = false;
  let readinessHook: (() => Promise<void>) | undefined;
  const connections = new AgentConnectionController({ control, getCatalog: () => catalog, getCatalogRevision: () => "test", tokenCodec: new ConnectionTokenCodec(new Uint8Array(32).fill(1), wallNow), semantic: { peek: ({ provider }: { provider: { name: string; capability: string } }) => ({ name: provider.name, capability: provider.capability, ready: true, acceptingRequests: true }), check: async ({ provider }: { provider: { name: string; capability: string } }) => { await readinessHook?.(); if (failReadiness) throw new Error("synthetic readiness failure"); return { name: provider.name, capability: provider.capability, ready: true, acceptingRequests: true }; } } as unknown as SemanticReadiness, now: wallNow, readyTimeoutMs: 3000, pollIntervalMs: 60_000, idempotencyTtlMs: 1000, idempotencyLimit: 100 });
  let finishStream: (() => void) | undefined;
  let fetches = 0;
  const { app } = createAppComponents({ registry, control, getState: () => observer.getState(), apiToken: "shared", protectedConsumerToken: "consumer", usageMonotonicNow: () => now, agentConnectionCatalog: catalog, agentConnectionController: connections, connectionSigningKey: new Uint8Array(32).fill(1), gatewayFetch: async (_input, init) => {
    fetches++;
    const input = JSON.parse(await new Response(init?.body as ConstructorParameters<typeof Response>[0]).text());
    if (input.stream) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"model-a","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n'));
      finishStream = () => { try { controller.enqueue(new TextEncoder().encode('data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"model-a","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); controller.close(); } catch {} };
    } }), { headers: { "content-type": "text/event-stream" } });
    return Response.json({ id: "x", object: "chat.completion", created: 1, model: input.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  } });
  let sequence = 0;
  const post = (path: string, token: string, body: unknown, extra: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
  const create = async (profile: string, token: string) => post("/v1/agent-connections", token, { profile: profile === "voice" ? "ornith1.5Strix" : "contextStill", audience: "local", ttlSeconds: 3600, allowFallback: false, deploymentPolicy: "existing-only" }, { "idempotency-key": `create-${++sequence}`, prefer: "wait=3" });
  const claim = async (id: string, token: string) => {
    const response = await post(`/v1/agent-connections/${id}/claim`, token, { format: "openai-provider-v1" });
    expect(response.status).toBe(200);
    return agentConnectionClaimSchema.parse(await response.json()).providers[0]!.credential.token as string;
  };
  return { app, registry, catalog, wallNow, advance: async (ms: number) => { now += ms; await observer.tick(); }, getState: () => observer.getState(), setReadinessHook: (hook?: () => Promise<void>) => { readinessHook = hook; }, failReadiness: (value: boolean) => { failReadiness = value; }, control, connections, loaded, starts, stops, post, create, claim, setNow: (value: number) => { now = value; }, finishStream: () => finishStream?.(), fetches: () => fetches };
}

test("protected profile rejects all other entry points and retains its model after 10 minutes", async () => {
  const f = await fixture();
  try {
    const forbidden = await f.create("voice", "shared"); expect(forbidden.status).toBe(403);
    const response = await f.create("voice", "consumer"); expect(response.status).toBe(201);
    const connection = publicAgentConnectionSchema.parse(await response.json());
    const bearer = await f.claim(connection.id, "consumer");
    expect((await f.app.request(`/v1/agent-connections/${connection.id}/providers/llm/health`, { headers: { authorization: "Bearer consumer" } })).status).toBe(200);
    for (const path of ["/v1/chat/completions", "/v1/audio/transcriptions", "/v1/audio/speech", "/v1/embed", "/v1/systemone", "/v1/images/generations", "/v1/music/generations", "/v1/allocations", "/v1/contexts"]) {
      const denied = await f.post(path, "shared", {});
      expect(denied.status).toBe(409); expect((await denied.json() as { error: { code: string } }).error.code).toBe("foreground_protected");
    }
    expect((await f.create("worker", "shared")).status).toBe(409);
    expect(f.fetches()).toBe(0); expect(f.starts).toEqual(["a"]);
    f.setNow(100_000);
    const valid = await f.post("/v1/chat/completions", bearer, { model: "model-a", messages: [{ role: "user", content: "hello" }] });
    expect(valid.status).toBe(200); await valid.text(); await Bun.sleep(0);
    f.setNow(699_999); expect((await f.create("worker", "shared")).status).toBe(409);
    f.setNow(700_000);
    await Bun.sleep(1); expect(f.loaded.has("a")).toBe(true); expect(f.stops).toEqual([]);
    const next = await f.create("worker", "shared"); expect(next.status).toBe(201);
    expect(f.starts).toEqual(["a", "b"]); expect(f.stops).toEqual(["a"]);
    expect(f.control.getAllocationWaiterCount()).toBe(0);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("streaming requests remain protected past 10 minutes, and invalid input does not extend protection", async () => {
  const f = await fixture();
  try {
    const created = await f.create("voice", "consumer"); expect(created.status).toBe(201);
    const bearer = await f.claim(publicAgentConnectionSchema.parse(await created.json()).id, "consumer");
    f.setNow(100_000);
    const invalid = await f.post("/v1/chat/completions", bearer, {}); expect(invalid.status).toBe(400);
    expect(f.control.usage!.protection.snapshot().remainingMs).toBe(500_000);
    const stream = await f.post("/v1/chat/completions", bearer, { model: "model-a", messages: [{ role: "user", content: "hello" }], stream: true });
    expect(stream.status).toBe(200);
    const body = stream.text();
    f.setNow(900_000);
    expect((await f.create("worker", "shared")).status).toBe(409);
    expect(f.control.usage!.protection.snapshot().activeRequests).toBe(1);
    f.finishStream(); await body; await Bun.sleep(0);
    expect(f.control.usage!.protection.snapshot()).toMatchObject({ activeRequests: 0, remainingMs: 600_000 });
  } finally { f.finishStream(); f.control.beginDrain(); await f.control.flush(); }
});

test("owner reconnect reuses the model and a later return retires the intervening profile", async () => {
  const f = await fixture();
  try {
    const first = publicAgentConnectionSchema.parse(await (await f.create("voice", "consumer")).json());
    f.setNow(100_000);
    expect((await f.app.request(`/v1/agent-connections/${first.id}`, { method: "DELETE", headers: { authorization: "Bearer consumer" } })).status).toBe(204);
    const again = await f.create("voice", "consumer"); expect(again.status).toBe(201);
    expect(f.starts).toEqual(["a"]); expect(f.stops).toEqual([]);
    expect(f.control.getUsageState().remainingMs).toBe(500_000);
    f.setNow(600_000);
    expect((await f.create("worker", "shared")).status).toBe(201);
    expect((await f.create("voice", "consumer")).status).toBe(201);
    expect(f.starts).toEqual(["a", "b", "a"]);
    expect(f.stops).toEqual(["a", "b"]);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("client and profile names do not grant ownership, and cancel releases protection references", async () => {
  const f = await fixture();
  try {
    const created = publicAgentConnectionSchema.parse(await (await f.create("voice", "consumer")).json());
    const bearer = await f.claim(created.id, "consumer");
    const spoofed = await f.post("/v1/agent-connections", "shared", { profile: "ornith1.5Strix", client: "Eumenes", audience: "local", ttlSeconds: 60 }, { "idempotency-key": "spoof" });
    expect(spoofed.status).toBe(409);
    const response = await f.post("/v1/chat/completions", bearer, { model: "model-a", messages: [{ role: "user", content: "hello" }], stream: true });
    f.setNow(800_000);
    await response.body!.cancel(); await Bun.sleep(0);
    expect(f.control.getUsageState()).toMatchObject({ activeRequests: 0, remainingMs: 600_000 });
    expect(f.control.getAllocationWaiterCount()).toBe(0);
  } finally { f.finishStream(); f.control.beginDrain(); await f.control.flush(); }
});

test("selected profile replaces a conflicting warm floor without restarting that floor", async () => {
  const f = await fixture(true);
  try {
    expect(f.starts).toEqual(["b"]);
    expect((await f.create("voice", "consumer")).status).toBe(201);
    expect(f.starts).toEqual(["b", "a"]);
    expect(f.stops).toEqual(["b"]);
    await f.control.reconcileProviderInstances();
    expect(f.starts).toEqual(["b", "a"]);
    expect(f.control.getUsageState().retainedRuntimeIds).toEqual(["a"]);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("failed handover drops new retention and permits a clean retry", async () => {
  const f = await fixture();
  try {
    expect((await f.create("voice", "consumer")).status).toBe(201);
    f.setNow(600_000); f.failReadiness(true);
    expect((await f.create("worker", "shared")).status).toBe(500);
    await Bun.sleep(0);
    expect(f.control.getUsageState()).toMatchObject({ protected: false, preparing: 0, retainedRuntimeIds: [], allocationWaiters: 0 });
    expect(f.stops).toEqual(["a", "b"]);
    f.failReadiness(false);
    expect((await f.create("voice", "consumer")).status).toBe(201);
    expect(f.control.getUsageState()).toMatchObject({ protected: true, preparing: 0, retainedRuntimeIds: ["a"] });
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("restored intent protects the consumer and selects a matching startup probe", async () => {
  const f = await fixture();
  try {
    f.control.restoreUsageRetention(["a"], true);
    await f.control.reconcileProviderInstances();
    expect(f.starts).toEqual([]);
    expect(f.control.getUsageState()).toMatchObject({ protected: true, remainingMs: 600_000, retainedRuntimeIds: ["a"] });
    expect((await f.create("worker", "shared")).status).toBe(409);
    expect(retainedGatewayStartupModel(f.catalog, f.registry, ["a"], f.getState())).toBe("model-a");
    expect(retainedGatewayStartupModel(f.catalog, f.registry, ["b"], f.getState())).toBe("model-b");
    expect(retainedGatewayStartupModel(f.catalog, f.registry, [], f.getState())).toBeUndefined();
    const health = await (await f.app.request("/health")).json() as { usageProtection: { retainedRuntimeIds: string[] } };
    expect(health.usageProtection.retainedRuntimeIds).toEqual(["a"]);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});


test("releasing an allocation during readiness cannot resurrect retention or protection", async () => {
  const f = await fixture();
  let resume!: () => void;
  let checking!: () => void;
  const started = new Promise<void>(resolve => { checking = resolve; });
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  f.setReadinessHook(async () => { checking(); await blocked; });
  const pending = f.create("voice", "consumer");
  try {
    await started;
    const allocation = f.control.getAllocations().find(allocation => allocation.status === "ready")!;
    await f.control.releaseAllocation(allocation.id);
    resume();
    expect((await pending).status).toBe(503);
    expect(f.control.getUsageState()).toMatchObject({ protected: false, preparing: 0, retainedRuntimeIds: [] });
  } finally { resume(); await pending; f.control.beginDrain(); await f.control.flush(); }
});

test("handover readiness and rollback belong to the accepted allocation", async () => {
  const f = await fixture();
  let resume!: () => void;
  let checking!: () => void;
  const started = new Promise<void>(resolve => { checking = resolve; });
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  let pending: Promise<Response> | undefined;
  try {
    expect((await f.create("voice", "consumer")).status).toBe(201);
    const oldId = f.control.getAllocations().find(allocation => allocation.status === "ready")!.id;
    f.setNow(600_000);
    f.setReadinessHook(async () => { checking(); await blocked; });
    pending = f.create("worker", "shared");
    await started;
    f.control.completeUsageHandover(oldId);
    f.control.rollbackUsageProfile(oldId);
    expect(f.control.getUsageState().retainedRuntimeIds).toEqual(["b"]);
    const overlapping = await f.post("/v1/allocations", "shared", { requirements: [{ capability: "llm.general", route: "route-a" }], ttlSeconds: 60, allowFallback: false, deploymentPolicy: "existing-only" });
    expect(overlapping.status).toBe(409);
    expect(f.control.getUsageState().retainedRuntimeIds).toEqual(["b"]);
    resume();
    expect((await pending).status).toBe(201);
    expect(f.control.getUsageState()).toMatchObject({ protected: false, retainedRuntimeIds: ["b"] });
  } finally { resume(); await pending; f.control.beginDrain(); await f.control.flush(); }
});

test("allocation API completes handover when runtime readiness succeeds", async () => {
  const f = await fixture();
  const request = (route: string) => f.post("/v1/allocations", "shared", { requirements: [{ capability: "llm.general", route }], ttlSeconds: 60, allowFallback: false, deploymentPolicy: "existing-only" });
  try {
    expect((await f.create("voice", "consumer")).status).toBe(201);
    f.setNow(600_000);
    expect((await request("route-b")).status).toBe(202);
    await f.control.flush();
    expect(f.control.getAllocations().find(allocation => allocation.status === "ready")?.bindings[0]?.runtime).toBe("b");
    expect((await request("route-a")).status).toBe(202);
    await f.control.flush();
    expect(f.control.getUsageState().retainedRuntimeIds).toEqual(["a"]);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});


test("startup probe follows route resolution instead of selecting a retained fallback", async () => {
  const f = await fixture();
  try {
    f.registry.routes.find(route => route.id === "route-a")!.candidates = [
      { runtime: "b", purpose: "primary" }, { runtime: "a", purpose: "fallback" },
    ];
    expect(retainedGatewayStartupModel(f.catalog, f.registry, ["a"], f.getState())).toBeUndefined();
    f.registry.routes.find(route => route.id === "route-a")!.candidates[1]!.purpose = "primary";
    expect(retainedGatewayStartupModel(f.catalog, f.registry, ["a"], f.getState())).toBeUndefined();
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("uncertain retention or a different probe override cannot start another profile", async () => {
  const f = await fixture();
  const calls: string[] = [];
  try {
    for (const state of [
      { retainedRuntimeIds: ["a"], probeModel: "model-b" },
      { retainedRuntimeIds: [], retentionUncertain: true },
    ]) {
      const intent = gatewayStartupVerificationIntent({ catalog: f.catalog, registry: f.registry, state: f.getState(), ...state });
      expect(intent.catalogOnly).toBe(true);
      await verifyGatewayStartup({ ...intent, baseUrl: "http://larm", startupProbeToken: "probe", timeoutMs: 1000, fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] });
      }) as typeof fetch });
    }
    expect(calls).toEqual(["GET http://larm/v1/models", "GET http://larm/v1/models"]);
    expect(gatewayStartupVerificationIntent({ catalog: f.catalog, registry: f.registry, state: f.getState(), retainedRuntimeIds: ["a"] })).toMatchObject({ model: "model-a", probeModel: "model-a", catalogOnly: false });
    expect(f.starts).toEqual([]);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

function ownershipRequests(f: Awaited<ReturnType<typeof fixture>>) {
  const id = crypto.randomUUID();
  let next = 0;
  const input = { profile: "ornith1.5Strix", audience: "local", client: "screen", ttlSeconds: 300,
    ownership: { id, issuedAt: new Date(f.wallNow()).toISOString() } };
  const create = async (key = `acquire-${++next}`, body: unknown = input, token = "consumer") =>
    f.post("/v1/agent-connections", token, body, { "idempotency-key": key, prefer: "wait=3" });
  const update = (connectionId: string, sequence: number | undefined, key = `heartbeat-${++next}`, token = "consumer", ownershipId = id) =>
    f.app.request(`/v1/agent-connections/${connectionId}/ownership`, {
      method: sequence === undefined ? "DELETE" : "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ id: ownershipId, ...(sequence === undefined ? {} : { sequence }) }),
    });
  return { id, input, create, update };
}

test("screen heartbeats cross idle and credential boundaries without inference; release restores background admission", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  try {
    const connection = publicAgentConnectionSchema.parse(await (await h.create()).json());
    const oldToken = await f.claim(connection.id, "consumer");
    expect(f.control.getUsageState()).toMatchObject({ protected: true, remainingMs: 0 });
    for (let sequence = 1; sequence <= 12; sequence++) {
      await f.advance(30_000);
      // Renewal remains explicit and immediately invalidates the old provider token.
      if (sequence === 8) {
        const renewed = await f.post(`/v1/agent-connections/${connection.id}/renew`, "consumer", { ttlSeconds: 300 }, { "idempotency-key": "renew-held" });
        expect(renewed.status).toBe(200);
        expect(() => f.connections.verifyProviderToken(oldToken)).toThrow();
        await f.claim(connection.id, "consumer");
      }
      const held = await h.update(connection.id, sequence);
      expect(held.status).toBe(200);
      expect(publicAgentConnectionSchema.parse(await held.json())).toMatchObject({ id: connection.id, status: "ready", ownership: { state: "active", sequence } });
      expect((await f.create("worker", "shared")).status).toBe(409);
    }
    expect(f.fetches()).toBe(0);
    expect(f.stops).toEqual([]);
    expect((await h.update(connection.id, undefined)).status).toBe(200);
    expect((await h.update(connection.id, 13)).status).toBe(410);
    await Bun.sleep(1); // overdue idle timer resumes without fabricating activity
    const released = await f.app.request(`/v1/agent-connections/${connection.id}`, { headers: { authorization: "Bearer consumer" } });
    expect(await released.json()).toMatchObject({ status: "released", ownership: { state: "released" } });
    expect((await f.create("worker", "shared")).status).toBe(201);
    expect(f.fetches()).toBe(0);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("heartbeat replay, out-of-order delivery, release, and delayed acquisition never revive ownership", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  try {
    const connection = publicAgentConnectionSchema.parse(await (await h.create("original")).json());
    await f.advance(30_000);
    const first = publicAgentConnectionSchema.parse(await (await h.update(connection.id, 2, "hb")).json());
    await f.advance(30_000);
    const replay = await h.update(connection.id, 2, "hb");
    expect(replay.headers.get("x-larm-idempotent-replay")).toBe("true");
    expect(publicAgentConnectionSchema.parse(await replay.json()).ownership?.expiresAt).toBe(first.ownership?.expiresAt);
    expect((await h.update(connection.id, 1)).status).toBe(409);
    expect((await h.update(connection.id, 2)).status).toBe(409);
    const reused = publicAgentConnectionSchema.parse(await (await h.create()).json());
    expect(reused.ownership?.expiresAt).toBe(first.ownership?.expiresAt);
    expect((await h.update(connection.id, undefined, "release")).status).toBe(200);
    expect((await h.update(connection.id, 3)).status).toBe(410);
    expect((await h.update(connection.id, undefined, "release")).status).toBe(200);
    // A delayed successful heartbeat response may be replayed, but has no side effect.
    expect((await h.update(connection.id, 2, "hb")).status).toBe(200);
    expect(f.control.getUsageState().protected).toBe(false);
    await f.app.request(`/v1/agent-connections/${connection.id}`, { method: "DELETE", headers: { authorization: "Bearer consumer" } });
    expect((await h.create("different-key")).status).toBe(409);
    await f.advance(31_000);
    expect((await h.create("too-late")).status).toBe(410);
    expect((await f.create("worker", "shared")).status).toBe(201);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("ownership expires at 90 seconds; renew and reclaim do not extend it", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  try {
    const connection = publicAgentConnectionSchema.parse(await (await h.create()).json());
    await f.advance(60_000);
    expect((await f.post(`/v1/agent-connections/${connection.id}/renew`, "consumer", { ttlSeconds: 300 }, { "idempotency-key": "renew" })).status).toBe(200);
    await f.claim(connection.id, "consumer");
    await f.advance(29_999);
    expect((await f.create("worker", "shared")).status).toBe(409);
    await f.advance(1);
    expect((await h.update(connection.id, 1)).status).toBe(410);
    expect((await f.create("worker", "shared")).status).toBe(201);
    expect((await h.update(connection.id, 2)).status).toBe(409);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("consumer authority is required; client names, provider tokens, and body priorities grant no hold", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  try {
    expect((await h.create("spoof", { ...h.input, client: "Eumenes" }, "shared")).status).toBe(403);
    expect((await h.create("priority", { ...h.input, priority: 999999 })).status).toBe(400);
    expect((await h.create("anonymous", h.input, "invalid")).status).toBe(401);
    const connection = publicAgentConnectionSchema.parse(await (await h.create()).json());
    const token = await f.claim(connection.id, "consumer");
    expect((await h.update(connection.id, 1, "shared", "shared")).status).toBe(403);
    expect((await h.update(connection.id, 1, "provider", token)).status).toBe(401);
    expect((await h.update(connection.id, 1, "wrong-id", "consumer", crypto.randomUUID())).status).toBe(409);
    const conflict = await h.update(connection.id, 2, "same"); expect(conflict.status).toBe(200);
    expect((await h.update(connection.id, 3, "same")).status).toBe(409);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("a held foreground takes over an existing background through normal preemption", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  try {
    const worker = publicAgentConnectionSchema.parse(await (await f.create("worker", "shared")).json());
    expect((await h.create()).status).toBe(201);
    expect(f.control.getAllocation(worker.allocationId)?.status).toBe("released");
    expect((await f.create("worker", "shared")).status).toBe(409);
    expect(f.fetches()).toBe(0);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("overlapping foreground acquisition and repeated background creation cannot steal an accepted hold", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  let resume!: () => void, checking!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { checking = resolve; });
  f.setReadinessHook(async () => { checking(); await blocked; });
  const pending = h.create();
  try {
    await started;
    const workers = await Promise.all(Array.from({ length: 6 }, () => f.create("worker", "shared")));
    expect(workers.map(response => response.status)).toEqual([409, 409, 409, 409, 409, 409]);
    resume();
    const connection = publicAgentConnectionSchema.parse(await (await pending).json());
    const updates = await Promise.all([h.update(connection.id, 1), h.update(connection.id, 2), f.create("worker", "shared")]);
    expect(updates.map(response => response.status)).toEqual([200, 200, 409]);
  } finally { resume(); await pending; f.control.beginDrain(); await f.control.flush(); }
});

test("screen ownership is not persisted as a legacy 600-second priority after daemon restart", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  const persisted: boolean[] = [];
  f.control.setUsageRetentionListener((_ids, legacyProtected) => persisted.push(legacyProtected));
  try {
    expect((await h.create()).status).toBe(201);
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.every(value => value === false)).toBe(true);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("held foreground waits for background request cleanup before accepting the handover", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  let pending: Promise<Response> | undefined;
  try {
    const worker = publicAgentConnectionSchema.parse(await (await f.create("worker", "shared")).json());
    expect(await f.connections.beginProviderRequest(worker.id, "running", "openai.chat-completions.v1")).toBe("accepted");
    let settled = false;
    pending = h.create().then(response => { settled = true; return response; });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    expect(f.control.getAllocation(worker.allocationId)?.status).toBe("released");
    f.connections.finishProviderRequest(worker.id, "running");
    expect((await pending).status).toBe(201);
  } finally { await pending; f.control.beginDrain(); await f.control.flush(); }
});

test("credential expiry ends admission protection even when the screen lease would still be active", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  try {
    const connection = publicAgentConnectionSchema.parse(await (await h.create("short-credential", { ...h.input, ttlSeconds: 30 })).json());
    await f.advance(30_000);
    expect((await h.update(connection.id, 1)).status).toBe(410);
    expect(f.control.getUsageState().protected).toBe(false);
    expect((await f.create("worker", "shared")).status).toBe(201);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("long-running ownership reclaims heartbeat replay capacity without releasing and reacquiring", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  try {
    const connection = publicAgentConnectionSchema.parse(await (await h.create()).json());
    for (let sequence = 1; sequence <= 120; sequence++) {
      await f.advance(30_000);
      if (sequence % 8 === 0) {
        expect((await f.post(`/v1/agent-connections/${connection.id}/renew`, "consumer", { ttlSeconds: 300 }, { "idempotency-key": `renew-${sequence}` })).status).toBe(200);
      }
      expect((await h.update(connection.id, sequence)).status).toBe(200);
    }
    expect(f.control.getUsageState().protected).toBe(true);
    expect(f.starts).toEqual(["a"]);
    expect(f.fetches()).toBe(0);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});


test("protected consumer health remains compatible with the public client and OpenAPI schema", async () => {
  const f = await fixture(false, true), h = ownershipRequests(f);
  try {
    expect((await h.create()).status).toBe(201);
    const response = await f.app.request("/health");
    expect(daemonHealthSchema.parse(await response.json()).usageProtection).toMatchObject({
      enabled: true, protected: true, remainingMs: 0, retainedRuntimeIds: ["a"],
    });
  } finally { f.control.beginDrain(); await f.control.flush(); }
});
