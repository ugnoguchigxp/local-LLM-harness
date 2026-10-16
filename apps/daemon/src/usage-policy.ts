import type { MiddlewareHandler } from "hono";
import { agentPrincipal, type AgentConnectionController } from "./agent-connection-controller";
import { secretMatcher, authenticatedBearerKinds } from "./app-auth";
import { UsageProtectionError, type UsageCoordinator } from "./usage-coordinator";

const gatewayPaths = new Set(["/v1/chat/completions", "/v1/chat/completions/input-tokens", "/v1/audio/transcriptions", "/v1/audio/speech", "/v1/embed", "/v1/systemone"]);
function inference(method: string, path: string): boolean {
  return method === "POST" && (gatewayPaths.has(path)
    || /^\/v[12]\/(contexts|context-views|context-measurements|images\/generations|music\/generations)(?:\/|$)/.test(path));
}
function guarded(method: string, path: string): boolean {
  return (method === "POST" && (path === "/prepare" || path === "/resolve")) || inference(method, path)
    || (method === "GET" && path === "/v1/audio/voices")
    || (method === "POST" && /^\/v1\/(agent-connections$|allocations$|prepare$|resolve$|leases$|deployments\/)/.test(path))
    || (method === "GET" && /\/health$/.test(path) && path !== "/health");
}

export function usagePolicy(usage: UsageCoordinator, token: string, connections?: AgentConnectionController, apiToken?: string, trustedProbe?: (request: Request) => boolean): MiddlewareHandler {
  const protectedPrincipal = agentPrincipal(token);
  const standardPrincipal = apiToken ? agentPrincipal(apiToken) : undefined;
  const protectedMatches = secretMatcher(`Bearer ${token}`);
  const standardMatches = apiToken ? secretMatcher(`Bearer ${apiToken}`) : () => false;
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    let owner: string | undefined = "(anonymous)";
    const kind = authenticatedBearerKinds.get(c.req.raw);
    if (kind === "protected" || (!kind && protectedMatches(authorization))) owner = protectedPrincipal;
    else if (kind === "standard" || (!kind && standardMatches(authorization))) owner = standardPrincipal;
    else if (authorization?.startsWith("Bearer larm_conn_v1.")) {
      // Verify before treating a bearer prefix as an authenticated owner.
      owner = connections?.verifyProviderToken(authorization.slice(7)).record.principal;
    }
    await usage.run(owner, async () => {
      const isInference = inference(c.req.method, c.req.path);
      if (!isInference && guarded(c.req.method, c.req.path)) usage.check();
      const activity = isInference || c.req.path === "/v1/audio/voices" ? usage.request(c.req.raw, isInference && !trustedProbe?.(c.req.raw)) : undefined;
      try { await next(); }
      finally { if (activity && (!activity.claimed || c.error)) activity.finish(c.res.status < 400 || c.res.status >= 500); }
    });
  };
}

export function protectionResponse(error: UsageProtectionError, path = ""): Response {
  const openai = /^\/v1\/(chat\/completions|audio\/)/.test(path);
  return Response.json({ error: { code: error.code, message: error.message, ...(openai ? { type: "invalid_request_error", param: null } : {}) } }, {
    status: 409, headers: { "retry-after": String(error.retryAfterSeconds) },
  });
}
