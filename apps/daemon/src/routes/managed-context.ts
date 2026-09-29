import {
  contextRegistrationRequestSchema,
  contextViewRequestSchema,
  type PersonalStateScope,
} from "@larm/core";
import type { Context, Hono } from "hono";
import type { ContextController } from "../context-controller";
import type { PersonalStateController } from "../personal-state-controller";
import type { VerifiedProviderToken } from "../agent-connection-controller";
import { errorBody, readJson } from "../app-http";

type ContextCaller = { principal: string; scoped?: VerifiedProviderToken };
type PersonalStateFeature = {
  controller: PersonalStateController;
  caller: VerifiedProviderToken;
};

export type ManagedContextRouteHelpers = {
  contextFeature: (context: Context) => ContextController | Response;
  contextCaller: (context: Context) => ContextCaller | Response;
  personalStateFeature: (
    context: Context,
    scope: PersonalStateScope,
    allocationId?: string,
  ) => PersonalStateFeature | Response;
  idempotencyKey: (context: Context) => string | Response;
  contextError: (context: Context, error: unknown) => Response;
};

export function registerManagedContextRoutes(
  app: Hono,
  helpers: ManagedContextRouteHelpers,
  limits: { controlMaxBodyBytes: number },
): void {
  app.get("/v1/context-status", (c) => {
    const feature = helpers.contextFeature(c);
    if (feature instanceof Response) return feature;
    const caller = helpers.contextCaller(c);
    if (caller instanceof Response) return caller;
    c.header("cache-control", "no-store");
    return c.json(feature.statuses(caller.principal));
  });

  app.post("/v1/contexts", async (c) => {
    const feature = helpers.contextFeature(c);
    if (feature instanceof Response) return feature;
    const caller = helpers.contextCaller(c);
    if (caller instanceof Response) return caller;
    const key = helpers.idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = contextRegistrationRequestSchema.safeParse(await readJson(c, limits.controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("context_request_invalid", "invalid context descriptor"), 400);
    }
    try {
      const result = caller.scoped
        ? await (() => {
          const personal = helpers.personalStateFeature(
            c,
            "context.source.provision",
            caller.scoped.record.allocationId,
          );
          if (personal instanceof Response) return personal;
          return personal.controller.registerContext({
            principal: caller.principal,
            allocationId: caller.scoped.record.allocationId,
            request: parsed.data,
            idempotencyKey: key,
          });
        })()
        : await feature.register(parsed.data, caller.principal, key);
      if (result instanceof Response) return result;
      if (result.replay) c.header("x-larm-idempotent-replay", "true");
      c.header("location", `/v1/contexts/${encodeURIComponent(result.descriptor.id)}`);
      return c.json(result.descriptor, result.replay ? 200 : 201);
    } catch (error) {
      return helpers.contextError(c, error);
    }
  });

  app.get("/v1/contexts", (c) => {
    const feature = helpers.contextFeature(c);
    if (feature instanceof Response) return feature;
    const caller = helpers.contextCaller(c);
    if (caller instanceof Response) return caller;
    try {
      const rawLimit = c.req.query("limit");
      return c.json(feature.list(caller.principal, {
        ...(c.req.query("cursor") ? { cursor: c.req.query("cursor") } : {}),
        ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}),
      }));
    } catch (error) {
      return helpers.contextError(c, error);
    }
  });

  app.delete("/v1/contexts/:id", async (c) => {
    const feature = helpers.contextFeature(c);
    if (feature instanceof Response) return feature;
    const caller = helpers.contextCaller(c);
    if (caller instanceof Response) return caller;
    const key = helpers.idempotencyKey(c);
    if (key instanceof Response) return key;
    try {
      const result = await feature.delete(caller.principal, c.req.param("id"), key);
      if (result.replay) c.header("x-larm-idempotent-replay", "true");
      return c.body(null, 204);
    } catch (error) {
      return helpers.contextError(c, error);
    }
  });

  app.post("/v1/context-views", async (c) => {
    const feature = helpers.contextFeature(c);
    if (feature instanceof Response) return feature;
    const caller = helpers.contextCaller(c);
    if (caller instanceof Response) return caller;
    const key = helpers.idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = contextViewRequestSchema.safeParse(await readJson(c, limits.controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("context_request_invalid", "invalid context view request"), 400);
    }
    if (caller.scoped && caller.scoped.record.allocationId !== parsed.data.allocationId) {
      return c.json(errorBody("connection_forbidden", "allocation does not match provider token"), 403);
    }
    try {
      const result = await feature.createView(parsed.data, caller.principal, key);
      if (result.replay) c.header("x-larm-idempotent-replay", "true");
      c.header("location", `/v1/context-views/${encodeURIComponent(result.view.id)}`);
      return c.json(result.view, result.replay ? 200 : 201);
    } catch (error) {
      return helpers.contextError(c, error);
    }
  });

  app.get("/v1/context-operations/:id", (c) => {
    const feature = helpers.contextFeature(c);
    if (feature instanceof Response) return feature;
    const caller = helpers.contextCaller(c);
    if (caller instanceof Response) return caller;
    try {
      c.header("cache-control", "no-store");
      return c.json(feature.getOperation(caller.principal, c.req.param("id")));
    } catch (error) {
      return helpers.contextError(c, error);
    }
  });
}
