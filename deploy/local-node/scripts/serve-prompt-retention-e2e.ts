import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readlinkSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadRegistry, loadAgentConnectionCatalogForRegistry, parseAgentConnectionCatalog, runtimeMemoryGB,
  promptRetentionPolicySchema, type Registry, type ProviderInstance } from "../../../packages/core/src/index";
import type { RuntimeBackend } from "../../../packages/backends/src/types";
import { LinuxNodeTelemetry } from "../../../packages/backends/src/linux-node-telemetry";
import { Observer } from "../../../apps/daemon/src/observer";
import { ControlPlane } from "../../../apps/daemon/src/controller";
import { createAppComponents } from "../../../apps/daemon/src/app";

/** Explicitly invoked private test server. Its backend can neither start nor stop Providers. */
async function main() {
  const [sourceConfig, runtimeId, candidateDir, envFile, secretFile, pidText, portText = "19810", mode = "after"] = process.argv.slice(2);
  if (!sourceConfig || !runtimeId || !candidateDir || !envFile || !secretFile || !pidText || !["baseline", "after"].includes(mode)) {
    throw new Error("usage: serve-prompt-retention-e2e.ts SOURCE_CONFIG RUNTIME BUILD_DIR PRIVATE_ENV TEST_SECRETS ENGINE_PID [PORT] [baseline|after]");
  }
  const enginePid = Number(pidText), port = Number(portText);
  if (!Number.isSafeInteger(enginePid) || enginePid <= 0 || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("invalid test process or port");
  const executable = readlinkSync(`/proc/${enginePid}/exe`);
  if (!executable.startsWith(resolve(candidateDir) + "/")) throw new Error("engine must be an explicitly staged test process");
  const manifest = JSON.parse(readFileSync(resolve(candidateDir, "build-manifest.json"), "utf8"));
  const sha = createHash("sha256").update(readFileSync(`/proc/${enginePid}/exe`)).digest("hex");
  if (sha !== (mode === "after" ? manifest.executableSha256 : manifest.baselineExecutableSha256)) throw new Error("test engine digest mismatch");
  const args = readFileSync(`/proc/${enginePid}/cmdline`).toString().split("\0");
  const enginePort = args[args.indexOf("--port") + 1];
  if (!/^\d+$/.test(enginePort ?? "") || !args.includes("--port")) throw new Error("missing test engine port");
  const endpoint = `http://127.0.0.1:${enginePort}`;
  const source = loadRegistry(sourceConfig);
  const catalog = loadAgentConnectionCatalogForRegistry(sourceConfig, source);
  const original = source.runtimes.find(r => r.id === runtimeId);
  if (!catalog || !original) throw new Error("unknown test intent");
  const selector = catalog.profileSelectors.find(s => s.id === catalog.defaultAgentProfile);
  const profile = catalog.profiles.find(p => p.id === selector?.agentProfile);
  const provider = profile?.providers.find(p => p.name === "llm"
    && source.routes.find(r => r.id === p.route)?.candidates.some(c => c.runtime === runtimeId));
  if (!selector || !provider || provider.protocol !== "openai.chat-completions.v1") throw new Error("catalog default does not resolve to requested test runtime");
  const env = JSON.parse(readFileSync(envFile, "utf8"));
  const policy = promptRetentionPolicySchema.parse(JSON.parse(env.LARM_PROMPT_CACHE_POLICY));
  const runtime = { ...structuredClone(original), id: "retention-e2e", node: "test-node",
    backend: "systemd" as const, deployment: { service: "retention-e2e.service", healthPort: Number(enginePort), endpoint },
    policy: { class: "resident" as const, lifecycle: "managed" as const, warm: { minInstances: 1, idleTtlSeconds: 60 } },
    promptRetention: mode === "after" ? policy : undefined };
  const registry: Registry = { nodes: [{ ...structuredClone(source.nodes.find(n => n.id === original.node)!), id: "test-node" }],
    profiles: [], runtimes: [runtime], routes: [{ id: "test-route", explicitOnly: true, capabilities: [...runtime.capability], candidates: [{ runtime: runtime.id, purpose: "primary" }] }] };
  const testCatalog = parseAgentConnectionCatalog({ version: 1, defaultAgentProfile: selector.id,
    audiences: { "same-host": { network: "loopback", baseUrl: `http://127.0.0.1:${port}/v1` } },
    agentProfiles: { [selector.id]: { description: "Synthetic retention E2E", providers: [{
      name: provider.name, capability: provider.capability, route: "test-route", publicModel: provider.publicModel,
      readiness: provider.readiness, ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
    }] } },
    profileSelectors: { [selector.id]: { agentProfile: selector.id } },
  }, registry);
  const probe = async () => {
    const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(3000), redirect: "error" });
    await response.body?.cancel();
    return { runtimeId: runtime.id, service: response.ok ? "Running" as const : "Stopped" as const, listening: response.ok, healthOk: response.ok, busy: false };
  };
  let instance: ProviderInstance | undefined;
  let generation = 0;
  const backend: RuntimeBackend = { list: async () => [await probe()], health: probe,
    ensure: async () => { const result = await probe(); if (!result.healthOk) throw new Error("test Provider is unavailable"); return result; },
    // Retire only the test control plane's descriptor; it has no OS lifecycle authority.
    stop: async () => { instance = undefined; }, stopInstance: async () => { instance = undefined; },
    ensureInstance: async revision => instance ??= { id: `pinst_retention_e2e_${++generation}`, runtimeId: runtime.id, revision: revision.revision,
      generation, node: runtime.node, endpoint, backendEndpoint: endpoint, status: "HOT", createdAt: new Date().toISOString() },
  };
  const observer = new Observer(registry, backend, { telemetry: new LinuxNodeTelemetry() }); await observer.tick();
  const control = new ControlPlane(registry, backend, observer, { bootEpoch: `epoch-${crypto.randomUUID()}` });
  const secrets = existsSync(secretFile) ? JSON.parse(readFileSync(secretFile, "utf8")) : {
    apiToken: randomBytes(32).toString("hex"), peerToken: randomBytes(32).toString("hex"), signingKey: randomBytes(32).toString("base64"),
  };
  if (!existsSync(secretFile)) writeFileSync(secretFile, JSON.stringify(secrets), { flag: "wx", mode: 0o600 });
  const { app } = createAppComponents({ registry, control, getState: () => observer.getState(), agentConnectionCatalog: testCatalog,
    apiToken: secrets.apiToken, protectedConsumerToken: secrets.peerToken, connectionSigningKey: Buffer.from(secrets.signingKey, "base64"),
    promptRetentionKey: mode === "after" ? env.LARM_PROMPT_CACHE_KEY : undefined,
    gatewayTimeoutMs: 120_000, providerProbeTimeoutMs: 30_000,
    identity: { version: "retention-e2e", releaseCommit: "development", configRevision: createHash("sha256").update(JSON.stringify(registry)).digest("hex"), bootEpoch: control.getBootEpoch() },
  });
  const timer = setInterval(() => { void observer.tick(); }, 1000);
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, idleTimeout: 0 });
  const stop = async () => { clearInterval(timer); control.beginDrain(); server.stop(true); await control.flush(); process.exit(0); };
  process.on("SIGINT", () => { void stop(); }); process.on("SIGTERM", () => { void stop(); });
  console.log(JSON.stringify({ ready: true, mode, port, enginePid, engineSha256: sha, reservedMemoryGiB: runtimeMemoryGB(runtime),
    scope: "isolated LARM HTTP server; no production lifecycle authority" }));
}
if (import.meta.main) main().catch(() => { console.error("isolated test server initialization failed; private inputs suppressed"); process.exitCode = 1; });
