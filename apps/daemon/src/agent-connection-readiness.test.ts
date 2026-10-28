import { expect, test } from "bun:test";
import { agentConnectionClaimSchema, parseAgentConnectionCatalog, publicAgentConnectionSchema, type AgentProviderHealth, type PublicAgentConnection, type Registry } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { createAppComponents } from "./app";
import { agentPrincipal, AgentConnectionController } from "./agent-connection-controller";
import { ConnectionTokenCodec } from "./connection-token";
import { ControlPlane, type ControlEvent } from "./controller";
import { Observer } from "./observer";
import { UsageCoordinator } from "./usage-coordinator";
import type { SemanticReadiness } from "./semantic-readiness";

async function fixture(options: {
  limit?: number;
  timeoutMs?: number;
  check?: (name: string) => Promise<AgentProviderHealth>;
  cold?: string[];
  unavailableLlm?: boolean;
  protectedProfile?: boolean;
  audioLimit?: number;
  onControlEvent?: (event: ControlEvent) => void;
  ensure?: (name: string, signal?: AbortSignal) => Promise<void>;
} = {}) {
  let offset = 0;
  const now = () => Date.now() + offset;
  const providers = [
    { name: "llm", capability: "llm.general", protocol: "openai.chat-completions.v1", readiness: "llm-inference" },
    { name: "asr", capability: "speech.stt", protocol: "openai.audio-transcriptions.v1", readiness: "stt-transcription" },
    { name: "tts", capability: "speech.tts", protocol: "openai.audio-speech.v1", readiness: "tts-speech" },
  ] as const;
  const registry: Registry = {
    nodes: [{ id: "node", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 32, reservedMemoryGB: 2 } }], profiles: [],
    runtimes: providers.map(p => ({ id: p.name, capability: [p.capability], protocol: p.protocol, backend: "systemd", node: "node",
      policy: options.cold?.includes(p.name) ? { class: "preferred", lifecycle: "managed", warm: { minInstances: 0, idleTtlSeconds: 60 } } : { class: "resident" }, resources: { estimatedMemoryGB: 1, ...(p.name === "llm" ? { maxConcurrentAllocations: options.limit ?? 4 } : options.audioLimit ? { maxConcurrentAllocations: options.audioLimit } : {}), maxConcurrentRequests: 4, maxQueuedRequests: 4, queueTimeoutMs: 100 },
      deployment: { service: `${p.name}.service`, healthPort: 8080, endpoint: "http://127.0.0.1:8080" } })),
    routes: providers.map(p => ({ id: p.name, explicitOnly: true, capabilities: [p.capability], candidates: [{ runtime: p.name, purpose: "primary" }] })),
  };
  const loaded = new Set(providers.map(p => p.name).filter(name => !options.cold?.includes(name) && !(name === "llm" && options.unavailableLlm)));
  const health = (runtimeId: string) => ({ runtimeId, service: loaded.has(runtimeId as "llm" | "asr" | "tts") ? "Running" as const : "Stopped" as const,
    listening: loaded.has(runtimeId as "llm" | "asr" | "tts"), healthOk: loaded.has(runtimeId as "llm" | "asr" | "tts"), busy: false });
  const backend: RuntimeBackend = { list: async () => providers.map(p => health(p.name)), health: async runtime => health(runtime),
    ensure: async (runtime, signal) => { await options.ensure?.(runtime.id, signal); loaded.add(runtime.id as "llm" | "asr" | "tts"); return health(runtime.id); }, stop: async () => {} };
  const observer = new Observer(registry, backend, { now });
  await observer.tick();
  const control = new ControlPlane(registry, backend, observer, { now, onEvent: options.onControlEvent });
  const catalog = parseAgentConnectionCatalog({ version: 1, defaultAgentProfile: "voice", audiences: { local: { network: "loopback", baseUrl: "http://127.0.0.1:9810/v1" } },
    agentProfiles: { voice: { description: "voice", ...(options.protectedProfile ? { usageProtection: { idleSeconds: 600, retention: "until-next-profile" } } : {}), providers: providers.map(p => ({ name: p.name, capability: p.capability, readiness: p.readiness, route: p.name, publicModel: p.name })) } },
    profileSelectors: { "ornith1.5Strix-vision": { agentProfile: "voice" } },
  }, registry);
  const ready = (name: string): AgentProviderHealth => ({ name, capability: providers.find(p => p.name === name)!.capability, ready: true, acceptingRequests: true });
  const calls: string[] = [];
  const events: { name: string; labels: Record<string, string> }[] = [];
  const controller = new AgentConnectionController({ control, getCatalog: () => catalog, getCatalogRevision: () => "a".repeat(64),
    semantic: { check: async ({ provider }: { provider: { name: string } }) => { calls.push(provider.name); return options.check ? options.check(provider.name) : ready(provider.name); }, peek: ({ provider }: { provider: { name: string } }) => ready(provider.name) } as unknown as SemanticReadiness,
    tokenCodec: new ConnectionTokenCodec(new Uint8Array(32).fill(7), now), now,
    readyTimeoutMs: options.timeoutMs ?? 60_000, pollIntervalMs: 1, idempotencyTtlMs: 1000, idempotencyLimit: 100,
    onEvent: event => events.push(event),
  });
  const create = (client: string, key = client, subset?: string[]) => controller.create({ profile: "ornith1.5Strix-vision", client, audience: "local", ...(subset ? { providers: subset } : {}), ttlSeconds: 120, allowFallback: false, deploymentPolicy: "existing-only" }, "owner", key, "http://127.0.0.1:9810/v1/agent-connections");
  return { registry, catalog, observer, controller, control, create, calls, events, ready, setLoaded: (name: "llm" | "asr" | "tts", value: boolean) => { if (value) loaded.add(name); else loaded.delete(name); }, advance: (ms: number) => { offset += ms; } };
}

