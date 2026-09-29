import {
  compatibilityApiOperation,
} from "@larm/core";
import type { MiddlewareHandler } from "hono";
import type { AppDeps } from "./app-types";
import {
  acceptsAnonymousAgentApi,
  acceptsProviderBearer,
  isPersonalStateApiPath,
  isServiceHarnessRequest,
  secretMatches,
} from "./app-auth";
import { errorBody } from "./app-http";

export type AppIdentity = {
  version: string;
  releaseCommit: string;
  configRevision: string;
  bootEpoch: string;
};

export function createAppRequestPolicy(
  deps: AppDeps,
  identity: AppIdentity,
): MiddlewareHandler {
  return async (c, next) => {
    const compatibilityOperation = compatibilityApiOperation(c.req.method, c.req.path);
    let earlyStatus: number | undefined;
    try {
      c.header("x-larm-boot-epoch", identity.bootEpoch);
      c.header("x-larm-config-revision", deps.getConfigRevision?.() ?? identity.configRevision);
      if (c.req.path === "/v1/activity") c.header("cache-control", "no-store");
      if (isPersonalStateApiPath(c.req.path)) c.header("cache-control", "no-store");
      const publicPath = c.req.path === "/health" || c.req.path === "/ready";
      const anonymousAgentConnection = deps.allowAnonymousAgentConnections === true
        && c.req.header("authorization") === undefined
        && acceptsAnonymousAgentApi(c.req.method, c.req.path);
      const anonymousServiceHarness = deps.serviceHarnessAuthEnabled !== true
        && c.req.header("authorization") === undefined
        && isServiceHarnessRequest(
          c.req.method,
          c.req.path,
          c.req.header("x-larm-allocation-id"),
        );
      if (deps.apiToken && !publicPath && !anonymousAgentConnection && !anonymousServiceHarness) {
        const expected = `Bearer ${deps.apiToken}`;
        const authorization = c.req.header("authorization");
        const providerBearer = authorization?.startsWith("Bearer larm_conn_v1.") === true
          && acceptsProviderBearer(c.req.method, c.req.path);
        if (!secretMatches(authorization, expected) && !providerBearer) {
          earlyStatus = 401;
          return c.json(errorBody("unauthorized", "valid bearer token required"), 401);
        }
      }
      const gatewayReadiness = deps.getGatewayReadiness?.();
      if (
        gatewayReadiness
        && !gatewayReadiness.ready
        && new Set([
          "/v1/chat/completions",
          "/v1/audio/transcriptions",
          "/v1/audio/speech",
          "/v1/embed",
          "/v1/systemone",
        ]).has(c.req.path)
        && !(
          gatewayReadiness.state === "verifying"
          && deps.startupProbeToken
          && secretMatches(c.req.header("x-larm-startup-probe"), deps.startupProbeToken)
        )
      ) {
        c.header("retry-after", "1");
        earlyStatus = 503;
        return c.json(errorBody("gateway_not_ready", "LARM Gateway is not ready"), 503);
      }
      await next();
    } catch (error) {
      earlyStatus = 500;
      throw error;
    } finally {
      if (compatibilityOperation) {
        const outcome = c.req.raw.signal.aborted
          ? "aborted"
          : `${Math.floor((earlyStatus ?? c.res.status) / 100)}xx`;
        deps.metrics?.record({
          name: "compatibility_api_requests",
          labels: { operation: compatibilityOperation, outcome },
        });
      }
    }
  };
}
