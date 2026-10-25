import { expect, test } from "bun:test";
import type { LocalServiceLease } from "../../../packages/core/src/local-service";
import { startDoclingGateway } from "./docling-gateway";

function client(endpoint: string) {
  let ensured = 0, released = 0;
  const lease = { id: "lease", status: "ready", endpoint, expiresAt: new Date(Date.now() + 300000).toISOString() } as LocalServiceLease;
  return { get ensured() { return ensured; }, get released() { return released; },
    async ensure() { ensured++; await Bun.sleep(20); return lease; },
    async renew() { return lease; }, async resolve() { return lease; }, async release() { released++; },
  };
}

test("Docling gateway coalesces wakeups and preserves authentication, redirects and large files", async () => {
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/auth/exchange") return new Response(null, { status: 303, headers: { "set-cookie": "docling_session=opaque; HttpOnly", location: "/" } });
    if (path === "/file") return new Response(new Uint8Array(20 * 1024 ** 2));
    return Response.json({ auth: request.headers.get("authorization"), cookie: request.headers.get("cookie"), forwarded: request.headers.get("x-forwarded-for") });
  } });
  const endpoint = `http://127.0.0.1:${upstream.port}`, api = client(endpoint);
  const gateway = startDoclingGateway({ port: 0, endpoint, idleSeconds: 60, renewSeconds: 15 }, api);
  const base = `http://127.0.0.1:${gateway.server.port}`;
  try {
    const responses = await Promise.all([1, 2, 3].map(() => fetch(base, { headers: { authorization: "Bearer app-secret", cookie: "docling_session=opaque", "x-forwarded-for": "untrusted" } })));
    expect(api.ensured).toBe(1);
    for (const response of responses) expect(await response.json()).toEqual({ auth: "Bearer app-secret", cookie: "docling_session=opaque", forwarded: null });
    const exchange = await fetch(`${base}/auth/exchange`, { redirect: "manual" });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("set-cookie")).toContain("HttpOnly");
    expect(exchange.headers.get("location")).toBe("/");
    expect((await (await fetch(`${base}/file`)).arrayBuffer()).byteLength).toBe(20 * 1024 ** 2);
  } finally { await gateway.close(); await upstream.stop(true); }
});

test("health probes and internal routes cannot wake or drain the application", async () => {
  const endpoint = "http://127.0.0.1:28766", api = client(endpoint);
  const gateway = startDoclingGateway({ port: 0, endpoint, idleSeconds: 60, renewSeconds: 15 }, api);
  const base = `http://127.0.0.1:${gateway.server.port}`;
  try {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    for (const path of ["/internal/larm/drain", "/%69nternal/larm/activity"])
      expect((await fetch(base + path)).status).toBe(404);
    expect((await fetch(base, { headers: { host: `evil.example:${gateway.server.port}` } })).status).toBe(403);
    expect(api.ensured).toBe(0);
  } finally { await gateway.close(); }
});

test("an active response retains its lease until the stream ends", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    return new Response(new ReadableStream({ async start(stream) {
      stream.enqueue(new TextEncoder().encode("data: first\n\n")); await gate;
      stream.enqueue(new TextEncoder().encode("data: last\n\n")); stream.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const endpoint = `http://127.0.0.1:${upstream.port}`, api = client(endpoint);
  const gateway = startDoclingGateway({ port: 0, endpoint, idleSeconds: 0.05, renewSeconds: 0.02 }, api);
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.server.port}`);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
    await Bun.sleep(150); expect(api.released).toBe(0);
    finish(); while (!(await reader.read()).done) { /* drain */ }
    await Bun.sleep(150); expect(api.released).toBe(1);
  } finally { finish(); await gateway.close(); await upstream.stop(true); }
});
