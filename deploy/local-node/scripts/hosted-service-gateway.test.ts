import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientLocalServices } from "../../../packages/client/src/client-local-services";
import { startHostedGateway } from "./hosted-service-gateway";

test("gateway gates wakeup, coalesces requests, and holds a lease through active work", async () => {
  const root = mkdtempSync(join(tmpdir(), "larm-hosted-gateway-"));
  writeFileSync(join(root, "index.html"), "independent application");
  let ensures = 0, releases = 0, renewals = 0;
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 18881, async fetch(r) {
    expect(r.headers.get("authorization")).toBe("Bearer test-user-key");
    expect(r.headers.get("cookie")).toBeNull();
    if (new URL(r.url).pathname === "/api/held") await held;
    return Response.json({ served: true });
  } });
  const lease = { id: "fixture-lease", serviceId: "excalidraw-host", revision: "a".repeat(64), generation: 1, bootEpoch: "fixture", expiresAt: new Date(Date.now() + 120000).toISOString(), status: "ready", endpoint: "http://127.0.0.1:18881" };
  const client = { async ensure() { ensures++; await Bun.sleep(50); return lease; }, async renew() { renewals++; return lease; }, async release() { releases++; }, async status() { return { state: "stopped" }; } } as unknown as ClientLocalServices;
  const gateway = startHostedGateway({ hostname: "127.0.0.1", port: 18880, serviceId: "excalidraw-host", webRoot: root, clientTokens: ["test-user-key"], allowedEndpoints: [lease.endpoint], userIdleSeconds: 0.1, renewSeconds: 0.05 }, client);
  const base = "http://127.0.0.1:18880", headers = { authorization: "Bearer test-user-key" };
  try {
    expect(await (await fetch(base)).text()).toBe("independent application");
    expect((await fetch(`${base}/api/documents`)).status).toBe(401);
    expect((await fetch(`${base}/api/documents`, { headers: { ...headers, origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/hosting/status`, { headers })).status).toBe(200);
    expect(ensures).toBe(0);
    const results = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/api/documents`, { headers })));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(ensures).toBe(1);
    const pending = fetch(`${base}/api/held`, { headers });
    await Bun.sleep(250);
    expect(releases).toBe(0);
    expect(renewals).toBeGreaterThan(0);
    finish(); expect((await pending).status).toBe(200);
    await Bun.sleep(180); expect(releases).toBe(1);
    expect((await fetch(`${base}/internal/larm/drain`, { headers })).status).toBe(404);
    expect(ensures).toBe(1);
  } finally { finish(); await gateway.close(); await upstream.stop(); rmSync(root, { recursive: true }); }
});
