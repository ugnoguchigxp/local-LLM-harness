/** Real Docling + LARM manager acceptance without root or the production daemon.
 * systemd ownership, native Office/OCR packages and cgroups require post-install acceptance. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { LocalServiceManager } from "../../../packages/core/src/local-service-manager";
import { parseLocalServices, localServiceIdle, type LocalServiceDefinition, type LocalServiceStopExpectation } from "../../../packages/core/src/local-service";
import { ServiceResourceLedger } from "../../../packages/core/src/service-resource-ledger";
import { LocalServiceFileJournal } from "../../../packages/backends/src/local-service-journal";
import { LocalServiceSystemdBackend } from "../../../packages/backends/src/local-service-systemd";
import { createLocalServiceControlApp } from "../../../apps/daemon/src/routes/local-service-control-app";
import { ClientLocalServices } from "../../../packages/client/src/client-local-services";
import { startDoclingGateway } from "./docling-gateway";

const stage = process.env.LARM_DOCLING_STAGE ?? "/srv/ai/local-services-prepared/docling-desk";
const prepared = JSON.parse(await readFile(`${stage}/prepared.json`, "utf8"));
const root = await mkdtemp(`${stage}/acceptance-`);
const release = `${stage}/release`, data = `${root}/data`;
await mkdir(data);
const lifecycle = crypto.randomUUID() + crypto.randomUUID(), appToken = crypto.randomUUID() + crypto.randomUUID();
const larmToken = crypto.randomUUID() + crypto.randomUUID();
await writeFile(`${root}/lifecycle`, lifecycle, { mode: 0o600 });
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const appPort = reservation.port; await reservation.stop(true);
const endpoint = `http://127.0.0.1:${appPort}`;
let child: ReturnType<typeof Bun.spawn> | undefined, starts = 0, childExited = true;
const definitions = parseLocalServices({ schemaVersion: "larm.local-services.v2", services: { "docling-desk": {
  node: "local-node", backend: "systemd-process",
  deployment: { unit: "larm-local-service-docling-desk.service", stopUnit: "larm-local-service-docling-desk-stop.service",
    observeUnit: "larm-local-service-docling-desk-observe.service", members: ["larm-local-service-docling-desk-app.service"],
    release: prepared.digest, manifestDigest: prepared.digest, endpoint, publicEndpoint: endpoint },
  readiness: { timeoutSeconds: 180, path: "/health/ready", status: "ready", capabilities: {} },
  activity: { secretRef: "lifecycle", pollSeconds: 1, staleAfterSeconds: 15 },
  lifecycle: { minInstances: 0, idleSeconds: 2, leaseSeconds: 300, gracefulStopSeconds: 30, restartPolicy: "on-next-ensure" },
  resources: { startupReservationBytes: 8 * 1024 ** 3, cpuMaxCores: 4, maxInstances: 1, gpuAccess: false },
  storage: { dataRoot: data, mountPoint: stage, filesystemUuid: "00000000-0000", minFreeBytes: 2147483648 },
} } }, ["local-node"]);
function listening() {
  return ["tcp", "tcp6"].some(name => readFileSync(`/proc/net/${name}`, "utf8").split("\n").slice(1).some(line => {
    const f = line.trim().split(/\s+/); return f[3] === "0A" && parseInt(f[1]?.split(":")[1] ?? "0", 16) === appPort;
  }));
}
class Backend extends LocalServiceSystemdBackend {
  override async observe(d: LocalServiceDefinition) {
    const running = child !== undefined && !childExited, stopped = !running && !listening();
    return { serviceId: d.id, release: d.deployment.release, manifestDigest: prepared.digest, observedAt: new Date().toISOString(),
      state: running ? "running" as const : stopped ? "stopped" as const : "unknown" as const,
      instanceToken: running ? createHash("sha256").update(`${child!.pid}:${starts}`).digest("hex") : null,
      stopConfirmed: stopped, memoryUsageBytes: 0 };
  }
  override async start(d: LocalServiceDefinition) {
    if (!(await this.observe(d)).stopConfirmed) throw new Error("already_running");
    starts++;
    child = Bun.spawn([prepared.python, "-m", "uvicorn", "docling_lifecycle:create_app", "--factory", "--host", "127.0.0.1", "--port", String(appPort), "--workers", "1", "--no-access-log", "--no-proxy-headers"], {
      cwd: release, env: { PATH: "/usr/bin:/bin", HOME: root, PYTHONPATH: `${release}:${release}/site-packages`, PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1", DOCLING_ENV_FILE: "/dev/null", DOCLING_DATA_DIR: data, DOCLING_STATE_DIR: `${root}/state`,
        DOCLING_CACHE_DIR: `${root}/cache`, DOCLING_MODELS_DIR: `${release}/models`, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
        DOCLING_AUTH_MODE: "larm", LARM_API_TOKEN: appToken, LARM_DOCLING_LIFECYCLE_TOKEN_FILE: `${root}/lifecycle`,
        OMP_NUM_THREADS: "4", TOKENIZERS_PARALLELISM: "false" },
      stdout: Bun.file(`${root}/app-${starts}.log`), stderr: Bun.file(`${root}/app-${starts}.error.log`),
    });
    childExited = false;
    const spawned = child;
    // Uvicorn re-raises SIGTERM after graceful shutdown; exitCode may stay null.
    void spawned.exited.then(() => { if (child === spawned) childExited = true; });
  }
  override async stop(d: LocalServiceDefinition, expected?: LocalServiceStopExpectation) {
    const observation = await this.observe(d), activity = await this.activity(d);
    if (!expected || observation.instanceToken !== expected.instanceToken || activity.bootId !== expected.appBootId ||
      activity.drainToken !== expected.drainToken || !activity.draining || !localServiceIdle(activity)) throw new Error("unsafe_stop");
    child!.kill("SIGTERM");
    await Promise.race([child!.exited, Bun.sleep(15000).then(() => { throw new Error("stop_timeout"); })]);
    if (!(await this.observe(d)).stopConfirmed) throw new Error("stop_unconfirmed");
  }
}
const backend = new Backend({ secretRoot: root, observationRoot: root }), ledger = new ServiceResourceLedger();
const manager = new LocalServiceManager(definitions, backend, { bootEpoch: crypto.randomUUID(),
  journal: new LocalServiceFileJournal(`${root}/journal.json`), ledger,
  reserve: (id, d) => ledger.restore(id, d.node, d.resources.startupReservationBytes) });
await manager.initialize();
const api = createLocalServiceControlApp({ manager, principals: [{ id: "docling-verification", token: larmToken, services: ["docling-desk"] }], maxBodyBytes: 8192 });
const control = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.fetch });
const client = new ClientLocalServices({ baseUrl: `http://127.0.0.1:${control.port}`, token: larmToken });
const gateway = startDoclingGateway({ port: 0, endpoint, idleSeconds: 1, renewSeconds: 0.25 }, client);
const base = `http://127.0.0.1:${gateway.server.port}`;
let ticking = false;
const timer = setInterval(() => { if (!ticking) { ticking = true; void manager.tick().finally(() => { ticking = false; }); } }, 250);
const checks: string[] = [];
function check(condition: unknown, description: string) { if (!condition) throw new Error(description); checks.push(description); }
async function stopped() {
  const deadline = Date.now() + 30000;
  while (manager.status("docling-desk").state !== "stopped" && Date.now() < deadline) await Bun.sleep(250);
  check(manager.status("docling-desk").state === "stopped" && !listening(), "idle releases lease and stops process");
}
try {
  check(manager.status("docling-desk").state === "stopped", "initially stopped");
  await fetch(`${base}/health/live`);
  check(starts === 0, "gateway health does not start Docling");
  const anonymous = await fetch(`${base}/api/jobs`);
  check(anonymous.status === 401 && starts === 1, "request wakes app and preserves authentication");
  const headers = { authorization: `Bearer ${appToken}` };
  const ticketResponse = await fetch(`${base}/auth/ui-tickets`, { method: "POST", headers });
  check(ticketResponse.ok, "browser login ticket issued");
  const ticket = await ticketResponse.json() as { url: string };
  const exchange = await fetch(base + ticket.url, { redirect: "manual" });
  check(exchange.status === 303 || exchange.status === 302, "login redirect preserved");
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
  check((await fetch(base, { headers: { cookie } })).ok, "authenticated browser loads frontend");
  const form = new FormData();
  form.append("file", new File(["LARM Docling on-demand verification. Persistent document.\n"], "larm-verification.txt", { type: "text/plain" }));
  const upload = await fetch(`${base}/api/upload`, { method: "POST", headers, body: form });
  check(upload.status === 202, "text document upload accepted");
  const uploaded = await upload.json() as { id: string };
  let jobs: { id: string; state: string }[] = [];
  const deadline = Date.now() + 60000;
  do {
    jobs = await (await fetch(`${base}/api/jobs`, { headers })).json() as typeof jobs;
    if (jobs.some(j => j.id === uploaded.id && ["success", "partial", "failed"].includes(j.state))) break;
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  const job = jobs.find(j => j.id === uploaded.id);
  check(job?.state === "success", `document conversion completes (${job?.state})`);
  await stopped();
  const resumed = await fetch(`${base}/api/jobs`, { headers: { cookie } });
  check(resumed.ok && starts === 2, "browser session survives stop and next request restarts app");
  const saved = await resumed.json() as typeof jobs;
  check(saved.some(j => j.id === uploaded.id), "document persists across restart");
  await stopped();
  await writeFile(`${stage}/acceptance.json`, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), digest: prepared.digest,
    sourceRevision: prepared.sourceRevision, mode: "rootless-real-app-and-larm-manager", checks,
    limitations: ["production systemd/cgroup not exercised", "native Office/Tesseract installation pending"], evidenceRoot: root }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, evidenceRoot: root }, null, 2));
} finally {
  clearInterval(timer); await gateway.close(); await manager.close(); await control.stop(true);
  if (child && !childExited) { child.kill("SIGTERM"); await child.exited; }
}
