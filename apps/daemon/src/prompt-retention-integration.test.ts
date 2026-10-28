import { expect, test } from "bun:test";
import { parseAgentConnectionCatalog, promptRetentionPolicySchema, type Registry } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { createAppComponents } from "./app";
import { ControlPlane } from "./controller";
import { Observer } from "./observer";

async function fixture() {
  const policy = promptRetentionPolicySchema.parse({});
  const registry: Registry = {
    nodes: [{ id: "node", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 32, reservedMemoryGB: 2 } }], profiles: [],
    runtimes: [{ id: "engine", capability: ["llm.general"], protocol: "openai.chat-completions.v1", backend: "systemd", node: "node",
      promptRetention: policy, policy: { class: "resident", lifecycle: "managed", warm: { minInstances: 1, idleTtlSeconds: 60 } },
      resources: { estimatedMemoryGB: 2, maxConcurrentAllocations: 4, maxConcurrentRequests: 4, maxQueuedRequests: 4, queueTimeoutMs: 1000 },
      deployment: { service: "fixture.service", healthPort: 8080, endpoint: "http://engine" } }],
    routes: [{ id: "route", explicitOnly: true, capabilities: ["llm.general"], candidates: [{ runtime: "engine", purpose: "primary" }] }],
  };
  const health = { runtimeId: "engine", service: "Running" as const, listening: true, healthOk: true, busy: false };
  const backend: RuntimeBackend = { list: async () => [health], health: async () => health, ensure: async () => health, stop: async () => {},
    ensureInstance: async (revision, runtime) => ({ id: "pinst_synthetic", runtimeId: runtime.id, revision: revision.revision,
      generation: 1, node: runtime.node, endpoint: runtime.deployment.endpoint, backendEndpoint: runtime.deployment.endpoint,
      status: "HOT", createdAt: new Date().toISOString() }) };
  const observer = new Observer(registry, backend); await observer.tick();
  const control = new ControlPlane(registry, backend, observer);
  const catalog = parseAgentConnectionCatalog({ version: 1, defaultAgentProfile: "test",
    audiences: { local: { network: "loopback", baseUrl: "http://127.0.0.1:9810/v1" } },
    agentProfiles: { test: { description: "synthetic", providers: [{ name: "llm", capability: "llm.general", route: "route", publicModel: "fixture", readiness: "llm-inference" }] } },
    profileSelectors: { "ornith1.5Strix-vision": { agentProfile: "test" } },
  }, registry);
  const forwarded: { body: Record<string, unknown>; headers: Headers }[] = [];
  const invalidated: string[] = [];
  const app = createAppComponents({ registry, control, getState: () => observer.getState(), agentConnectionCatalog: catalog,
    apiToken: "synthetic-owner", protectedConsumerToken: "synthetic-peer", promptRetentionKey: "f".repeat(64), connectionSigningKey: new Uint8Array(32).fill(7),
    gatewayFetch: async (url, init) => {
      const path = String(url);
      if (path.endsWith("/props")) return Response.json({ larm_prompt_cache: { enabled: true,
        authenticated: new Headers(init?.headers).get("x-larm-cache-key") === "f".repeat(64), policy } });
      if (path.endsWith("/larm/cache/invalidate")) { invalidated.push(JSON.parse(String(init?.body)).scope); return Response.json({}); }
      const body = JSON.parse(init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body));
      forwarded.push({ body, headers: new Headers(init?.headers) });
      if (body.stream) {
        const base = { id: "synthetic", object: "chat.completion.chunk", created: 1, model: "fixture" };
        return new Response([
          { ...base, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], timings: { prompt_n: 1, cache_n: 9, prompt_ms: 1 },
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_tokens_details: { cached_tokens: 9 } } },
        ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "synthetic", object: "chat.completion", created: 1, model: "fixture",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        timings: { prompt_n: 1, cache_n: 9, prompt_ms: 1 },
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_tokens_details: { cached_tokens: 9 } } });
    },
  }).app;
  const create = async (client: string, auth = "synthetic-owner") => {
    const response = await app.request("http://127.0.0.1:9810/v1/agent-connections", { method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID(), prefer: "wait=1" },
      body: JSON.stringify({ profile: "ornith1.5Strix-vision", providers: ["llm"], client, audience: "local", ttlSeconds: 120, allowFallback: false, deploymentPolicy: "existing-only" }) });
    expect(response.status).toBe(201);
    const connection = await response.json() as { id: string };
    const claim = await app.request(`http://127.0.0.1:9810/v1/agent-connections/${connection.id}/claim`, { method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify({ format: "openai-provider-v1" }) });
    expect(claim.status).toBe(200);
    const result = await claim.json() as { providers: { credential: { token: string } }[] };
    return { ...connection, auth, token: result.providers[0]!.credential.token };
  };
  const chat = (token: string, stream = false, cacheKey?: unknown) => app.request("http://127.0.0.1:9810/v1/chat/completions", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-larm-cache-key": "attacker", "x-larm-cache-context": "attacker" },
    body: JSON.stringify({ model: "fixture", stream, max_tokens: 16,
      ...(cacheKey !== undefined ? { prompt_cache_key: cacheKey } : {}), messages: [{ role: "user", content: "synthetic" }] }) });
  const release = async (connection: Awaited<ReturnType<typeof create>>) => {
    await app.request(`http://127.0.0.1:9810/v1/agent-connections/${connection.id}`, { method: "DELETE", headers: { authorization: `Bearer ${connection.auth}` } });
    await Bun.sleep(0);
  };
  return { create, chat, release, forwarded, invalidated, control };
}