test("a stalled ASR or LLM cannot delay TTS claim, while whole-connection readiness stays truthful", async () => {
  let completeAsr!: () => void;
  const asr = new Promise<void>(resolve => { completeAsr = resolve; });
  const f = await fixture({ check: async name => {
    if (name === "asr") await asr;
    if (name === "llm") return await new Promise<AgentProviderHealth>(() => {});
    return f.ready(name);
  } });
  try {
    const started = performance.now();
    const result = await f.create("voice");
    expect(performance.now() - started).toBeLessThan(2000);
    const id = (result.body as PublicAgentConnection).id;
    await Bun.sleep(1);
    expect(new Set(f.calls)).toEqual(new Set(["asr", "llm", "tts"]));
    const partial = publicAgentConnectionSchema.parse(f.controller.get(id, "owner").body);
    expect(partial.status).toBe("probing");
    expect(Object.fromEntries(partial.providers.map(p => [p.name, p.readiness]))).toEqual({ asr: "probing", llm: "probing", tts: "ready" });
    expect((await f.controller.claim(id, "owner", "openai-provider-v1", false, ["tts"])).status).toBe(200);
    expect((await f.controller.claim(id, "owner", "openai-provider-v1")).status).toBe(409);
    completeAsr();
    await Bun.sleep(1);
    expect((await f.controller.claim(id, "owner", "openai-provider-v1", false, ["asr", "tts"])).status).toBe(200);
    expect((await f.controller.providerHealth(id, "tts", "owner")).status).toBe(200);
    await f.controller.release(id, "owner");
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("full LLM KV allocation capacity does not block audio allocation or revoke audio on LLM timeout", async () => {
  const f = await fixture({ limit: 1 });
  try {
    const held = (await f.create("held", "held", ["llm"])).body as PublicAgentConnection;
    const result = await f.create("voice");
    expect(result.status).toBe(202);
    const parent = publicAgentConnectionSchema.parse(result.body);
    await Bun.sleep(1);
    const partial = publicAgentConnectionSchema.parse(f.controller.get(parent.id, "owner").body);
    expect(partial.providers.find(p => p.name === "asr")?.readiness).toBe("ready");
    expect(partial.providers.find(p => p.name === "tts")?.readiness).toBe("ready");
    expect(f.control.getAllocationWaitReason(parent.allocationId)).toEqual({ reason: "runtime_capacity", runtime: "llm" });
    const claim = await f.controller.claim(parent.id, "owner", "openai-provider-v1", false, ["asr", "tts"]);
    expect(claim.status).toBe(200);
    const tokens = (claim.body as { providers: { credential: { token: string } }[] }).providers.map(p => p.credential.token);
    const snapshots = f.control.getAllocations().map(a => ({ id: a.id, bindings: a.bindings }));
    expect(snapshots.find(a => a.id === parent.allocationId)?.bindings.map(b => b.runtime)).toEqual(["llm"]);
    f.advance(60_001);
    const failed = publicAgentConnectionSchema.parse(f.controller.get(parent.id, "owner").body);
    expect(failed.status).toBe("failed");
    expect(failed.providers.find(p => p.name === "tts")?.readiness).toBe("ready");
    for (const token of tokens) expect(f.controller.verifyProviderToken(token).record.status).toBe("ready");
    expect((await f.controller.claim(parent.id, "owner", "openai-provider-v1", false, ["asr"])).status).toBe(200);
    expect((await f.controller.renew(parent.id, 120, "owner", "renew-after-llm-timeout")).status).toBe(200);
    for (const token of tokens) expect(() => f.controller.verifyProviderToken(token)).toThrow();
    expect((await f.controller.claim(parent.id, "owner", "openai-provider-v1", false, ["asr", "tts"])).status).toBe(200);
    expect(f.control.getAllocation(held.allocationId)?.status).toBe("ready");
    await f.controller.release(parent.id, "owner");
    for (const token of tokens) expect(() => f.controller.verifyProviderToken(token)).toThrow();
    expect(f.control.getAllocation(held.allocationId)?.status).toBe("ready");
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("warm repeated demand preserves each allocation and credentials while another LLM request is active", async () => {
  const f = await fixture();
  try {
    const initial = (await f.create("voice")).body as PublicAgentConnection;
    await Bun.sleep(1);
    expect((f.controller.get(initial.id, "owner").body as PublicAgentConnection).status).toBe("ready");
    const other = (await f.create("other", "other", ["llm"])).body as PublicAgentConnection;
    await f.controller.beginProviderRequest(other.id, "synthetic-generation", "openai.chat-completions.v1");
    const claim = (await f.controller.claim(initial.id, "owner", "openai-provider-v1")).body as { providers: { credential: { token: string } }[] };
    const count = f.calls.length;
    const allocations = f.control.getAllocations().map(a => a.id);
    const repeated = publicAgentConnectionSchema.parse((await f.create("voice", "new-key")).body);
    expect(repeated).toMatchObject({ id: initial.id, allocationId: initial.allocationId, status: "ready" });
    expect(f.control.getAllocations().map(a => a.id)).toEqual(allocations);
    expect(f.calls.length).toBe(count);
    for (const provider of claim.providers) expect(f.controller.verifyProviderToken(provider.credential.token).record.status).toBe("ready");
    f.controller.finishProviderRequest(other.id, "synthetic-generation");
    await f.controller.release(initial.id, "owner");
    await f.controller.release(other.id, "owner");
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("a stalled standalone probe cannot delay its deadline or resurrect a failed connection", async () => {
  let complete!: (health: AgentProviderHealth) => void;
  const blocked = new Promise<AgentProviderHealth>(resolve => { complete = resolve; });
  const f = await fixture({ timeoutMs: 30, check: () => blocked });
  try {
    const result = await f.create("stalled", "stalled", ["llm"]);
    expect(result.status).toBe(503);
    const failed = publicAgentConnectionSchema.parse(result.body);
    expect(failed).toMatchObject({ status: "failed", error: { code: "connection_ready_timeout" } });
    expect(Date.now() - Date.parse(failed.createdAt)).toBeLessThan(2000);
    complete(f.ready("llm"));
    await Bun.sleep(1);
    expect(f.controller.get(failed.id, "owner").body).toMatchObject({ status: "failed" });
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

function syntheticWav(): Uint8Array {
  const bytes = new Uint8Array(46);
  const data = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => [...text].forEach((character, i) => { bytes[offset + i] = character.charCodeAt(0); });
  write(0, "RIFF"); data.setUint32(4, 38, true); write(8, "WAVEfmt "); data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, 16000, true);
  data.setUint32(28, 32000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  write(36, "data"); data.setUint32(40, 2, true);
  return bytes;
}

test("HTTP: held LLM KV, protection and model handover cannot block independently claimed ASR/TTS", async () => {
  const f = await fixture({ limit: 1 });
  const forwarded: string[] = [];
  const { app } = createAppComponents({ registry: f.registry, control: f.control, getState: () => f.observer.getState(),
    apiToken: "shared", protectedConsumerToken: "consumer", connectionSigningKey: new Uint8Array(32).fill(7), agentConnectionCatalog: f.catalog,
    connectionReadyTimeoutMs: 60_000,
    gatewayFetch: async (input, init) => {
      if (init?.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();
      const path = new URL(String(input)).pathname;
      forwarded.push(path);
      if (path === "/health") return Response.json({ ready: true });
      if (path === "/v1/audio/transcriptions") return Response.json({ text: "合成試験" });
      if (path === "/v1/audio/speech") return new Response(syntheticWav(), { headers: { "content-type": "audio/wav" } });
      throw new Error("audio test must not send LLM inference");
    },
  });
  const controlHeaders = { authorization: "Bearer consumer", "content-type": "application/json" };
  const post = (path: string, body: unknown, token = "consumer") => app.request(path, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID(),
  }, body: JSON.stringify(body) });
  let finishHandover!: () => void;
  try {
    const held = await f.control.allocate({ requirements: [{ capability: "llm.general", route: "llm" }],
      ttlSeconds: 120, deploymentPolicy: "existing-only", allowFallback: false, capacityPolicy: "reject", priority: 0 });
    const heldId = (held.body as { id: string }).id;
    f.control.restoreUsageRetention(["llm"], true);
    const response = await post("/v1/agent-connections", { profile: "ornith1.5Strix-vision", audience: "local", client: "synthetic-voice", ttlSeconds: 120 });
    expect(response.status).toBe(202);
    let parent = publicAgentConnectionSchema.parse(await response.json());
    const deadline = performance.now() + 2000;
    while (!parent.providers.filter(p => p.name !== "llm").every(p => p.readiness === "ready") && performance.now() < deadline) {
      await Bun.sleep(1);
      parent = publicAgentConnectionSchema.parse(await (await app.request(`/v1/agent-connections/${parent.id}`, { headers: controlHeaders })).json());
    }
    expect(parent.providers.find(p => p.name === "llm")?.readiness).toBe("waiting");
    expect(parent.providers.filter(p => p.name !== "llm").every(p => p.readiness === "ready")).toBeTrue();
    const claimed = await app.request(`/v1/agent-connections/${parent.id}/claim`, { method: "POST", headers: controlHeaders,
      body: JSON.stringify({ format: "openai-provider-v1", providers: ["asr", "tts"] }) });
    expect(claimed.status).toBe(200);
    const claim = agentConnectionClaimSchema.parse(await claimed.json());
    const asr = claim.providers.find(p => p.name === "asr")!;
    const tts = claim.providers.find(p => p.name === "tts")!;
    expect(tts.health.kind).toBe("health-check");
    const ttsHealth = await app.request(new URL(tts.health.url).pathname, { headers: { authorization: `Bearer ${tts.credential.token}` } });
    expect(ttsHealth.status).toBe(200);
    expect(forwarded.filter(path => path === "/v1/audio/speech")).toHaveLength(0);
    const asrHealth = await app.request(new URL(asr.health.url).pathname, { headers: { authorization: `Bearer ${asr.credential.token}` } });
    expect(asrHealth.status).toBe(200);
    const audio = new FormData(); audio.set("model", "asr"); audio.set("file", new Blob([syntheticWav()], { type: "audio/wav" }), "synthetic.wav");
    const transcription = await app.request("/v1/audio/transcriptions", { method: "POST", headers: {
      authorization: `Bearer ${asr.credential.token}`, "x-larm-allocation-id": claim.allocationId,
    }, body: audio });
    expect(transcription.status).toBe(200);
    await transcription.arrayBuffer();
    const handover = f.control.usage!.run(agentPrincipal("consumer"), () => f.control.usage!.transfer(() => new Promise<void>(resolve => { finishHandover = resolve; })));
    expect(f.control.usage!.isTransitioning).toBeTrue();
    const speech = await app.request("/v1/audio/speech", { method: "POST", headers: {
      authorization: `Bearer ${tts.credential.token}`, "content-type": "application/json", "x-larm-allocation-id": claim.allocationId,
    }, body: JSON.stringify({ model: "tts", input: "合成試験", response_format: "wav" }) });
    expect(speech.status).toBe(200); await speech.arrayBuffer();
    expect(forwarded.filter(path => path === "/v1/audio/speech")).toHaveLength(1);
    finishHandover(); await handover;
    const standalone = await post("/v1/agent-connections", { profile: "ornith1.5Strix-vision", audience: "local", client: "synthetic-other", providers: ["asr"] }, "shared");
    expect(standalone.status).toBe(201);
    const other = publicAgentConnectionSchema.parse(await standalone.json());
    expect(f.control.getUsageState().retainedRuntimeIds).toEqual(["llm"]);
    expect(f.control.usage!.protection.snapshot().activeRequests).toBe(0);
    expect(f.control.getAllocation(heldId)?.status).toBe("ready");
    expect(forwarded.every(path => path === "/health" || path.startsWith("/v1/audio/"))).toBeTrue();
    expect((await post("/v1/audio/speech", { model: "tts", input: "合成試験" }, "invalid")).status).toBe(401);
    await app.request(`/v1/agent-connections/${parent.id}`, { method: "DELETE", headers: controlHeaders });
    expect((await app.request(new URL(asr.health.url).pathname, { headers: { authorization: `Bearer ${asr.credential.token}` } })).status).toBe(401);
    await app.request(`/v1/agent-connections/${other.id}`, { method: "DELETE", headers: { authorization: "Bearer shared" } });
    expect(f.control.getAllocation(heldId)?.status).toBe("ready");
  } finally { finishHandover?.(); f.control.beginDrain(); await f.control.flush(); }
});

test("audio startup is not queued behind an unrelated cold LLM startup", async () => {
  let llmStarted!: () => void;
  const started = new Promise<void>(resolve => { llmStarted = resolve; });
  const starts: string[] = [];
  const f = await fixture({ limit: 1, cold: ["llm", "asr", "tts"], ensure: async (name, signal) => {
    starts.push(name);
    if (name === "llm") {
      llmStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  } });
  let heldId: string | undefined;
  try {
    const held = await f.control.allocate({ requirements: [{ capability: "llm.general", route: "llm" }],
      ttlSeconds: 120, deploymentPolicy: "existing-only", allowFallback: false, capacityPolicy: "reject", priority: 0 });
    expect(held.status).toBe(202);
    heldId = (held.body as { id: string }).id;
    await started;
    const result = await f.create("voice");
    const parent = result.body as PublicAgentConnection;
    const deadline = performance.now() + 2000;
    let snapshot = publicAgentConnectionSchema.parse(f.controller.get(parent.id, "owner").body);
    while (!snapshot.providers.filter(p => p.name !== "llm").every(p => p.readiness === "ready") && performance.now() < deadline) {
      await Bun.sleep(1);
      snapshot = publicAgentConnectionSchema.parse(f.controller.get(parent.id, "owner").body);
    }
    expect(starts).toContain("asr"); expect(starts).toContain("tts");
    expect(snapshot.providers.filter(p => p.name !== "llm").every(p => p.readiness === "ready")).toBeTrue();
    expect(f.control.getAllocation(heldId)?.status).toBe("pending");
    expect((await f.controller.claim(parent.id, "owner", "openai-provider-v1", false, ["asr", "tts"])).status).toBe(200);
    await f.controller.release(parent.id, "owner");
  } finally {
    if (heldId) await f.control.releaseAllocation(heldId);
    f.control.beginDrain(); await f.control.flush();
  }
});

test("rejected LLM allocation does not discard ready audio connections", async () => {
  const f = await fixture({ unavailableLlm: true });
  try {
    const result = await f.create("voice");
    expect(result.status).toBe(202);
    const parent = publicAgentConnectionSchema.parse(result.body);
    await Bun.sleep(1);
    const current = publicAgentConnectionSchema.parse(f.controller.get(parent.id, "owner").body);
    expect(current.providers.find(provider => provider.name === "llm")?.readiness).toBe("failed");
    expect(current.providers.filter(provider => provider.name !== "llm").every(provider => provider.readiness === "ready")).toBeTrue();
    expect((await f.controller.claim(parent.id, "owner", "openai-provider-v1", false, ["asr", "tts"])).status).toBe(200);
    await f.controller.release(parent.id, "owner");
    expect(f.control.getAllocations().every(allocation => allocation.status === "released")).toBeTrue();
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("LLM handover blocked by active generation still returns usable audio", async () => {
  const f = await fixture({ protectedProfile: true });
  const usage = new UsageCoordinator();
  f.control.usage = usage;
  usage.run("owner", () => usage.prepare(600_000)(true));
  const activity = usage.run("owner", () => usage.request(new Request("http://127.0.0.1/v1/chat/completions")));
  try {
    const result = await usage.run("owner", () => f.create("voice"));
    expect(result.status).toBe(202);
    const parent = publicAgentConnectionSchema.parse(result.body);
    await Bun.sleep(1);
    expect((f.controller.get(parent.id, "owner").body as PublicAgentConnection).providers.find(provider => provider.name === "llm")?.readiness).toBe("failed");
    const claim = await usage.run("owner", () => f.controller.claim(parent.id, "owner", "openai-provider-v1", false, ["asr", "tts"]));
    expect(claim.status).toBe(200);
    expect(usage.protection.snapshot().activeRequests).toBe(1);
    await f.controller.release(parent.id, "owner");
  } finally { activity.finish(false); f.control.beginDrain(); await f.control.flush(); }
});

test("failed ASR background preparation leaves TTS and LLM independently usable", async () => {
  const f = await fixture({ check: async name => {
    if (name === "asr") throw new Error("synthetic ASR probe failure");
    return f.ready(name);
  } });
  try {
    const result = await f.create("voice");
    const parent = result.body as PublicAgentConnection;
    await Bun.sleep(1);
    const current = publicAgentConnectionSchema.parse(f.controller.get(parent.id, "owner").body);
    expect(current.providers.find(provider => provider.name === "asr")?.readiness).toBe("failed");
    expect((await f.controller.claim(parent.id, "owner", "openai-provider-v1", false, ["tts"])).status).toBe(200);
    expect((await f.controller.claim(parent.id, "owner", "openai-provider-v1", false, ["llm"])).status).toBe(200);
    await f.controller.release(parent.id, "owner");
  } finally { f.control.beginDrain(); await f.control.flush(); }
});

test("audio capacity wait is promoted while the LLM startup lane remains occupied", async () => {
  let llmStarted!: () => void;
  const started = new Promise<void>(resolve => { llmStarted = resolve; });
  const f = await fixture({ cold: ["llm"], audioLimit: 1, ensure: async (name, signal) => {
    if (name === "llm") {
      llmStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  } });
  f.control.usage = new UsageCoordinator();
  let heldLlm: string | undefined;
  try {
    const allocating = await f.control.allocate({ requirements: [{ capability: "llm.general", route: "llm" }], ttlSeconds: 120,
      deploymentPolicy: "existing-only", allowFallback: false, capacityPolicy: "reject", priority: 0 });
    expect(allocating.status).toBe(202);
    heldLlm = (allocating.body as { id: string }).id;
    await started;
    const held = (await f.create("audio-held", "audio-held", ["asr"])).body as PublicAgentConnection;
    expect(held.status).toBe("ready");
    const waiting = (await f.create("audio-waiting", "audio-waiting", ["asr"])).body as PublicAgentConnection;
    expect(waiting.status).toBe("pending");
    await Bun.sleep(1);
    await f.controller.release(held.id, "owner");
    const deadline = performance.now() + 2000;
    while ((f.controller.get(waiting.id, "owner").body as PublicAgentConnection).status !== "ready" && performance.now() < deadline) await Bun.sleep(1);
    expect((f.controller.get(waiting.id, "owner").body as PublicAgentConnection).status).toBe("ready");
    expect(f.control.getAllocation(heldLlm)?.status).toBe("pending");
    await f.controller.release(waiting.id, "owner");
  } finally {
    if (heldLlm) await f.control.releaseAllocation(heldLlm);
    f.control.beginDrain(); await f.control.flush();
  }
});


test("audio capacity promotion starts a stopped audio backend and reaches readiness", async () => {
  const starts: string[] = [];
  const f = await fixture({ audioLimit: 1, ensure: async name => { starts.push(name); } });
  try {
    const held = (await f.create("held-asr", "held-asr", ["asr"])).body as PublicAgentConnection;
    const waiting = (await f.create("waiting-asr", "waiting-asr", ["asr"])).body as PublicAgentConnection;
    expect(waiting.status).toBe("pending");
    f.setLoaded("asr", false);
    await f.observer.tick();
    await f.controller.release(held.id, "owner");
    const deadline = performance.now() + 2000;
    while ((f.controller.get(waiting.id, "owner").body as PublicAgentConnection).status !== "ready" && performance.now() < deadline) await Bun.sleep(1);
    expect(starts).toContain("asr");
    expect((f.controller.get(waiting.id, "owner").body as PublicAgentConnection).status).toBe("ready");
    expect((await f.controller.claim(waiting.id, "owner", "openai-provider-v1")).status).toBe(200);
    await f.controller.release(waiting.id, "owner");
  } finally { f.control.beginDrain(); await f.control.flush(); }
});


test("audio startup failure remains isolated when its event collector also fails", async () => {
  const events: string[] = [];
  const f = await fixture({ cold: ["asr"], ensure: async name => { if (name === "asr") throw new Error("synthetic backend unavailable"); },
    onControlEvent: event => {
      events.push(event.name);
      if (event.name === "allocation_failed") throw new Error("synthetic event collector unavailable");
    },
  });
  try {
    const result = await f.create("voice");
    const parent = result.body as PublicAgentConnection;
    const deadline = performance.now() + 2000;
    while (!events.includes("audio_control_task_failed") && performance.now() < deadline) await Bun.sleep(1);
    expect(events).toContain("audio_control_task_failed");
    const current = publicAgentConnectionSchema.parse(f.controller.get(parent.id, "owner").body);
    expect(current.providers.find(provider => provider.name === "asr")?.readiness).toBe("failed");
    expect((await f.controller.claim(parent.id, "owner", "openai-provider-v1", false, ["llm", "tts"])).status).toBe(200);
    await f.controller.release(parent.id, "owner");
  } finally { f.control.beginDrain(); await f.control.flush(); }
});
