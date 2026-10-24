import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Dedicated audit-off acceptance fixture. No production state or lifecycle writes. */
const root = process.env.TEST_LARM_SOURCE ?? resolve(import.meta.dir, "../../..");
if (!process.env.LARM_API_TOKEN || !process.env.LARM_CHAT_ENGINE_ENV) throw new Error("isolated_fixture_environment_missing");
const { createAppComponents } = await import(`${root}/apps/daemon/src/app.ts`);
const { ControlPlane } = await import(`${root}/apps/daemon/src/controller.ts`);
const { Observer } = await import(`${root}/apps/daemon/src/observer.ts`);
const { Observability } = await import(`${root}/apps/daemon/src/observability.ts`);
const { MetricsRegistry } = await import(`${root}/apps/daemon/src/metrics.ts`);
const { parseAgentConnectionCatalog, chatInputPolicySchema, promptRetentionPolicySchema } = await import(`${root}/packages/core/src/index.ts`);
const endpoint = "http://127.0.0.1:19812";
const runtime = { id: "ornith15-strix-conversation", capability: ["llm.general", "llm.vision"], protocol: "openai.chat-completions.v1", backend: "systemd", node: "synthetic-node",
  chatInput: chatInputPolicySchema.parse({}), promptRetention: promptRetentionPolicySchema.parse({}),
  policy: { class: "resident", lifecycle: "managed", warm: { minInstances: 1, idleTtlSeconds: 60 } },
  resources: { estimatedMemoryGB: 56, maxConcurrentAllocations: 4, maxConcurrentRequests: 4, maxQueuedRequests: 16, queueTimeoutMs: 30000 },
  deployment: { service: "synthetic.service", healthPort: 19812, endpoint } };
const registry = { nodes: [{ id: "synthetic-node", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 121, reservedMemoryGB: 2 } }], profiles: [], runtimes: [runtime],
  routes: [{ id: "llm-ornith15-strix", explicitOnly: true, capabilities: ["llm.general", "llm.vision"], candidates: [{ runtime: runtime.id, purpose: "primary" }] }] };
const health = { runtimeId: runtime.id, service: "Running", listening: true, healthOk: true, busy: false };
// A read-only backend: the isolated engine is started/stopped outside LARM.
const backend = { list: async () => [health], health: async () => health, ensure: async () => health, stop: async () => {},
  ensureInstance: async (revision: any, r: any) => ({ id: "pinst_synthetic", runtimeId: r.id, revision: revision.revision, generation: 1, node: r.node,
    endpoint, backendEndpoint: endpoint, status: "HOT", createdAt: new Date().toISOString() }) };
const observer = new Observer(registry, backend); await observer.tick();
const control = new ControlPlane(registry, backend, observer, { bootEpoch: `epoch-integrity-${crypto.randomUUID()}` });
const observerTimer = setInterval(() => observer.tick(), 1000);
const catalog = parseAgentConnectionCatalog({ version: 1, defaultAgentProfile: "ornith1.5Strix",
  audiences: { local: { network: "loopback", baseUrl: "http://127.0.0.1:19811/v1" } },
  agentProfiles: { "ornith1.5Strix": { description: "Isolated synthetic integrity verification", providers: [{ name: "llm", capability: "llm.general", route: "llm-ornith15-strix", publicModel: "ornith-1.5-strix-lean", readiness: "llm-inference", contextWindow: { maxTokens: 16384, outputReserveTokens: 4096, safetyMarginTokens: 128 } }] } },
  profileSelectors: { "ornith1.5Strix": { agentProfile: "ornith1.5Strix" } } }, registry);
const env = JSON.parse(readFileSync(process.env.LARM_CHAT_ENGINE_ENV!, 'utf8'));
const props = await (await fetch(`${endpoint}/props`)).json() as { chat_template: string };
const configRevision = createHash("sha256").update(JSON.stringify({ registry, catalog, template: props.chat_template })).digest("hex");
const metrics = new MetricsRegistry();
const observability = new Observability(metrics, { sampleRatio: 0 });
const app = createAppComponents({ registry, control, getState: () => observer.getState(), agentConnectionCatalog: catalog,
  apiToken: process.env.LARM_API_TOKEN, connectionSigningKey: crypto.getRandomValues(new Uint8Array(32)), promptRetentionKey: env.LARM_PROMPT_CACHE_KEY,
  inferenceAuditMode: "off", metrics, observability, onEvent: (event: any) => { if(event.name === "gateway_stream_protocol_error") console.log(JSON.stringify({name:event.name,reason:event.labels?.reason})); }, gatewayTimeoutMs: 120000,
  identity: { version: "0.1.0", releaseCommit: process.env.TEST_RELEASE_LABEL ?? "development", configRevision, bootEpoch: control.getBootEpoch() } }).app;
const server = Bun.serve({ port: 19811, hostname: "127.0.0.1", idleTimeout: 180, fetch: app.fetch });
console.log(JSON.stringify({ ready: true, audit: "off", port: server.port }));
process.on('SIGTERM', async () => { clearInterval(observerTimer); server.stop(true); control.beginDrain(); await control.flush(); await observability.shutdown(); process.exit(0); });
