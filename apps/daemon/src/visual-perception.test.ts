import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { loadRegistry, loadAgentConnectionCatalogForRegistry, visualPerceptionProbe, type ProviderInstance } from "@larm/core";
import type { RuntimeBackend, RuntimeHealth } from "@larm/backends";
import { LarmClient, LarmApiError, type VisualPerceptionAgentProvider } from "../../../packages/client/src/index";
import { createApp } from "./app";
import { ControlPlane } from "./controller";
import { Observer } from "./observer";

test("vision Provider discovery, actual-image readiness, scoped validation, upstream failures and revocation", async () => {
  const directory = new URL("../../../config/local-node", import.meta.url).pathname;
  const registry = loadRegistry(directory);
  const catalog = loadAgentConnectionCatalogForRegistry(directory, registry);
  const runtime = registry.runtimes.find(r => r.id === "lfm3-vl-perception")!;
  let mode = "valid", seenImages = 0;
  const peer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => {
    const b = await req.json() as any;
    expect(b.image).toStartWith("data:image/png;base64,"); seenImages++;
    const activeMode = b.query === "Describe the image briefly." ? "valid" : mode;
    if (activeMode === "text") return new Response("wrong", { headers: { "content-type": "text/plain" } });
    if (activeMode === "json") return new Response("{broken", { headers: { "content-type": "application/json" } });
    if (activeMode === "large") return Response.json({ response: "a".repeat(8 * 1024 * 1024) });
    if (activeMode === "busy") return Response.json({ error: { code: "provider_busy", message: "provider_busy" } }, { status: 429 });
    return Response.json({ contractVersion: "larm.visual-perception.v1", model: activeMode === "wrong" ? "wrong" : b.model,
      modelRevision: "a".repeat(40), task: b.task, image: { width: 128, height: 128, orientation: "exif-normalized" },
      response: "circle", detections: [{ label: "circle", box: [32, 32, 96, 96] }], masks: [], truncated: false,
      timings: { imageDecodeMs: 1, preprocessMs: 1, generationMs: 10, maskMs: 0, postprocessMs: 1, totalMs: 13 },
      execution: { device: "cuda:0", backend: "transformers", dtype: "bfloat16", decoderDtype: "float32", outputTokens: 12, visualTokens: 16 } });
  } });
  runtime.deployment.endpoint = `http://127.0.0.1:${peer.port}`;
  const health = (): RuntimeHealth => ({ runtimeId: runtime.id, service: "Running", listening: true, healthOk: true, busy: false });
  const stopped: string[] = [];
  let instance: ProviderInstance;
  const backend: RuntimeBackend = {
    list: async () => [health()], health: async () => health(), ensure: async () => health(), stop: async id => { stopped.push(id); },
    ensureInstance: async revision => {
      instance = { id: "vision-instance", runtimeId: runtime.id, revision: revision.revision, generation: 1, node: runtime.node,
        endpoint: runtime.deployment.endpoint, backendEndpoint: runtime.deployment.endpoint, status: "HOT", createdAt: new Date().toISOString() };
      return instance;
    },
    healthInstance: async () => ({ ...instance, ...health() }),
    drainInstance: async () => {}, stopInstance: async () => { stopped.push(runtime.id); },
  };
  const observer = new Observer(registry, backend); await observer.tick();
  const control = new ControlPlane(registry, backend, observer, { idleTtlMs: 60_000, pollIntervalMs: 1 });
  const apiToken = randomUUID();
  let clock = Date.now();
  const app = createApp({ registry, getState: () => observer.getState(), control, apiToken,
    now: () => clock,
    connectionSigningKey: randomBytes(32), promptRetentionKey: randomBytes(32).toString("hex"),
    agentConnectionCatalog: catalog, connectionPollIntervalMs: 1, gatewayFetch: fetch, providerProbeTimeoutMs: 3000 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const base = `http://127.0.0.1:${server.port}`;
  catalog.audiences.find(a => a.id === "same-host")!.baseUrl = `${base}/v1`;
  const client = new LarmClient({ baseUrl: base, apiToken });
  let id: string | undefined;
  try {
    const list = await client.listAgentProfilesV3("visualPerception");
    expect(list.profiles[0]?.providers[0]).toMatchObject({ protocol: "larm.visual-perception.v1", endpoint: "/v1/vision/perceive" });
    const created = await client.createAgentConnection({ profile: "visualPerception", audience: "same-host", ttlSeconds: 300 });
    id = created.id;
    const ready = await client.waitForAgentConnection(created, { timeoutMs: 3000, pollIntervalMs: 1 });
    const claim = await client.claimAgentConnection(ready.id);
    const provider = claim.providers[0] as VisualPerceptionAgentProvider;
    expect(provider.apiStyle).toBe("larm-visual-perception");
    expect(seenImages).toBeGreaterThan(0);
    clock += 11_000;
    expect(await client.getAgentConnection(ready.id)).toMatchObject({ status: "ready",
      providers: [{ name: "vision", readiness: "ready", claimable: false }] });
    const beforeReclaim = seenImages;
    expect((await client.claimAgentConnection(ready.id)).providers[0]?.apiStyle).toBe("larm-visual-perception");
    expect(seenImages).toBeGreaterThan(beforeReclaim);
    expect((await client.getAgentConnection(ready.id)).providers[0]?.claimable).toBe(true);
    const input = { ...visualPerceptionProbe(provider.model), query: "real target" };
    expect((await client.perceive(provider, input)).detections).toHaveLength(1);
    const raw = (body: unknown, token = provider.credential.token) => fetch(provider.endpoint, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const before = seenImages;
    expect((await raw({ ...input, model: "other" })).status).toBe(400);
    expect((await raw({ ...input, image: "https://example.com/image.png" })).status).toBe(400);
    expect((await raw(input, apiToken)).status).toBeGreaterThanOrEqual(400);
    const invalidJson = await fetch(provider.endpoint, { method: "POST", headers: { authorization: `Bearer ${provider.credential.token}`, "content-type": "application/json" }, body: "{broken" });
    expect(invalidJson.status).toBe(400);
    expect(seenImages).toBe(before);
    for (const failure of ["text", "json", "large", "wrong"]) {
      mode = failure;
      await expect(client.perceive(provider, input)).rejects.toBeInstanceOf(LarmApiError);
    }
    mode = "busy";
    await expect(client.perceive(provider, input)).rejects.toMatchObject({ status: 429 });
    mode = "valid";
    await client.releaseAgentConnection(id); id = undefined;
    await Bun.sleep(0);
    expect(stopped).toContain(runtime.id);
    expect((await raw(input)).status).toBe(401);
    expect(await fetch(`${base}/v1/vision/perceive`, { method: "POST", body: "{}" }).then(r => r.status)).toBe(401);
  } finally {
    if (id) await client.releaseAgentConnection(id).catch(() => {});
    control.beginDrain(); await control.flush(); server.stop(true); peer.stop(true);
  }
}, 10_000);
