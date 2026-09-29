import {
  createOpenApiDocument,
  createServiceActivity,
  releaseConvergenceStatusSchema,
  type ClusterState,
} from "@larm/core";
import type { Hono } from "hono";
import type { ControlPlane } from "../controller";
import type { MetricsRegistry, RequestTracker } from "../metrics";
import type { DaemonIdentity } from "../identity";
import type { GatewayReadiness } from "../gateway-lifecycle";
import { errorBody } from "../app-http";

export type HealthRouteDeps = {
  getState: () => ClusterState;
  control: ControlPlane;
  metrics?: MetricsRegistry;
  requestTracker?: RequestTracker;
  stateMaxAgeMs?: number;
  now?: () => number;
  identity: DaemonIdentity;
  getConfigRevision?: () => string;
  getReleaseConvergenceStatus?: () => Promise<unknown> | unknown;
  getGatewayReadiness?: () => GatewayReadiness;
  onEvent?: (event: Parameters<MetricsRegistry["record"]>[0]) => void;
};

export function registerHealthRoutes(
  app: Hono,
  deps: HealthRouteDeps,
  activityState: { current?: string },
): void {
  app.get("/health", (c) => {
    const gateway = deps.getGatewayReadiness?.();
    return c.json({
      status: gateway && !gateway.ready ? gateway.state : "ok",
      ready: gateway?.ready ?? true,
      ...(gateway ? { readiness: gateway } : {}),
      version: deps.identity.version,
      releaseCommit: deps.identity.releaseCommit,
      configRevision: deps.getConfigRevision?.() ?? deps.identity.configRevision,
      bootEpoch: deps.identity.bootEpoch,
    }, gateway && !gateway.ready ? 503 : 200);
  });

  app.get("/v1/release-convergence", async (c) => {
    c.header("cache-control", "no-store");
    if (!deps.getReleaseConvergenceStatus) {
      return c.json(errorBody("release_convergence_unavailable", "release convergence status is not configured"), 503);
    }
    try {
      const parsed = releaseConvergenceStatusSchema.safeParse(await deps.getReleaseConvergenceStatus());
      if (!parsed.success) {
        return c.json(errorBody("release_convergence_invalid", "release convergence status is invalid"), 503);
      }
      return c.json(parsed.data);
    } catch {
      return c.json(errorBody("release_convergence_unavailable", "release convergence status is unavailable"), 503);
    }
  });

  app.get("/ready", (c) => {
    const gateway = deps.getGatewayReadiness?.();
    if (gateway && !gateway.ready) {
      return c.json({ status: gateway.state, reason: gateway.reason }, 503);
    }
    const generated = Date.parse(deps.getState().generatedAt);
    const age = (deps.now?.() ?? Date.now()) - generated;
    if (deps.control.isDraining()) {
      return c.json({ status: "draining" }, 503);
    }
    if (!Number.isFinite(age) || age < 0 || age > (deps.stateMaxAgeMs ?? 10_000)) {
      return c.json({ status: "stale", ageMs: age }, 503);
    }
    return c.json({ status: "ready" });
  });

  app.get("/v1/activity", (c) => {
    if (new URL(c.req.url).search || c.req.raw.body !== null) {
      return c.json(errorBody("invalid_request", "activity request cannot use query parameters or a body"), 400);
    }
    if (!deps.requestTracker) {
      c.header("retry-after", "1");
      return c.json(errorBody("activity_unavailable", "service activity tracking is unavailable"), 503);
    }
    const startedAt = performance.now();
    const activity = createServiceActivity({
      httpActiveWorkloads: deps.requestTracker.count(),
      draining: deps.control.isDraining(),
      observedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
      bootEpoch: deps.identity.bootEpoch,
      configRevision: deps.getConfigRevision?.() ?? deps.identity.configRevision,
    });
    deps.metrics?.setGauge("service_activity_observed_active_workloads", {}, activity.activeWorkloads);
    deps.metrics?.record({
      name: "service_activity_observation_seconds",
      labels: { state: activity.state },
      value: Math.max(0, (performance.now() - startedAt) / 1_000),
    });
    if (activity.state !== activityState.current) {
      activityState.current = activity.state;
      deps.onEvent?.({
        name: "service_activity_observed_state_changed",
        labels: { state: activity.state },
        value: activity.activeWorkloads,
      });
    }
    if (activity.retryAfterMs > 0) {
      c.header("retry-after", String(Math.max(1, Math.ceil(activity.retryAfterMs / 1_000))));
    }
    return c.json(activity);
  });

  app.get("/metrics", (c) => c.text(deps.metrics?.render() ?? ""));
  app.get("/openapi.json", (c) => c.json(createOpenApiDocument(deps.identity.version)));
}
