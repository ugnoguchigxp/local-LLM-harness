import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { loadRegistry, loadAgentConnectionCatalogForRegistry } from "../../../packages/core/src/index";
import { SystemdBackend } from "../../../packages/backends/src/index";
import { LarmClient, type VisualPerceptionAgentProvider } from "../../../packages/client/src/index";
import { createApp } from "../../../apps/daemon/src/app";
import { ControlPlane } from "../../../apps/daemon/src/controller";
import { Observer } from "../../../apps/daemon/src/observer";

const { values } = parseArgs({ options: { isolated: { type: "boolean" }, "idle-only": { type: "boolean" }, "cancel-reacquire": { type: "boolean" }, image: { type: "string" }, evidence: { type: "string" } } });
if (!values.image || !values.evidence) throw new Error("--image and external --evidence directory are required");
const repository = resolve(import.meta.dir, "../../..");
const evidence = resolve(values.evidence);
if (evidence === repository || evidence.startsWith(`${repository}/`)) throw new Error("evidence must be outside the repository");
const image = `data:image/png;base64,${Buffer.from(await Bun.file(values.image).arrayBuffer()).toString("base64")}`;
let baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
let apiToken = process.env.LARM_API_TOKEN;
let shadow: ReturnType<typeof Bun.serve> | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let control: ControlPlane | undefined;
if (values.isolated) {
  const registry = loadRegistry(`${repository}/config/local-node`);
  const catalog = loadAgentConnectionCatalogForRegistry(`${repository}/config/local-node`, registry);
  registry.runtimes = registry.runtimes.filter(r => r.id === "wevisone-vl-4b");
  registry.routes = registry.routes.filter(r => r.id === "vision-wevisone");
  registry.profiles = [];
  catalog.profiles = catalog.profiles.filter(p => p.id === "visual-perception");
  catalog.defaultAgentProfile = "visual-perception";
  catalog.profileSelectors = catalog.profileSelectors.filter(p => p.id === "visualPerception");
  const backend = new SystemdBackend(registry.runtimes);
  const observer = new Observer(registry, backend);
  await observer.tick();
  control = new ControlPlane(registry, backend, observer, { idleTtlMs: 60_000, pollIntervalMs: 100 });
  ticker = setInterval(() => { void observer.tick(); }, 250);
  apiToken = randomBytes(32).toString("hex");
  const app = createApp({ registry, getState: () => observer.getState(), control, apiToken,
    connectionSigningKey: randomBytes(32), promptRetentionKey: randomBytes(32).toString("hex"),
    agentConnectionCatalog: catalog, connectionPollIntervalMs: 100, providerProbeTimeoutMs: 30_000 });
  shadow = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${shadow.port}`;
  catalog.audiences.find(a => a.id === "same-host")!.baseUrl = `${baseUrl}/v1`;
}
if (!apiToken) throw new Error("LARM_API_TOKEN is required for production verification");
const client = new LarmClient({ baseUrl, apiToken, timeoutMs: 185_000 });
const command = async (...args: string[]) => {
  const p = Bun.spawn(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(p.stdout).text(); await p.exited; return stdout.trim();
};
const records: unknown[] = [];
let connectionId: string | undefined;
try {
  const discovery = await client.listAgentProfilesV3("visualPerception");
  if (discovery.profiles[0]?.providers[0]?.capability !== "vision.perception") throw new Error("vision discovery mismatch");
  if (await command("is-active", "wevisone-vl.service") === "active") throw new Error("smoke must begin with the worker stopped");
  for (let cycle = 0; cycle < (values["idle-only"] || values["cancel-reacquire"] ? 0 : 2); cycle++) {
    const start = performance.now();
    const created = await client.createAgentConnection({ profile: "visualPerception", audience: "same-host", providers: ["vision"],
      client: "wevisone-deployment-smoke", ttlSeconds: 600, allowFallback: false, deploymentPolicy: "existing-only" });
    connectionId = created.id;
    const ready = await client.waitForAgentConnection(created, { timeoutMs: 120_000, pollIntervalMs: 250 });
    const claim = await client.claimAgentConnection(ready.id);
    const provider = claim.providers.find((p): p is VisualPerceptionAgentProvider => p.apiStyle === "larm-visual-perception");
    if (!provider || claim.providers.length !== 1) throw new Error("unexpected claimed Provider set");
    const readyMs = performance.now() - start;
    const pid = await command("show", "wevisone-vl.service", "-p", "MainPID", "--value");
    const tasks = cycle === 0 ? ["referring", "describe", "segmentation"] as const : ["referring"] as const;
    for (const task of tasks) {
      const requestStart = performance.now();
      const result = await client.perceive(provider, { model: provider.model, image, task,
        query: task === "describe" ? "Describe what happened on this desk." : "the cup that has spilled liquid", maxNewTokens: 160 });
      if (result.truncated || !result.response || (task !== "describe" && result.detections.length !== 1)
        || (task === "segmentation" && result.masks.length !== 1)) throw new Error("incomplete or unexpected real-image result");
      await Bun.write(`${evidence}/cycle-${cycle}-${task}.json`, JSON.stringify(result, null, 2));
      records.push({ cycle, task, readyMs, pid, requestMs: performance.now() - requestStart, timings: result.timings,
        detections: result.detections, masks: result.masks.length, response: result.response });
    }
    const releaseStart = performance.now();
    await client.releaseAgentConnection(ready.id); connectionId = undefined;
    const invalid = await fetch(provider.endpoint, { method: "POST", headers: { authorization: `Bearer ${provider.credential.token}`, "content-type": "application/json" }, body: "{}" });
    await invalid.body?.cancel();
    if (invalid.status !== 401) throw new Error("released credential was not revoked");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && await command("show", "wevisone-vl.service", "-p", "MainPID", "--value") !== "0") await Bun.sleep(250);
    const finalPid = await command("show", "wevisone-vl.service", "-p", "MainPID", "--value");
    if (finalPid !== "0") throw new Error("worker did not stop after release");
    records.push({ cycle, stopped: true, releaseMs: performance.now() - releaseStart, credentialRevoked: true, finalPid });
  }
  if (values["cancel-reacquire"]) {
    for (let cycle = 0; cycle < 4; cycle++) {
      const start = performance.now();
      const created = await client.createAgentConnection({ profile: "visualPerception", audience: "same-host", providers: ["vision"],
        client: "wevisone-cancel-reacquire-smoke", ttlSeconds: 600, allowFallback: false, deploymentPolicy: "existing-only" });
      connectionId = created.id;
      const ready = await client.waitForAgentConnection(created, { timeoutMs: 120_000, pollIntervalMs: 250 });
      const claim = await client.claimAgentConnection(ready.id);
      const provider = claim.providers.find(p => p.name === "vision" && p.apiStyle === "larm-visual-perception");
      if (!provider) throw new Error("vision claim missing");
      const releaseStart = performance.now();
      await client.releaseAgentConnection(ready.id);
      connectionId = undefined;
      records.push({ cycle, id: ready.id, readyMs: releaseStart-start, releaseAckMs: performance.now()-releaseStart,
        status: ready.status, providers: ready.providers.map(p => ({ name: p.name, readiness: p.readiness, claimable: p.claimable })) });
      // Intentionally no stop polling or pause before the next allocation.
    }
    const last = records.at(-1) as { id: string };
    const released = await client.getAgentConnection(last.id);
    const deadline = Date.now() + 30_000;
    let observed: { id: string; status: string; observedAt: string } | undefined;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/state`, { headers: { authorization: `Bearer ${apiToken}` }, cache: "no-store" });
      if (!response.ok) throw new Error(`public state returned ${response.status}`);
      const state = await response.json() as { online: boolean; runtimes: Array<{ id: string; status: string; observedAt: string }> };
      observed = state.runtimes.find(r => r.id === "wevisone-vl-4b");
      if (state.online && observed?.status === "COLD" && released.releasedAt && Date.parse(observed.observedAt) >= Date.parse(released.releasedAt)) break;
      await Bun.sleep(500);
    }
    if (!observed || observed.status !== "COLD" || !released.releasedAt || Date.parse(observed.observedAt) < Date.parse(released.releasedAt)) {
      throw new Error("fresh COLD observation not available after final release");
    }
    const finalPid = await command("show", "wevisone-vl.service", "-p", "MainPID", "--value");
    if (finalPid !== "0") throw new Error("worker PID is still present");
    records.push({ finalPublicState: observed, finalPid });
  }
  if (values["idle-only"]) {
    const created = await client.createAgentConnection({ profile: "visualPerception", audience: "same-host", providers: ["vision"], client: "wevisone-idle-smoke", ttlSeconds: 600 });
    connectionId = created.id;
    const ready = await client.waitForAgentConnection(created, { timeoutMs: 120_000, pollIntervalMs: 250 });
    await client.claimAgentConnection(ready.id);
    const start = performance.now();
    let finalStatus: string = ready.status;
    const deadline = Date.now() + 70_000;
    while (Date.now() < deadline && finalStatus === "ready") {
      await Bun.sleep(500);
      finalStatus = (await client.getAgentConnection(ready.id)).status;
    }
    if (finalStatus !== "released") throw new Error(`idle connection was not released: ${finalStatus}`);
    connectionId = undefined;
    while (Date.now() < deadline && await command("show", "wevisone-vl.service", "-p", "MainPID", "--value") !== "0") await Bun.sleep(250);
    const finalPid = await command("show", "wevisone-vl.service", "-p", "MainPID", "--value");
    if (finalPid !== "0") throw new Error("idle worker did not stop");
    records.push({ idleReleased: true, idleMs: performance.now()-start, finalStatus, finalPid });
  }
  await Bun.write(`${evidence}/lifecycle.json`, JSON.stringify({ ok: true, isolated: !!values.isolated, records }, null, 2));
  console.log(JSON.stringify({ ok: true, isolated: !!values.isolated, records }, null, 2));
} finally {
  if (connectionId) await client.releaseAgentConnection(connectionId).catch(() => {});
  if (ticker) clearInterval(ticker);
  if (control) { control.beginDrain(); await control.flush(); }
  shadow?.stop(true);
}
