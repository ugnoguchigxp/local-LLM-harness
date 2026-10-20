import { randomBytes, randomUUID } from "node:crypto";
import { loadRegistry, loadAgentConnectionCatalogForRegistry } from "../../packages/core/src/index";
import type { RuntimeBackend, RuntimeHealth } from "../../packages/backends/src/index";
import { createApp } from "../../apps/daemon/src/app";
import { ControlPlane } from "../../apps/daemon/src/controller";
import { Observer } from "../../apps/daemon/src/observer";

/** Isolated HTTP canary. Inference is real; service installation/start/stop are deliberately outside this harness. */
export async function decisionHarness(root: string, endpoint: string) {
  const registry = loadRegistry(new URL("../../config/local-node", import.meta.url).pathname);
  const catalog = loadAgentConnectionCatalogForRegistry(new URL("../../config/local-node", import.meta.url).pathname, registry);
  const runtime = registry.runtimes.find(r => r.id === "d1-system-one")!;
  runtime.deployment.endpoint = endpoint;
  const health = (): RuntimeHealth => ({ runtimeId: runtime.id, service: "Running", listening: true, healthOk: true, busy: false });
  const backend: RuntimeBackend = { list: async () => [health()], health: async () => health(), ensure: async r => {
    if (r.id !== runtime.id) throw new Error("canary only manages d1"); return health();
  }, stop: async () => { /* externally started runtime is owned by the canary launcher */ } };
  const observer = new Observer(registry, backend); await observer.tick();
  const control = new ControlPlane(registry, backend, observer, { idleTtlMs: 0, pollIntervalMs: 1 });
  const ticker = setInterval(() => { void observer.tick(); }, 1000);
  const apiToken = randomUUID();
  const app = createApp({ registry, getState: () => observer.getState(), control, apiToken,
    connectionSigningKey: randomBytes(32), agentConnectionCatalog: catalog, connectionPollIntervalMs: 1,
    decisionDataRoot: root, gatewayFetch: fetch, providerProbeTimeoutMs: 30_000 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const base = `http://127.0.0.1:${server.port}`;
  catalog.audiences.find(a => a.id === "same-host")!.baseUrl = `${base}/v1`;
  async function request(path: string, body?: unknown, token = apiToken, method = body === undefined ? "GET" : "POST") {
    const result = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value: any = await result.json();
    if (!result.ok) throw new Error(JSON.stringify({ path, status: result.status, error: value.error }));
    return value;
  }
  async function connect(profile = "decisionGeneral", providers = ["decision"]) {
    const created = await request("/v1/agent-connections", { profile, audience: "same-host", providers, ttlSeconds: 3600 });
    let connection = created;
    while (connection.status !== "ready") {
      if (["failed", "released", "expired"].includes(connection.status)) throw new Error("canary connection failed");
      await Bun.sleep(50); connection = await request(`/v1/agent-connections/${created.id}`);
    }
    const response = await fetch(`${base}/v1/agent-connections/${created.id}/claim`, { method: "POST", headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" }, body: JSON.stringify({ format: "openai-provider-v1" }) });
    if (!response.ok) throw new Error("canary claim failed");
    const claim: any = await response.json();
    return { connection, provider: claim.providers[0], close: () => fetch(`${base}/v1/agent-connections/${created.id}`, { method: "DELETE", headers: { authorization: `Bearer ${apiToken}` } }) };
  }
  return { app, server, base, apiToken, catalog, request, connect, close: () => { clearInterval(ticker); server.stop(true); } };
}
