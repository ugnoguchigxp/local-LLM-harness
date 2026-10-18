import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientLocalServices } from "../../../packages/client/src/client-local-services";
import { startHostedGateway } from "./hosted-service-gateway";
import { createOcrIngressHandler, ocrGatewayOrigin, startOcrIngress } from "./hosted-ocr-ingress";

test("OCR ingress resolves the registered gateway instead of using a port as identity", () => {
  const root = mkdtempSync(join(tmpdir(), "larm-ocr-discovery-")), file = join(root, "gateway.json");
  try {
    for (const port of [29001, 29009]) {
      writeFileSync(file, JSON.stringify({ gateway: { serviceId: "ocr-host", hostname: "127.0.0.1", port } }));
      expect(ocrGatewayOrigin(file)).toBe(`http://127.0.0.1:${port}`);
    }
    for (const gateway of [undefined, { serviceId: "object-recognition-host", hostname: "127.0.0.1", port: 29001 },
      { serviceId: "ocr-host", hostname: "0.0.0.0", port: 29001 }, { serviceId: "ocr-host", hostname: "127.0.0.1", port: "29001" }]) {
      writeFileSync(file, JSON.stringify({ gateway }));
      expect(() => ocrGatewayOrigin(file)).toThrow("invalid_ocr_gateway");
    }
    for (const listenAddress of ["0.0.0.0", "127.0.0.1", "8.8.8.8", "::"]) {
      expect(() => startOcrIngress({ serviceId: "ocr-host", listenAddress, port: 29001, gatewayConfigFile: file })).toThrow("invalid_ocr_ingress_config");
    }
  } finally { rmSync(root, { recursive: true }); }
});

test("LAN ingress preserves gateway auth, non-waking status, multipart, jobs and owner boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "larm-ocr-ingress-"));
  const shared = "fixture-shared-" + "s".repeat(40);
  const ownerA = "fixture-owner-a", ownerB = "fixture-owner-b";
  let ensures = 0, uploaded = 0, cancelled = false, upstreamCalls = 0;
  const worker = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    upstreamCalls++;
    const path = new URL(request.url).pathname;
    expect(request.headers.get("authorization")).not.toBe(`Bearer ${shared}`);
    expect(request.headers.get("origin")).toBeNull();
    expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get("x-owner")).toBeNull();
    expect(request.headers.get("x-forwarded-host")).toBeNull();
    if (path === "/api/analyze") {
      const form = await request.formData();
      expect([...form.keys()]).toEqual(["file"]);
      const file = form.get("file") as File;
      uploaded++;
      return file.name.endsWith(".mp4") ? Response.json({ id: "fixture-job", status: "queued" }, { status: 202 })
        : Response.json({ text: await file.text() });
    }
    if (request.headers.get("authorization") !== `Bearer ${ownerA}`) return Response.json({ error: "not_found" }, { status: 404 });
    if (path.endsWith("/cancel")) cancelled = true;
    return Response.json({ id: "fixture-job", status: cancelled ? "cancelled" : "completed" });
  } });
  const lease = { id: "fixture-lease", status: "ready", expiresAt: new Date(Date.now() + 120000).toISOString(), endpoint: worker.url.origin };
  const client = { async ensure() { ensures++; return lease; }, async renew() { return lease; }, async release() {},
    async status() { return { id: "ocr-host", state: "stopped", generation: 7 }; } } as unknown as ClientLocalServices;
  // A real hosted gateway exercises its Host check and owner translation.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!; await reservation.stop();
  const gateway = startHostedGateway({ hostname: "127.0.0.1", port, serviceId: "ocr-host", webRoot: root,
    clientTokens: [ownerA, ownerB], apiToken: shared, allowedEndpoints: [worker.url.origin], userIdleSeconds: 1, renewSeconds: 1 }, client);
  const publicOrigin = "http://192.168.1.20:29007";
  const handler = createOcrIngressHandler(publicOrigin, () => gateway.server.url.origin);
  const call = (path: string, token?: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", new URL(publicOrigin).host);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return handler(new Request(publicOrigin + path, { ...init, headers }));
  };
  try {
    for (const token of [undefined, "invalid", "larm_conn_v1.fixture-claim", "excalidraw-dedicated-fixture"]) {
      expect((await call("/hosting/status", token)).status).toBe(401);
      expect((await call("/api/analyze", token, { method: "POST" })).status).toBe(401);
    }
    const status = await call("/hosting/status", shared);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ id: "ocr-host", state: "stopped", generation: 7 });
    expect(ensures).toBe(0); expect(upstreamCalls).toBe(0);
    for (const [name, content] of [["image.png", "日本語12345"], ["video.mp4", "fixture-video"]]) {
      const form = new FormData(); form.set("file", new File([content!], name!));
      const response = await call("/api/analyze", shared, { method: "POST", body: form, headers: {
        origin: publicOrigin, cookie: "hosted_session=untrusted", "x-owner": "owner-b", "x-forwarded-host": "evil.example",
      } });
      expect(response.status).toBe(name === "image.png" ? 200 : 202);
      if (name === "image.png") expect(await response.json()).toEqual({ text: content });
    }
    expect(uploaded).toBe(2);
    expect((await call("/api/jobs/fixture-job", ownerB)).status).toBe(404);
    expect((await call("/api/jobs/fixture-job/cancel", ownerB, { method: "POST" })).status).toBe(404);
    expect(cancelled).toBe(false);
    expect((await call("/api/jobs/fixture-job", shared)).status).toBe(200);
    expect(await (await call("/api/jobs/fixture-job/cancel", shared, { method: "POST" })).json()).toEqual({ id: "fixture-job", status: "cancelled" });
    for (const path of ["/auth/session", "/activity", "/internal/larm/drain", "/", "/api/jobs/a/other"]) {
      expect((await call(path, shared)).status).toBe(404);
    }
    expect((await call("/hosting/status", shared, { method: "POST" })).status).toBe(405);
    expect((await call("/hosting/status?token=forbidden", shared)).status).toBe(400);
    expect((await call("/hosting/status", shared, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    const hostAttack = new Request(publicOrigin + "/hosting/status", { headers: { host: "evil.example", authorization: `Bearer ${shared}` } });
    expect((await handler(hostAttack)).status).toBe(403);
  } finally { await gateway.close(); await worker.stop(); rmSync(root, { recursive: true }); }
});

