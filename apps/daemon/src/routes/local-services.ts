import { z } from "zod";
import type { Hono } from "hono";
import { localServiceIdSchema } from "@larm/core";
import { LocalServiceError, type LocalServiceManager } from "../local-service-manager";
import { secretMatches } from "../app-auth";
import { readJson } from "../app-http";

export type LocalServicePrincipal = { id: string; token: string; services: string[] };
export function registerLocalServiceRoutes(app: Hono, options: {
  manager?: LocalServiceManager; principals?: LocalServicePrincipal[]; managementToken?: string; maxBodyBytes: number;
}) {
  const prefixes = ["/v1/local-services", "/v1/local-service-leases", "/v1/management/local-services"];
  for (const prefix of prefixes) app.use(`${prefix}/*`, async (c, next) => {
    if (!options.manager) return c.json({ error: { code: "local_services_disabled" } }, 503);
    c.header("cache-control", "no-store");
    await next();
  });
  const caller = (header: string | undefined) => {
    const p = options.principals?.find(p => secretMatches(header, `Bearer ${p.token}`));
    if (!p) throw new LocalServiceError("unauthorized", 401);
    return p;
  };
  const allowed = (p: LocalServicePrincipal, id: string) => {
    localServiceIdSchema.parse(id);
    if (!p.services.includes(id)) throw new LocalServiceError("service_not_allowed", 403);
  };
  const manager = () => { if (!options.manager) throw new LocalServiceError("local_services_disabled", 503); return options.manager; };
  app.get("/v1/local-services", c => {
    const p = caller(c.req.header("authorization"));
    return c.json({ services: manager().list().filter(s => p.services.includes(s.id)) });
  });
  app.get("/v1/local-services/:id", c => {
    const p = caller(c.req.header("authorization")), id = c.req.param("id"); allowed(p, id);
    return c.json(manager().status(id));
  });
  app.post("/v1/local-services/:id/leases", async c => {
    const p = caller(c.req.header("authorization")), id = c.req.param("id"); allowed(p, id);
    const lease = await manager().ensure(id, p.id, c.req.header("idempotency-key") ?? "", await readJson(c, options.maxBodyBytes));
    return c.json(lease, lease.status === "ready" ? 201 : 202);
  });
  app.get("/v1/local-service-leases/:id", c => c.json(manager().get(c.req.param("id"), caller(c.req.header("authorization")).id)));
  app.post("/v1/local-service-leases/:id/renew", async c => c.json(manager().renew(c.req.param("id"), caller(c.req.header("authorization")).id, await readJson(c, options.maxBodyBytes))));
  app.delete("/v1/local-service-leases/:id", c => { manager().release(c.req.param("id"), caller(c.req.header("authorization")).id); return c.body(null, 204); });
  app.post("/v1/management/local-services/:id/stop", async c => {
    if (!options.managementToken || !secretMatches(c.req.header("authorization"), `Bearer ${options.managementToken}`)) throw new LocalServiceError("management_required", 403);
    // Force interruption is deliberately unavailable to consumer/LLM APIs.
    z.object({}).strict().parse(await readJson(c, options.maxBodyBytes));
    await manager().stop(c.req.param("id")); return c.body(null, 204);
  });
}
