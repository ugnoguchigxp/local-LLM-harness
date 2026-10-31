import type { Hono } from "hono";
import { MONITORING_VERSION, MonitoringCursorError, monitoringError } from "@larm/core";
import type { MonitoringService } from "../monitoring";

export function registerMonitoringRoutes(app: Hono, deps: { monitoring?: MonitoringService; bootEpoch: string }): void {
  let active = 0;
  app.use("/v1/monitoring/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (active >= 8) { c.header("retry-after", "1"); return c.json(monitoringError(deps.bootEpoch, "rate_limited", null, "retry"), 429); }
    active++;
    try { await next(); } finally { active--; }
  });
  for (const resource of ["snapshot", "events"] as const) app.get(`/v1/monitoring/${resource}`, c => {
    const start = performance.now(), query = new URL(c.req.url).searchParams;
    const permitted = new Set(resource === "events" ? ["contractVersion", "cursor", "limit"] : ["contractVersion"]);
    if (c.req.raw.body !== null || [...query.keys()].some(key => !permitted.has(key) || query.getAll(key).length !== 1)) return c.json(monitoringError(deps.bootEpoch, "invalid_request"), 400);
    if (query.has("contractVersion") && query.get("contractVersion") !== MONITORING_VERSION) return c.json(monitoringError(deps.bootEpoch, "unsupported_monitoring_contract"), 406);
    const rawLimit = query.get("limit");
    if ((rawLimit !== null && !/^(?:[1-9]\d{0,2}|1000)$/.test(rawLimit)) || (query.has("cursor") && !query.get("cursor"))) return c.json(monitoringError(deps.bootEpoch, "invalid_request"), 400);
    try {
      const result = resource === "snapshot" ? deps.monitoring?.snapshot() : deps.monitoring?.eventPage(query.get("cursor") ?? undefined, rawLimit === null ? undefined : Number(rawLimit));
      if (!result || performance.now() - start > 250) { c.header("retry-after", "1"); return c.json(monitoringError(deps.bootEpoch, "monitoring_unavailable", null, "retry"), 503); }
      return c.json(result);
    } catch (e) {
      if (e instanceof MonitoringCursorError) return c.json(monitoringError(deps.bootEpoch, e.code, e.reason, e.status === 400 ? "fix_request" : "restart_window"), e.status);
      c.header("retry-after", "1"); return c.json(monitoringError(deps.bootEpoch, "monitoring_unavailable", null, "retry"), 503);
    }
  });
}