test("Connection/claim/JSON/SSE forwarding shares scope while authenticating internal metadata", async () => {
  const f = await fixture();
  const a = await f.create("main");
  const b = await f.create("peer", "synthetic-peer");
  const start = f.forwarded.length;
  const json = await f.chat(a.token); expect(json.status).toBe(200);
  expect(await json.json()).toMatchObject({ usage: { prompt_tokens_details: { cached_tokens: 9 } }, timings: { cache_n: 9 } });
  const sse = await f.chat(a.token, true); expect(sse.status).toBe(200); await sse.text();
  const peer = await f.chat(b.token); expect(peer.status).toBe(200); await peer.json();
  const requests = f.forwarded.slice(start).filter(r => r.headers.has("x-larm-cache-context"));
  expect(requests).toHaveLength(3);
  const contexts = requests.map(r => JSON.parse(r.headers.get("x-larm-cache-context")!));
  expect(contexts[0].scope).toBe(contexts[1].scope);
  expect(contexts[0].instance).toBe(contexts[1].instance);
  expect(contexts[0].owner).not.toBe(contexts[2].owner);
  expect(requests.every(r => r.headers.get("x-larm-cache-key") === "f".repeat(64))).toBe(true);
  await f.release(a); expect(f.invalidated).toContain(contexts[0].scope);
  expect(f.invalidated).not.toContain(contexts[2].scope);
  const expired = await f.chat(a.token); expect(expired.status).not.toBe(200);
  await f.release(b); f.control.beginDrain(); await f.control.flush();
});

test("ordinary OpenAI requests keep a stable authenticated scope across broker allocations", async () => {
  const f = await fixture();
  try {
    for (const stream of [false, true]) {
      const response = await f.chat("synthetic-owner", stream);
      expect(response.status).toBe(200); await response.text();
    }
    const calls = f.forwarded.filter(r => r.headers.has("x-larm-cache-context"));
    expect(calls).toHaveLength(2);
    const a = JSON.parse(calls[0]!.headers.get("x-larm-cache-context")!);
    const b = JSON.parse(calls[1]!.headers.get("x-larm-cache-context")!);
    expect(a.scope).toBe(b.scope); expect(a.instance).toBe(b.instance);
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("standard cache keys survive Connection replacement, separate keys/owners, and preserve the forwarded body", async () => {
  const f = await fixture();
  const a = await f.create("keyed-a"), b = await f.create("keyed-b"), peer = await f.create("keyed-peer", "synthetic-peer");
  try {
    const start = f.forwarded.length;
    for (const [token, stream, key] of [[a.token, false, "thread-a"], [b.token, true, "thread-a"],
      [b.token, false, "thread-b"], [peer.token, false, "thread-a"]] as const) {
      const r = await f.chat(token, stream, key); expect(r.status).toBe(200); await r.text();
    }
    const calls = f.forwarded.slice(start).filter(r => r.headers.has("x-larm-cache-context"));
    const contexts = calls.map(r => JSON.parse(r.headers.get("x-larm-cache-context")!));
    expect(contexts[0].scope).toBe(contexts[1].scope);
    expect(contexts[0].scope).not.toBe(contexts[2].scope);
    expect(contexts[0].scope).not.toBe(contexts[3].scope);
    expect(calls[0]!.body.prompt_cache_key).toBe("thread-a");
    expect(calls[0]!.body.messages).toEqual([{ role: "user", content: "synthetic" }]);
    await f.release(a);
    expect(f.invalidated).not.toContain(contexts[0].scope);
    const stillLive = await f.chat(b.token, true, "thread-a"); expect(stillLive.status).toBe(200); await stillLive.text();
    const rejected = await f.chat(b.token, false, 42); expect(rejected.status).toBe(400); await rejected.text();
  } finally { await f.release(a); await f.release(b); await f.release(peer); f.control.beginDrain(); await f.control.flush(); }
});