test("ingress preserves retryable and validation errors and fails closed when upstream is unavailable", async () => {
  const origin = "http://192.168.1.20:29007";
  let status = 429;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ error: "fixture" }, { status, headers: { "retry-after": "3", "set-cookie": "private=fixture" } });
  } });
  const handler = createOcrIngressHandler(origin, () => upstream.url.origin);
  const request = () => new Request(origin + "/hosting/status", { headers: { host: new URL(origin).host } });
  try {
    for (status of [400, 401, 404, 409, 413, 415, 429, 503]) {
      const response = await handler(request());
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe("3");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const broken = createOcrIngressHandler(origin, () => { throw new Error("fixture-only"); });
    expect((await broken(request())).status).toBe(503);
  } finally { await upstream.stop(); }
});

test("installer derives a private LAN, refuses ambiguous/public networks and recovers gateway restarts", () => {
  const script = `import importlib.util,pathlib
s=importlib.util.spec_from_file_location('ingress','deploy/local-node/scripts/install-ocr-ingress.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
routes=[{'dst':'default','dev':'wifi'}]
def addresses(ip,prefix): return [{'ifname':'wifi','operstate':'UP','addr_info':[{'family':'inet','scope':'global','local':ip,'prefixlen':prefix}]}]
assert m.private_network(routes,addresses('192.168.4.25',24))=={'interface':'wifi','listenAddress':'192.168.4.25','sourceCidr':'192.168.4.0/24'}
for r,a in [(routes,addresses('8.8.8.8',24)),(routes,addresses('192.168.4.25',8)),([],addresses('192.168.4.25',24)),(routes+routes[:1]+[{'dst':'default','dev':'eth'}],addresses('192.168.4.25',24))]:
 try: m.private_network(r,a);raise AssertionError('accepted invalid network')
 except RuntimeError: pass
text=m.unit_text({'user':'fixture','group':'fixture','bun':'/opt/runtime/bun'},pathlib.Path('/opt/release'))
assert 'Requires=larm-ocr-host-gateway.service' in text
assert 'PartOf=larm-ocr-host-gateway.service' in text
assert 'WantedBy=multi-user.target larm-ocr-host-gateway.service' in text
assert 'local-service-ocr-host-app' not in text
assert 'ProtectSystem=strict' in text and 'NoNewPrivileges=yes' in text
print('passed')
`;
  const result = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test("failed ingress activation removes only its own service and firewall rule", () => {
  const script = `import importlib.util,pathlib,tempfile,subprocess,urllib.error
from unittest.mock import patch
s=importlib.util.spec_from_file_location('ingress','deploy/local-node/scripts/install-ocr-ingress.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as t:
 root=pathlib.Path(t)
 m.CONFIG=root/'config/config.json';m.RECEIPT=root/'config/installation.json';m.UNIT_FILE=root/m.UNIT
 bundle=root/'bundle.js';bundle.write_text('fixture')
 digest=m.sha(bundle.read_bytes())
 plan={'bundleSha256':digest,'sourceCidr':'192.168.4.0/24','listenAddress':'192.168.4.25','port':29009,'serviceId':'ocr-host','gatewayConfigFile':'/etc/fixture/gateway.json','user':'fixture','group':'fixture','bun':'/opt/runtime/bun','origin':'http://192.168.4.25:29009'}
 calls=[]
 def run(args,**kwargs):
  calls.append(args)
  if args[:2]==['systemctl','enable']: raise subprocess.CalledProcessError(1,args)
 class Opener:
  def open(self,*args,**kwargs): raise urllib.error.HTTPError('fixture',401,'fixture',{},None)
 original_path=m.Path
 def path(value):
  if value=='/opt/larm-local-services/releases/ocr-ingress': return root/'release'
  return original_path(value)
 with patch.object(m,'Path',side_effect=path),patch.object(m.os,'geteuid',return_value=0),patch.object(m.subprocess,'run',side_effect=run),patch('urllib.request.build_opener',return_value=Opener()):
  try: m.apply(plan,bundle);raise AssertionError('accepted failed enable')
  except subprocess.CalledProcessError: pass
 assert not m.CONFIG.exists() and not m.RECEIPT.exists() and not m.UNIT_FILE.exists()
 assert ['systemctl','disable','--now',m.UNIT] in calls
 assert ['/usr/sbin/ufw','--force','delete','allow','from','192.168.4.0/24','to','192.168.4.25','port','29009','proto','tcp'] in calls
 assert not any('larm-daemon.service' in c or 'larm-local-service-ocr-host-app.service' in c or m.GATEWAY in c for c in calls)
print('passed')
`;
  const result = Bun.spawnSync(["python3", "-c", script], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
