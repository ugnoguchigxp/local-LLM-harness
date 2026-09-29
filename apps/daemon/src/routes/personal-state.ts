import {
  canonicalMeasurementRequestSchema,
  forgetRequestSchema,
  personalStateViewRequestSchema,
  type PersonalStateScope,
} from "@larm/core";
import type { Context, Hono } from "hono";
import type { PersonalStateController } from "../personal-state-controller";
import type { VerifiedProviderToken } from "../agent-connection-controller";
import { errorBody, readJson } from "../app-http";
import { readBodyLimited, RequestBodyError } from "../http-body";

type PersonalStateFeature = {
  controller: PersonalStateController;
  caller: VerifiedProviderToken;
};

export type PersonalStateRouteHelpers = {
  feature: (
    context: Context,
    scope: PersonalStateScope,
    allocationId?: string,
  ) => PersonalStateFeature | Response;
  idempotencyKey: (context: Context) => string | Response;
  handleError: (context: Context, error: unknown) => Response;
};

export function registerPersonalStateRoutes(
  app: Hono,
  helpers: PersonalStateRouteHelpers,
  limits: {
    controlMaxBodyBytes: number;
    gatewayMaxBodyBytes: number;
    personalStateMaxSourceBytes: number;
  },
): void {
  app.get("/v1/personal-state/capability", async (c) => {
    const allocationId = c.req.header("x-larm-allocation-id") ?? c.req.query("allocationId");
    const runtime = c.req.header("x-larm-runtime") ?? c.req.query("runtime");
    if (!allocationId || !runtime) {
      return c.json(errorBody("personal_state_request_invalid", "allocationId and runtime are required"), 400);
    }
    const feature = helpers.feature(c, "context.operation.read", allocationId);
    if (feature instanceof Response) return feature;
    try {
      c.header("cache-control", "no-store");
      return c.json(await feature.controller.capability({
        principal: feature.caller.record.principal,
        allocationId,
        runtime,
        credentialExpiresAt: feature.caller.record.expiresAt,
      }));
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });

  app.post("/v1/context-sources", async (c) => {
    const incarnation = c.req.header("x-larm-source-incarnation");
    const allocationId = c.req.header("x-larm-allocation-id");
    const runtime = c.req.header("x-larm-runtime");
    const sourceDigest = c.req.header("x-larm-source-digest");
    if (
      !incarnation
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(incarnation)
      || !allocationId
      || !runtime
      || !sourceDigest
      || !/^[a-f0-9]{64}$/.test(sourceDigest)
    ) {
      return c.json(errorBody("personal_state_request_invalid", "source delivery headers are invalid"), 400);
    }
    const contentType = c.req.header("content-type") ?? "";
    if (!/^text\/plain\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(contentType)) {
      return c.json(errorBody(
        "personal_state_request_invalid",
        "source must use Content-Type text/plain; charset=utf-8",
      ), 400);
    }
    const feature = helpers.feature(c, "context.source.provision", allocationId);
    if (feature instanceof Response) return feature;
    let content: string;
    try {
      const bytes = await readBodyLimited(c.req.raw, limits.personalStateMaxSourceBytes);
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (error instanceof RequestBodyError) return c.json(errorBody(error.code, error.message), error.status);
      return c.json(errorBody("personal_state_request_invalid", "source must be valid UTF-8"), 400);
    }
    try {
      const result = await feature.controller.provision({
        principal: feature.caller.record.principal,
        incarnation,
        allocationId,
        runtime,
        sourceDigest,
        content,
      });
      c.header("cache-control", "no-store");
      if (result.replay) c.header("x-larm-idempotent-replay", "true");
      c.header("location", `/v1/context-source-operations/${encodeURIComponent(incarnation)}`);
      return c.json(result.receipt, result.replay ? 200 : 201);
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });

  app.get("/v1/context-source-operations/:incarnation", async (c) => {
    const feature = helpers.feature(c, "context.operation.read");
    if (feature instanceof Response) return feature;
    try {
      c.header("cache-control", "no-store");
      return c.json(await feature.controller.provisionReceipt(
        feature.caller.record.principal,
        c.req.param("incarnation"),
      ));
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });

  app.post("/v1/context-measurements", async (c) => {
    const parsed = canonicalMeasurementRequestSchema.safeParse(await readJson(c, limits.gatewayMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("personal_state_request_invalid", "invalid canonical measurement request"), 400);
    }
    const feature = helpers.feature(c, "context.measure", parsed.data.allocationId);
    if (feature instanceof Response) return feature;
    try {
      const result = await feature.controller.measure(feature.caller.record.principal, parsed.data);
      c.header("cache-control", "no-store");
      if (result.replay) c.header("x-larm-idempotent-replay", "true");
      c.header("location", `/v1/context-measurements/${encodeURIComponent(result.receipt.measurementId)}`);
      return c.json(result.receipt, result.replay ? 200 : 201);
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });

  app.get("/v1/context-measurements/:id", async (c) => {
    const feature = helpers.feature(c, "context.operation.read");
    if (feature instanceof Response) return feature;
    try {
      c.header("cache-control", "no-store");
      return c.json(await feature.controller.measurementReceipt(feature.caller.record.principal, c.req.param("id")));
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });

  app.post("/v2/context-views", async (c) => {
    const key = helpers.idempotencyKey(c);
    if (key instanceof Response) return key;
    const parsed = personalStateViewRequestSchema.safeParse(await readJson(c, limits.gatewayMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("personal_state_request_invalid", "invalid Context View v2 request"), 400);
    }
    const feature = helpers.feature(c, "context.view.create", parsed.data.allocationId);
    if (feature instanceof Response) return feature;
    try {
      const result = await feature.controller.createView(feature.caller.record.principal, parsed.data, key);
      c.header("cache-control", "no-store");
      if (result.replay) c.header("x-larm-idempotent-replay", "true");
      c.header("location", `/v2/context-views/${encodeURIComponent(parsed.data.viewRequestId)}`);
      return c.json(result.view, result.replay ? 200 : 201);
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });

  app.get("/v2/context-views/:id", async (c) => {
    const feature = helpers.feature(c, "context.operation.read");
    if (feature instanceof Response) return feature;
    try {
      c.header("cache-control", "no-store");
      return c.json(await feature.controller.viewReceipt(feature.caller.record.principal, c.req.param("id")));
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });

  app.get("/v1/generation-attempts/:id", async (c) => {
    const feature = helpers.feature(c, "context.operation.read");
    if (feature instanceof Response) return feature;
    try {
      c.header("cache-control", "no-store");
      return c.json(await feature.controller.attemptReceipt(feature.caller.record.principal, c.req.param("id")));
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });

  app.post("/v1/generation-attempts/:id/cancel", async (c) => {
    const feature = helpers.feature(c, "context.attempt.cancel");
    if (feature instanceof Response) return feature;
    try {
      c.header("cache-control", "no-store");
      return c.json(await feature.controller.cancelAttempt(feature.caller.record.principal, c.req.param("id")));
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });

  app.post("/v1/context-forget-operations", async (c) => {
    const parsed = forgetRequestSchema.safeParse(await readJson(c, limits.controlMaxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("personal_state_request_invalid", "invalid forget request"), 400);
    }
    const feature = helpers.feature(c, "context.forget");
    if (feature instanceof Response) return feature;
    try {
      const result = await feature.controller.forget(feature.caller.record.principal, parsed.data);
      c.header("cache-control", "no-store");
      if (result.replay) c.header("x-larm-idempotent-replay", "true");
      c.header("location", `/v1/context-forget-operations/${encodeURIComponent(result.operation.forgetId)}`);
      return c.json(result.operation, result.operation.state === "succeeded" ? 200 : 202);
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });

  app.get("/v1/context-forget-operations/:id", async (c) => {
    const feature = helpers.feature(c, "context.operation.read");
    if (feature instanceof Response) return feature;
    try {
      c.header("cache-control", "no-store");
      return c.json(await feature.controller.forgetReceipt(feature.caller.record.principal, c.req.param("id")));
    } catch (error) {
      return helpers.handleError(c, error);
    }
  });
}
