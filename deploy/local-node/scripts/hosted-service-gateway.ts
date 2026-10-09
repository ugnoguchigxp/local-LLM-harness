import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { ClientLocalServices } from "../../../packages/client/src/client-local-services";
import type { LocalServiceLease } from "../../../packages/core/src/local-service";

export type HostedGatewayConfig = {
  hostname: "127.0.0.1"; port: number; serviceId: string; webRoot: string;
  clientTokens: string[]; allowedEndpoints: string[]; userIdleSeconds: number; renewSeconds: number;
};
type Use = { token: string; lease?: LocalServiceLease; pending?: Promise<LocalServiceLease>; lastOperation: number; active: number; renewing: boolean };
function same(a: string, b: string) { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
export function startHostedGateway(config: HostedGatewayConfig, client: ClientLocalServices) {
  if (config.hostname !== "127.0.0.1" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || config.userIdleSeconds <= 0 || config.renewSeconds <= 0 || !config.clientTokens.length || config.allowedEndpoints.some(endpoint => { const u = new URL(endpoint); return u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !!u.username || !!u.password || u.pathname !== "/" || !!u.search || !!u.hash; })) throw new Error("invalid_hosted_gateway_config");
  const sessions = new Map<string, { token: string; expires: number }>(), uses = new Map<string, Use>();
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  const useFor = (key: string, token: string) => { let use = uses.get(key); if (!use) { use = { token, lastOperation: Date.now(), active: 0, renewing: false }; uses.set(key, use); } return use; };
  async function release(use: Use) { const lease = use.lease; use.lease = undefined; if (lease) await client.release(lease.id).catch(() => {}); }
  async function ready(use: Use): Promise<LocalServiceLease> {
    if (use.pending) return use.pending;
    const task = (async () => {
      if (use.lease && Date.parse(use.lease.expiresAt) > Date.now()) {
        try { use.lease = await client.renew(use.lease); if (use.lease.status === "ready") return use.lease; } catch { await release(use); }
      }
      const initial = await client.ensure(config.serviceId, { ttlSeconds: 120, idempotencyKey: crypto.randomUUID() });
      use.lease = initial;
      const deadline = Date.now() + 180000;
      while (use.lease.status === "starting" && Date.now() < deadline) {
        await Bun.sleep(250);
        if (Date.parse(use.lease.expiresAt) - Date.now() < 60000) use.lease = await client.renew(use.lease);
        use.lease = await client.resolve(use.lease.id);
      }
      if (use.lease.status !== "ready" || !use.lease.endpoint || !config.allowedEndpoints.includes(use.lease.endpoint)) { await release(use); throw new Error("hosted_service_unavailable"); }
      return use.lease;
    })();
    use.pending = task; try { return await task; } finally { use.pending = undefined; }
  }
  const timer = setInterval(() => {
    for (const use of uses.values()) {
      if (use.renewing || use.pending) continue;
      use.renewing = true;
      void (async () => {
        if (!use.active && Date.now() - use.lastOperation >= config.userIdleSeconds * 1000) { await release(use); return; }
        if (use.lease) { try { use.lease = await client.renew(use.lease); } catch { await release(use); } }
      })().finally(() => { use.renewing = false; });
    }
    for (const [key, value] of sessions) if (value.expires < Date.now()) { sessions.delete(key); const use = uses.get(key); if (use) use.lastOperation = 0; }
  }, config.renewSeconds * 1000);
  const server = Bun.serve({ hostname: config.hostname, port: config.port, maxRequestBodySize: 17 * 1024 ** 2, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    try {
      if (![`${config.hostname}:${config.port}`, `localhost:${config.port}`].includes(request.headers.get("host") ?? "")) return json({ error: "host_forbidden" }, 403);
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "origin_forbidden" }, 403);
      if (path === "/auth/session" && request.method === "POST") {
        const raw = await request.text(); if (raw.length > 8192) return json({ error: "body_too_large" }, 413);
        const value = JSON.parse(raw);
        const token = config.clientTokens.find(t => typeof value.token === "string" && same(t, value.token));
        if (!token) return json({ error: "unauthorized" }, 401);
        const id = crypto.randomUUID(); sessions.set(id, { token, expires: Date.now() + 12 * 3600000 });
        return Response.json({ connected: true }, { headers: { "set-cookie": `hosted_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`, "cache-control": "no-store" } });
      }
      const bearer = request.headers.get("authorization")?.replace(/^Bearer /, ""), cookie = /(?:^|;\s*)hosted_session=([a-f0-9-]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      const direct = bearer ? config.clientTokens.find(t => same(t, bearer)) : undefined;
      const session = cookie ? sessions.get(cookie) : undefined;
      const token = direct ?? (session && session.expires > Date.now() ? session.token : undefined);
      const key = direct ? createHash("sha256").update(direct).digest("hex") : cookie;
      if (path.startsWith("/api/") || path === "/mcp" || path === "/activity" || path === "/hosting/status") {
        if (!token || !key) return json({ error: "unauthorized" }, 401);
        const use = useFor(key, token);
        if (path === "/hosting/status") return json(await client.status(config.serviceId));
        if (path === "/activity" && request.method === "POST") {
          const raw = await request.text(); if (raw.length > 1024) return json({ error: "body_too_large" }, 413);
          const value = raw ? JSON.parse(raw) : { active: true };
          if (value.active === false) { use.lastOperation = 0; if (!use.active && !use.pending) await release(use); }
          else if (value.active === true) use.lastOperation = Date.now();
          else return json({ error: "invalid_activity" }, 400);
          return json({ active: value.active });
        }
        use.lastOperation = Date.now(); use.active++;
        try {
          const lease = await ready(use), headers = new Headers(request.headers);
          headers.delete("cookie"); headers.delete("host"); headers.delete("origin"); headers.delete("referer"); headers.set("authorization", `Bearer ${use.token}`);
          const response = await fetch(`${lease.endpoint}${path}${url.search}`, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: "error", signal: request.signal });
          // These applications return bounded JSON/files, not open-ended SSE subscriptions.
          const chunks: Uint8Array[] = []; let length = 0;
          const reader = response.body?.getReader();
          if (reader) try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > 18 * 1024 ** 2) throw new Error("upstream_too_large"); chunks.push(part.value); } } finally { await reader.cancel().catch(() => {}); }
          const bytes = Buffer.concat(chunks);
          const safe = new Headers(response.headers); safe.delete("set-cookie"); safe.delete("content-length"); safe.set("cache-control", "no-store");
          return new Response([204, 304].includes(response.status) ? null : bytes, { status: response.status, headers: safe });
        } finally { use.active--; }
      }
      // Static UI comes from the independently built application; it needs no app process.
      if (request.method !== "GET") return json({ error: "not_found" }, 404);
      const file = resolve(config.webRoot, path === "/" ? "index.html" : decodeURIComponent(path.slice(1)));
      if (!file.startsWith(`${resolve(config.webRoot)}/`) || !await Bun.file(file).exists()) return json({ error: "not_found" }, 404);
      return new Response(Bun.file(file), { headers: { "x-content-type-options": "nosniff" } });
    } catch { return json({ error: "hosting_unavailable" }, 503); }
  } });
  return { server, async close() { clearInterval(timer); await server.stop(); await Promise.all([...uses.values()].map(release)); } };
}
if (import.meta.main) {
  const file = process.env.LARM_HOSTED_GATEWAY_CONFIG; if (!file) throw new Error("LARM_HOSTED_GATEWAY_CONFIG_required");
  const value = JSON.parse(readFileSync(file, "utf8"));
  // Secrets are read from local files, never argv or browser configuration.
  const token = readFileSync(value.larmTokenFile, "utf8").trim();
  const clientTokens: string[] = JSON.parse(readFileSync(value.clientTokensFile, "utf8"));
  const gateway = startHostedGateway({ ...value.gateway, clientTokens }, new ClientLocalServices({ baseUrl: value.larmBaseUrl, token }));
  console.log(`Hosted application gateway on 127.0.0.1:${value.gateway.port}`);
  const shutdown = async () => { await gateway.close(); process.exit(0); }; process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}
