import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export type OcrIngressConfig = {
  serviceId: "ocr-host";
  listenAddress: string;
  port: number;
  gatewayConfigFile: string;
};

const validPort = (port: number) => Number.isInteger(port) && port > 0 && port <= 65535;
const privateAddress = (address: string) => isIP(address) === 4 && (
  address.startsWith("10.") || address.startsWith("192.168.")
  || (address.startsWith("172.") && Number(address.split(".")[1]) >= 16 && Number(address.split(".")[1]) <= 31)
);

// Resolve the registered gateway, never a lease endpoint or a worker port.
export function ocrGatewayOrigin(file: string): string {
  const { gateway } = JSON.parse(readFileSync(file, "utf8"));
  if (gateway?.serviceId !== "ocr-host" || gateway.hostname !== "127.0.0.1" || !validPort(gateway.port)) {
    throw new Error("invalid_ocr_gateway");
  }
  return `http://127.0.0.1:${gateway.port}`;
}

export function createOcrIngressHandler(origin: string, upstreamOrigin: () => string) {
  const host = new URL(origin).host;
  const json = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.headers.get("host") !== host) return json("host_forbidden", 403);
    const browserOrigin = request.headers.get("origin");
    if (browserOrigin !== null && browserOrigin !== origin) return json("origin_forbidden", 403);
    // Credentials belong in Authorization; no query string is part of this API.
    if (url.search) return json("query_forbidden", 400);
    const job = /^\/api\/jobs\/[a-zA-Z0-9_-]+(\/cancel)?$/.exec(url.pathname);
    const method = url.pathname === "/hosting/status" ? "GET"
      : url.pathname === "/api/analyze" ? "POST"
      : job ? (job[1] ? "POST" : "GET") : undefined;
    if (!method) return json("not_found", 404);
    if (request.method !== method) return json("method_not_allowed", 405);
    try {
      // Terminate the public Host/Origin boundary here, then let fetch generate
      // the loopback Host expected by the unchanged hosted gateway. Do not pass
      // cookies, owner assertions, forwarding headers, or browser credentials.
      const headers = new Headers();
      for (const name of ["authorization", "content-type", "accept"]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const response = await fetch(`${upstreamOrigin()}${url.pathname}`, {
        method, headers, body: method === "POST" ? request.body : undefined,
        redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]),
      });
      const safe = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
      for (const name of ["content-type", "retry-after"]) {
        const value = response.headers.get(name);
        if (value !== null) safe.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers: safe });
    } catch {
      // Never log a credential-bearing request, exception, or upstream body.
      return json("ocr_gateway_unavailable", 503);
    }
  };
}

export function startOcrIngress(config: OcrIngressConfig) {
  if (config.serviceId !== "ocr-host" || !privateAddress(config.listenAddress) || !validPort(config.port)
    || !config.gatewayConfigFile.startsWith("/")) throw new Error("invalid_ocr_ingress_config");
  ocrGatewayOrigin(config.gatewayConfigFile);
  const origin = `http://${config.listenAddress}:${config.port}`;
  const server = Bun.serve({
    hostname: config.listenAddress, port: config.port, idleTimeout: 255,
    maxRequestBodySize: 17 * 1024 ** 2,
    fetch: createOcrIngressHandler(origin, () => ocrGatewayOrigin(config.gatewayConfigFile)),
  });
  return { server, origin };
}

if (import.meta.main) {
  try {
    const file = process.env.LARM_OCR_INGRESS_CONFIG;
    if (!file) throw new Error("ocr_ingress_config_required");
    const { server, origin } = startOcrIngress(JSON.parse(readFileSync(file, "utf8")));
    console.log(JSON.stringify({ serviceId: "ocr-host", origin }));
    const shutdown = async () => { await server.stop(); process.exit(0); };
    process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  } catch {
    console.error("ocr_ingress_start_failed");
    process.exit(1);
  }
}
