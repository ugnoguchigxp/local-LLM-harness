/** Excalidraw's isolated hosting path, with real CPU OCR/object workers. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { LocalServiceManager } from "../../../packages/core/src/local-service-manager";
import { parseLocalServices, type LocalServiceDefinition, type LocalServiceStopExpectation } from "../../../packages/core/src/local-service";
import { ServiceResourceLedger } from "../../../packages/core/src/service-resource-ledger";
import { LocalServiceSystemdBackend } from "../../../packages/backends/src/local-service-systemd";
import { LocalServiceFileJournal } from "../../../packages/backends/src/local-service-journal";
import { createLocalServiceControlApp } from "../../../apps/daemon/src/routes/local-service-control-app";
import { ClientLocalServices } from "../../../packages/client/src/client-local-services";
import { readHostedLarmApiToken, startHostedGateway } from "./hosted-service-gateway";
const apiToken = readHostedLarmApiToken(process.env.LARM_HOSTED_API_TOKEN_ENV_FILE ?? "/etc/larm/larm.env");

const stage = "/srv/ai/local-services-prepared/vision-ocr-production";
const privateRoot = "/srv/ai/local-services-prepared/vision-ocr-acceptance";
const root = "/srv/storage/nextorage/files/larm-vision-ocr-acceptance-20261013";
const release = `${stage}/release`;
const prepared = JSON.parse(await readFile(`${stage}/prepared.json`, "utf8"));
for (const [name, asset] of Object.entries(prepared.files) as [string, { sha256: string }][]) {
  if (createHash("sha256").update(await readFile(`${stage}/${name}`)).digest("hex") !== asset.sha256) throw new Error("prepared_asset_changed");
}
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
const credentialFile = `${privateRoot}/credentials.json`;
const credentials: { lifecycle: string; larm: string; owner: string; other: string } = existsSync(credentialFile)
  ? JSON.parse(await readFile(credentialFile, "utf8"))
  : Object.fromEntries(["lifecycle", "larm", "owner", "other"].map(key => [key, crypto.randomUUID() + crypto.randomUUID()]));
await writeFile(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
const models = JSON.parse(await readFile(`${stage}/models/models.json`, "utf8"));
for (const asset of Object.values(models) as { path: string }[]) asset.path = `${release}/models/${asset.path.split("/").at(-1)}`;
const definitionsRaw: Record<string, unknown> = {};
const modes = [{ id: "ocr-host", mode: "ocr", appPort: 18785, gatewayPort: 18784 }, { id: "object-recognition-host", mode: "objects", appPort: 18787, gatewayPort: 18786 }];
const workerEnv = (id: string) => ({ PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: `${release}:${release}/site-packages`, VISION_OCR_CONFIG: `${privateRoot}/${id}.json`, TMPDIR: `${root}/${id}/work/app`, OMP_NUM_THREADS: "4", OPENBLAS_NUM_THREADS: "4" });
for (const m of modes) {
  const dataRoot = `${root}/${m.id}`;
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const config = { mode: m.mode, hostname: "127.0.0.1", port: m.appPort, dataRoot,
    mountPoint: "/srv/storage/nextorage", filesystemUuid: "de97577d-c5d3-4b57-ac4b-3753a2f6d331", minFreeBytes: 2 * 1024 ** 3,
    lifecycleToken: credentials.lifecycle, clients: [{ owner: "local-owner", token: credentials.owner }, { owner: "other-owner", token: credentials.other }], models };
  await writeFile(`${privateRoot}/${m.id}.json`, JSON.stringify(config), { mode: 0o600 });
  await writeFile(`${privateRoot}/${m.id}-lifecycle`, credentials.lifecycle, { mode: 0o600 });
  const init = Bun.spawn([`${stage}/python/bin/python3.12`, "-m", "vision_ocr.server", "--bootstrap"], { env: workerEnv(m.id), stdout: "ignore", stderr: "inherit" });
  if (await init.exited !== 0) throw new Error("bootstrap_failed");
  definitionsRaw[m.id] = { node: "local-node", backend: "systemd-process", deployment: {
    unit: `larm-local-service-${m.id}.service`, stopUnit: `larm-local-service-${m.id}-stop.service`, observeUnit: `larm-local-service-${m.id}-observe.service`,
    members: [`larm-local-service-${m.id}-app.service`], release: prepared.digest, manifestDigest: prepared.digest,
    endpoint: `http://127.0.0.1:${m.appPort}`, publicEndpoint: `http://127.0.0.1:${m.appPort}` },
    readiness: { timeoutSeconds: 45, path: "/health/ready", status: "ready", capabilities: { [m.mode]: true } },
    activity: { secretRef: `${m.id}-lifecycle`, pollSeconds: 1, staleAfterSeconds: 5 },
    lifecycle: { minInstances: 0, idleSeconds: Number(process.env.VISION_OCR_IDLE_SECONDS ?? 60), leaseSeconds: 120, gracefulStopSeconds: 45, restartPolicy: "on-next-ensure" },
    resources: { startupReservationBytes: 2 * 1024 ** 3, cpuMaxCores: 4, maxInstances: 1, gpuAccess: false },
    storage: { dataRoot, mountPoint: config.mountPoint, filesystemUuid: config.filesystemUuid, minFreeBytes: config.minFreeBytes } };
}
const definitions = parseLocalServices({ schemaVersion: "larm.local-services.v2", services: definitionsRaw }, ["local-node"]);
const children = new Map<string, ReturnType<typeof Bun.spawn>>(), starts = new Map<string, number>();
function portListening(port: number) { return ["tcp", "tcp6"].some(name => readFileSync(`/proc/net/${name}`, "utf8").split("\n").slice(1).some(line => { const f = line.trim().split(/\s+/); return f[3] === "0A" && parseInt(f[1]?.split(":")[1] ?? "0", 16) === port; })); }
class AcceptanceBackend extends LocalServiceSystemdBackend {
  override async observe(d: LocalServiceDefinition) {
    const child = children.get(d.id), running = !!child && child.exitCode === null && child.signalCode === null;
    const stopped = !running && !portListening(Number(new URL(d.deployment.endpoint).port));
    let anon = 0;
    if (running) try { anon = Number(/^RssAnon:\s+(\d+)/m.exec(readFileSync(`/proc/${child!.pid}/status`, "utf8"))?.[1] ?? 0) * 1024; } catch { return { serviceId: d.id, release: d.deployment.release, manifestDigest: prepared.digest, observedAt: new Date().toISOString(), state: "unknown" as const, instanceToken: null, stopConfirmed: false, memoryUsageBytes: 0 }; }
    return { serviceId: d.id, release: d.deployment.release, manifestDigest: prepared.digest, observedAt: new Date().toISOString(), state: running ? "running" as const : stopped ? "stopped" as const : "unknown" as const,
      instanceToken: running ? createHash("sha256").update(`${child!.pid}:${starts.get(d.id)}:${prepared.digest}`).digest("hex") : null, stopConfirmed: stopped, memoryUsageBytes: anon };
  }
  override async start(d: LocalServiceDefinition) {
    if (!(await this.observe(d)).stopConfirmed) throw new Error("start_requires_stopped");
    starts.set(d.id, (starts.get(d.id) ?? 0) + 1);
    children.set(d.id, Bun.spawn([`${stage}/python/bin/python3.12`, "-m", "vision_ocr.server"], { env: workerEnv(d.id), stdout: "ignore", stderr: "inherit" }));
  }
  override async stop(d: LocalServiceDefinition, expected?: LocalServiceStopExpectation) {
    const observation = await this.observe(d), a = await this.activity(d);
    if (!expected || observation.instanceToken !== expected.instanceToken || a.bootId !== expected.appBootId || a.drainToken !== expected.drainToken || !a.draining || a.activeRequests || a.runningJobs || a.queuedJobs) throw new Error("stop_expectation_changed");
    const child = children.get(d.id)!; child.kill("SIGTERM");
    const exitCode = await child.exited;
    // Uvicorn restores SIGTERM after completing graceful shutdown (128 + 15).
    if (![0, 143].includes(exitCode) || !(await this.observe(d)).stopConfirmed) throw new Error("stop_unconfirmed");
  }
}
const ledger = new ServiceResourceLedger();
const manager = new LocalServiceManager(definitions, new AcceptanceBackend({ secretRoot: privateRoot, observationRoot: privateRoot }), {
  bootEpoch: crypto.randomUUID(), journal: new LocalServiceFileJournal(`${privateRoot}/journal.json`), ledger,
  reserve: (id, d) => ledger.restore(id, d.node, d.resources.startupReservationBytes),
});
await manager.initialize();
const api = createLocalServiceControlApp({ manager, principals: [{ id: "vision-ocr-acceptance", token: credentials.larm, services: modes.map(m => m.id) }, { id: "eumenes-hosted-apps", token: apiToken, services: modes.map(m => m.id) }], maxBodyBytes: 8192 });
const control = Bun.serve({ hostname: "127.0.0.1", port: 18788, fetch: api.fetch });
const gateways = modes.map(m => startHostedGateway({ hostname: "127.0.0.1", port: m.gatewayPort, serviceId: m.id, webRoot: `${release}/web/${m.mode}`,
  clientTokens: [credentials.owner, credentials.other], apiToken, allowedEndpoints: [`http://127.0.0.1:${m.appPort}`],
  userIdleSeconds: Number(process.env.VISION_OCR_USER_IDLE_SECONDS ?? 30), renewSeconds: 1 }, new ClientLocalServices({ baseUrl: "http://127.0.0.1:18788", token: credentials.larm })));
let ticking = false;
const timer = setInterval(() => { if (ticking) return; ticking = true; void manager.tick().catch(e => console.error(e.message)).finally(() => { ticking = false; }); }, 250);
await writeFile(`${privateRoot}/ready.json`, JSON.stringify({ mode: "isolated-acceptance", credentialFile, release: prepared.digest, gateways: modes.map(m => ({ id: m.id, url: `http://127.0.0.1:${m.gatewayPort}/` })), root }), { mode: 0o600 });
console.log(JSON.stringify({ mode: "isolated-acceptance", services: manager.list(), ports: modes.map(m => m.gatewayPort) }));
const shutdown = async () => { clearInterval(timer); await Promise.all(gateways.map(g => g.close())); await manager.close(); await control.stop(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
