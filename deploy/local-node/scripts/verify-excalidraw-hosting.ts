/** Isolated live acceptance. Reuses LARM's manager/routes against a real child process.
 * This does not certify root-owned systemd deployment or change the running daemon. */
import { mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { LocalServiceManager } from "../../../packages/core/src/local-service-manager";
import { parseLocalServices, type LocalServiceDefinition, type LocalServiceStopExpectation } from "../../../packages/core/src/local-service";
import { ServiceResourceLedger } from "../../../packages/core/src/service-resource-ledger";
import { LocalServiceSystemdBackend } from "../../../packages/backends/src/local-service-systemd";
import { LocalServiceFileJournal } from "../../../packages/backends/src/local-service-journal";
import { createLocalServiceControlApp } from "../../../apps/daemon/src/routes/local-service-control-app";
import { ClientLocalServices } from "../../../packages/client/src/client-local-services";
import { startHostedGateway } from "./hosted-service-gateway";
const appRepo = "/srv/ai/apps/excalidraw-host";
const root = process.env.EXCALIDRAW_ACCEPTANCE_ROOT ?? "/srv/storage/nextorage/files/larm-excalidraw-acceptance-20261009";
const privateRoot = "/srv/ai/local-services-prepared/excalidraw-acceptance";
const appPort = 18781, controlPort = 18782, gatewayPort = 18780;
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
await mkdir(root, { recursive: true, mode: 0o700 });
const credentialFile = `${privateRoot}/credentials.json`;
const credentials = existsSync(credentialFile) ? JSON.parse(readFileSync(credentialFile, "utf8")) : { lifecycle: crypto.randomUUID() + crypto.randomUUID(), larm: crypto.randomUUID() + crypto.randomUUID(), owner: crypto.randomUUID() + crypto.randomUUID(), other: crypto.randomUUID() + crypto.randomUUID() };
await writeFile(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
const serverBytes = await readFile(`${appRepo}/dist/server.js`);
const digest = createHash("sha256").update(serverBytes).digest("hex");
const releaseRoot = `${privateRoot}/releases/${digest}`;
await mkdir(releaseRoot, { recursive: true });
await writeFile(`${releaseRoot}/server.js`, serverBytes);
await cp(`${appRepo}/dist/web`, `${releaseRoot}/web`, { recursive: true });
const appConfig = { dataRoot: `${root}/app`, mountPoint: "/srv/storage/nextorage", filesystemUuid: "de97577d-c5d3-4b57-ac4b-3753a2f6d331", minFreeBytes: 2147483648, hostname: "127.0.0.1", port: appPort, webRoot: `${releaseRoot}/web`, lifecycleToken: credentials.lifecycle, clients: [{ owner: "acceptance-user", token: credentials.owner }, { owner: "other-user", token: credentials.other }] };
await mkdir(appConfig.dataRoot, { recursive: true, mode: 0o700 });
await writeFile(`${privateRoot}/app.json`, JSON.stringify(appConfig), { mode: 0o600 });
await writeFile(`${privateRoot}/excalidraw-lifecycle`, credentials.lifecycle, { mode: 0o600 });
if (!existsSync(`${appConfig.dataRoot}/state/documents.sqlite`)) {
  const init = Bun.spawn([process.execPath, `${releaseRoot}/server.js`, "--bootstrap"], { env: { PATH: "/usr/bin:/bin", EXCALIDRAW_HOST_CONFIG: `${privateRoot}/app.json` }, stdout: "pipe", stderr: "pipe" });
  if (await init.exited !== 0) throw new Error(await new Response(init.stderr).text());
}
let child: ReturnType<typeof Bun.spawn> | undefined, starts = 0;
const definitionFile = { schemaVersion: "larm.local-services.v2", services: { "excalidraw-host": {
  node: "local-node", backend: "systemd-process",
  deployment: { unit: "larm-local-service-excalidraw.service", stopUnit: "larm-local-service-excalidraw-stop.service", observeUnit: "larm-local-service-excalidraw-observe.service", members: ["larm-local-service-excalidraw-app.service"], release: "excalidraw-acceptance", manifestDigest: digest, endpoint: `http://127.0.0.1:${appPort}`, publicEndpoint: `http://127.0.0.1:${appPort}` },
  readiness: { timeoutSeconds: 30, path: "/health/ready", status: "ready", capabilities: { drawings: true, mcp: true } },
  activity: { secretRef: "excalidraw-lifecycle", pollSeconds: 1, staleAfterSeconds: 3 },
  lifecycle: { minInstances: 0, idleSeconds: Number(process.env.EXCALIDRAW_ACCEPTANCE_IDLE_SECONDS ?? 3), leaseSeconds: 120, gracefulStopSeconds: 30, restartPolicy: "on-next-ensure" },
  resources: { startupReservationBytes: 1024 ** 3, cpuMaxCores: 2, maxInstances: 1, gpuAccess: false },
  storage: { dataRoot: appConfig.dataRoot, mountPoint: appConfig.mountPoint, filesystemUuid: appConfig.filesystemUuid, minFreeBytes: appConfig.minFreeBytes },
} } };
const definitions = parseLocalServices(definitionFile, ["local-node"]);
function portListening() { return ["tcp", "tcp6"].some(name => readFileSync(`/proc/net/${name}`, "utf8").split("\n").slice(1).some(line => { const fields = line.trim().split(/\s+/); return fields[3] === "0A" && parseInt(fields[1]?.split(":")[1] ?? "0", 16) === appPort; })); }
class AcceptanceBackend extends LocalServiceSystemdBackend {
  override async observe(d: LocalServiceDefinition) {
    const running = child && child.exitCode === null;
    const stopped = !running && !portListening();
    const anon = running ? Number(/^RssAnon:\s+(\d+)/m.exec(readFileSync(`/proc/${child!.pid}/status`, "utf8"))?.[1] ?? 0) * 1024 : 0;
    return { serviceId: d.id, release: d.deployment.release, manifestDigest: digest, observedAt: new Date().toISOString(), state: running ? "running" as const : stopped ? "stopped" as const : "unknown" as const, instanceToken: running ? createHash("sha256").update(`${child!.pid}:${starts}:${digest}`).digest("hex") : null, stopConfirmed: stopped, memoryUsageBytes: anon };
  }
  override async start(d: LocalServiceDefinition) {
    if (!(await this.observe(d)).stopConfirmed) throw new Error("start_requires_stopped");
    starts++;
    child = Bun.spawn([process.execPath, `${releaseRoot}/server.js`], { env: { PATH: "/usr/bin:/bin", EXCALIDRAW_HOST_CONFIG: `${privateRoot}/app.json` }, stdout: "ignore", stderr: "pipe" });
  }
  override async stop(d: LocalServiceDefinition, expected?: LocalServiceStopExpectation) {
    const observation = await this.observe(d), activity = await this.activity(d);
    if (!expected || observation.instanceToken !== expected.instanceToken || activity.bootId !== expected.appBootId || activity.drainToken !== expected.drainToken || !activity.draining || activity.activeRequests) throw new Error("stop_expectation_changed");
    child!.kill("SIGTERM");
    const code = await Promise.race([child!.exited, Bun.sleep(15000).then(() => { throw new Error("stop_unconfirmed"); })]);
    if (code !== 0 || !(await this.observe(d)).stopConfirmed) throw new Error("stop_unconfirmed");
  }
}
const ledger = new ServiceResourceLedger();
const manager = new LocalServiceManager(definitions, new AcceptanceBackend({ secretRoot: privateRoot, observationRoot: privateRoot }), { bootEpoch: crypto.randomUUID(), journal: new LocalServiceFileJournal(`${privateRoot}/journal.json`), ledger, reserve: (id, d) => ledger.restore(id, d.node, d.resources.startupReservationBytes) });
await manager.initialize();
const api = createLocalServiceControlApp({ manager, principals: [{ id: "excalidraw-acceptance", token: credentials.larm, services: ["excalidraw-host"] }], maxBodyBytes: 8192 });
const control = Bun.serve({ hostname: "127.0.0.1", port: controlPort, fetch: api.fetch });
let ticking = false;
const timer = setInterval(() => { if (ticking) return; ticking = true; void manager.tick().catch(error => console.error(error.message)).finally(() => { ticking = false; }); }, 250);
const gateway = startHostedGateway({ hostname: "127.0.0.1", port: gatewayPort, serviceId: "excalidraw-host", webRoot: `${releaseRoot}/web`, clientTokens: [credentials.owner, credentials.other], allowedEndpoints: [`http://127.0.0.1:${appPort}`], userIdleSeconds: Number(process.env.EXCALIDRAW_ACCEPTANCE_USER_IDLE_SECONDS ?? 3), renewSeconds: 1 }, new ClientLocalServices({ baseUrl: `http://127.0.0.1:${controlPort}`, token: credentials.larm }));
await writeFile(`${privateRoot}/ready.json`, JSON.stringify({ gateway: `http://127.0.0.1:${gatewayPort}`, credentialsFile: credentialFile, storage: appConfig.dataRoot, releaseRoot }), { mode: 0o600 });
console.log(JSON.stringify({ gateway: `http://127.0.0.1:${gatewayPort}`, storage: appConfig.dataRoot, mode: "isolated-acceptance", appInitially: manager.status("excalidraw-host").state }));
const shutdown = async () => { clearInterval(timer); await gateway.close(); await manager.close(); await control.stop(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
