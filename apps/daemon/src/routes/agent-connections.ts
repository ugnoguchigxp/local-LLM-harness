import { Hono, type Context } from "hono";
import {
  agentConnectionClaimRequestSchema,
  agentConnectionRenewRequestSchema,
  agentConnectionRequestSchema,
  type AgentConnectionCatalog,
} from "@larm/core";
import { errorBody, readJson } from "../app-http";
import { secretMatches } from "../app-auth";
import { ConnectionTokenError } from "../connection-token";
import type { AgentConnectionController } from "../agent-connection-controller";
import type { ControlEvent } from "../controller";

type AgentConnectionResult = {
  status: number;
  body: unknown;
  replay?: boolean;
  location?: string;
  retryAfterSeconds?: number;
};

export function registerAgentConnectionRoutes(app: Hono, options: {
  apiToken?: string;
  managementToken?: string;
  catalog?: AgentConnectionCatalog;
  maxBodyBytes: number;
  feature: (context: Context) => AgentConnectionController | Response;
  idempotencyKey: (context: Context) => string | Response;
  requestPrincipal: (context: Context) => string;
  principal: () => string;
  result: (context: Context, result: AgentConnectionResult) => Response;
  onEvent?: (event: ControlEvent) => void;
}): void {
  const { feature, idempotencyKey, requestPrincipal, principal, result } = options;

  app.post("/v1/agent-connections", async (c) => {
    const controller = feature(c);
    if (controller instanceof Response) return controller;
    const key = idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = agentConnectionRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) return c.json(errorBody("invalid_request", "invalid agent connection request"), 400);
    const prefer = c.req.header("prefer");
    let requestedWaitSeconds = 0;
    if (prefer !== undefined) {
      const match = /^wait=([1-9][0-9]{0,2})$/.exec(prefer.trim());
      if (!match || Number(match[1]) > 300) {
        return c.json(errorBody("invalid_request", "Prefer must be wait=N where N is between 1 and 300"), 400);
      }
      requestedWaitSeconds = Number(match[1]);
    }
    const waitSeconds = Math.min(requestedWaitSeconds, 3);
    if (parsed.data.deploymentPolicy === "allow-listed") {
      if (!options.managementToken) {
        return c.json(errorBody("management_not_configured", "allow-listed deployment is disabled"), 503);
      }
      if (!secretMatches(c.req.header("x-larm-management-token"), options.managementToken)) {
        return c.json(errorBody("forbidden", "valid management token required for deployment"), 403);
      }
    }
    const created = await controller.create(
      parsed.data,
      requestPrincipal(c),
      key,
      c.req.url,
      secretMatches(c.req.header("authorization"), `Bearer ${options.apiToken}`),
      waitSeconds * 1_000,
    );
    const selector = options.catalog?.profileSelectors.find((item) => item.id === parsed.data.profile);
    const errorCode = typeof created.body === "object" && created.body !== null && "error" in created.body
      && typeof created.body.error === "object" && created.body.error !== null && "code" in created.body.error
      ? String(created.body.error.code)
      : undefined;
    options.onEvent?.({
      name: created.status === 201 || created.status === 202
        ? "agent_connection_create_accepted"
        : "agent_connection_create_rejected",
      labels: {
        requestedProfile: parsed.data.profile,
        canonicalProfile: options.catalog?.profiles.find((profile) => profile.id === selector?.agentProfile)
          ?.canonicalProfile ?? "(unknown)",
        status: String(created.status),
        ...(errorCode ? { code: errorCode } : {}),
      },
    });
    if (requestedWaitSeconds > 0) c.header("preference-applied", `wait=${waitSeconds}`);
    return result(c, created);
  });

  app.get("/v1/agent-connections/:id", (c) => {
    const controller = feature(c);
    if (controller instanceof Response) return controller;
    return result(c, controller.get(c.req.param("id"), requestPrincipal(c)));
  });

  app.get("/v1/agent-connections/:id/health", async (c) => {
    const controller = feature(c);
    if (controller instanceof Response) return controller;
    c.header("cache-control", "no-store");
    const health = await controller.health(c.req.param("id"), requestPrincipal(c));
    options.onEvent?.({ name: "agent_connection_health_checked", labels: { status: String(health.status) } });
    return result(c, health);
  });

  app.get("/v1/agent-connections/:id/providers/:name/health", async (c) => {
    const controller = feature(c);
    if (controller instanceof Response) return controller;
    c.header("cache-control", "no-store");
    const authorization = c.req.header("authorization");
    if (secretMatches(authorization, `Bearer ${options.apiToken}`)) {
      return result(c, await controller.providerHealth(c.req.param("id"), c.req.param("name"), principal()));
    }
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    try {
      const verified = controller.verifyProviderToken(token);
      if (verified.record.id !== c.req.param("id") || verified.provider.name !== c.req.param("name")) {
        return c.json(errorBody("connection_forbidden", "provider token scope does not match this health endpoint"), 403);
      }
      return result(c, await controller.providerHealth(c.req.param("id"), c.req.param("name")));
    } catch (error) {
      if (error instanceof ConnectionTokenError) {
        const idleReleased = error.code === "connection_idle_released";
        return c.json(errorBody(idleReleased ? error.code : "unauthorized", error.message), idleReleased ? 409 : 401);
      }
      throw error;
    }
  });

  app.post("/v1/agent-connections/:id/claim", async (c) => {
    const controller = feature(c);
    if (controller instanceof Response) return controller;
    if (c.req.header("idempotency-key") !== undefined) {
      options.onEvent?.({
        name: "agent_connection_claim_rejected",
        labels: { status: "400", providers: "0", reason: "idempotency_key_forbidden" },
      });
      return c.json(errorBody("invalid_request", "claim does not accept Idempotency-Key"), 400);
    }
    const parsed = agentConnectionClaimRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) {
      options.onEvent?.({
        name: "agent_connection_claim_rejected",
        labels: { status: "400", providers: "0", reason: "invalid_body" },
      });
      return c.json(errorBody("invalid_request", "invalid claim request"), 400);
    }
    const claimed = await controller.claim(
      c.req.param("id"), requestPrincipal(c), parsed.data.format,
      secretMatches(c.req.header("authorization"), `Bearer ${options.apiToken}`),
    );
    const providers = typeof claimed.body === "object" && claimed.body !== null && "providers" in claimed.body
      && Array.isArray(claimed.body.providers) ? claimed.body.providers : [];
    const rejectionReason = typeof claimed.body === "object" && claimed.body !== null && "error" in claimed.body
      && typeof claimed.body.error === "object" && claimed.body.error !== null && "code" in claimed.body.error
      ? String(claimed.body.error.code)
      : undefined;
    options.onEvent?.({
      name: claimed.status === 200 ? "agent_connection_claim_accepted" : "agent_connection_claim_rejected",
      labels: {
        status: String(claimed.status),
        providers: String(providers.length),
        ...(claimed.status === 200 ? {} : { reason: rejectionReason ?? "controller_rejected" }),
      },
    });
    return result(c, claimed);
  });

  app.post("/v1/agent-connections/:id/renew", async (c) => {
    const controller = feature(c);
    if (controller instanceof Response) return controller;
    const key = idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = agentConnectionRenewRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) return c.json(errorBody("invalid_request", "invalid renewal request"), 400);
    return result(c, await controller.renew(c.req.param("id"), parsed.data.ttlSeconds, requestPrincipal(c), key));
  });

  app.delete("/v1/agent-connections/:id", async (c) => {
    const controller = feature(c);
    if (controller instanceof Response) return controller;
    const released = await controller.release(c.req.param("id"), requestPrincipal(c));
    options.onEvent?.({
      name: "agent_connection_release_completed",
      labels: { status: String(released.status) },
    });
    return result(c, released);
  });
}
