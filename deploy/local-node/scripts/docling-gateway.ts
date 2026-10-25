import { readFileSync } from "node:fs";
import { ClientLocalServices } from "../../../packages/client/src/client-local-services";
import type { LocalServiceLease } from "../../../packages/core/src/local-service";

type Client = Pick<ClientLocalServices, "ensure" | "renew" | "resolve" | "release">;
export type DoclingGatewayConfig = {
  port: number; endpoint: string; idleSeconds: number; renewSeconds: number;
};

/** Wake the complete application and preserve its authentication and streamed responses. */
export function startDoclingGateway(config: DoclingGatewayConfig, client: Client) {
  const target = new URL(config.endpoint);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password ||
      target.pathname !== "/" || target.search || target.hash || !Number.isInteger(config.port) ||
      config.port < 0 || config.port > 65535 || config.idleSeconds <= 0 || config.renewSeconds <= 0)
    throw new Error("invalid_docling_gateway_config");
  let lease: LocalServiceLease | undefined, pending: Promise<LocalServiceLease> | undefined;
  let active = 0, lastUse = 0, closed = false;
  const controllers = new Set<AbortController>();
  const json = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
  async function release() {
    const old = lease; lease = undefined;
    if (old) await client.release(old.id).catch(() => {});
  }
  async function ready(): Promise<LocalServiceLease> {
    if (pending) return pending;
    const task = (async () => {
      if (lease) {
        try { lease = await client.renew(lease); } catch { await release(); }
      }
      lease ??= await client.ensure("docling-desk", { ttlSeconds: 300, idempotencyKey: crypto.randomUUID() });
      const deadline = Date.now() + 180000;
      while (lease.status === "starting" && Date.now() < deadline && !closed) {
        await Bun.sleep(250);
        lease = await client.resolve(lease.id);
      }
      if (closed || lease.status !== "ready" || lease.endpoint !== config.endpoint) {
        await release(); throw new Error("docling_unavailable");
      }
      return lease;
    })();
    pending = task;
    try { return await task; } finally { if (pending === task) pending = undefined; }
  }
  let maintaining = false;
  const timer = setInterval(() => {
    if (maintaining || pending || closed) return;
    maintaining = true;
    void (async () => {
      if (!active && Date.now() - lastUse >= config.idleSeconds * 1000) await release();
      else if (lease) {
        const current = lease;
        try { const renewed = await client.renew(current); if (lease === current) lease = renewed; }
        catch { if (lease === current) await release(); }
      }
    })().finally(() => { maintaining = false; });
  }, config.renewSeconds * 1000);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: config.port, idleTimeout: 0,
    maxRequestBodySize: 51 * 1024 ** 2,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (!["127.0.0.1", "localhost"].some(host => request.headers.get("host") === `${host}:${server.port}`))
        return json("host_forbidden", 403);
      let path: string;
      try { path = decodeURIComponent(url.pathname); } catch { return json("invalid_path", 400); }
      if (path.startsWith("/internal/")) return json("not_found", 404);
      if (url.pathname === "/health/live") return Response.json({ status: "ready", service: "docling-gateway" });
      if (closed) return json("shutting_down", 503);
      active++; lastUse = Date.now();
      const controller = new AbortController(); controllers.add(controller);
      const abort = () => controller.abort(); request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      let finished = false;
      const finish = () => {
        if (finished) return; finished = true;
        active--; lastUse = Date.now(); controllers.delete(controller);
        request.signal.removeEventListener("abort", abort);
      };
      try {
        const current = await ready();
        const headers = new Headers(request.headers);
        for (const key of [...headers.keys()]) if (key.startsWith("x-forwarded-") ||
          ["forwarded", "connection", "keep-alive", "transfer-encoding", "upgrade"].includes(key)) headers.delete(key);
        const response = await fetch(`${current.endpoint}${url.pathname}${url.search}`, {
          method: request.method, headers, redirect: "manual", signal: controller.signal,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        });
        const outgoing = new Headers(response.headers);
        outgoing.delete("transfer-encoding");
        // fetch decodes compressed bodies; do not forward the original encoding/length.
        outgoing.delete("content-encoding"); outgoing.delete("content-length");
        if (!response.body) { finish(); return new Response(null, { status: response.status, headers: outgoing }); }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(stream) {
            try {
              const result = await reader.read();
              if (result.done) { finish(); stream.close(); } else stream.enqueue(result.value);
            } catch (error) { finish(); stream.error(error); }
          },
          async cancel(reason) { controller.abort(); try { await reader.cancel(reason); } finally { finish(); } },
        });
        return new Response(body, { status: response.status, headers: outgoing });
      } catch { finish(); return json("docling_unavailable", 503); }
    },
  });
  return { server, async close() {
    closed = true; clearInterval(timer);
    for (const controller of controllers) controller.abort();
    await server.stop(true); await pending?.catch(() => {}); await release();
  } };
}

if (import.meta.main) {
  const config = JSON.parse(readFileSync(process.env.LARM_DOCLING_GATEWAY_CONFIG!, "utf8"));
  const client = new ClientLocalServices({ baseUrl: "http://127.0.0.1:9810", token: readFileSync(config.tokenFile, "utf8").trim() });
  const gateway = startDoclingGateway(config.gateway, client);
  const stop = async () => { await gateway.close(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
