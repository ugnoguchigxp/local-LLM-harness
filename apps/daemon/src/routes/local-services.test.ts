import { expect, test } from "bun:test";
import { Hono } from "hono";
import { ZodError } from "zod";
import { registerLocalServiceRoutes } from "./local-services";
import { LocalServiceError, type LocalServiceManager } from "../local-service-manager";

test("service API enforces its own scope, rejects runtime overrides and separates management", async () => {
  let calls = 0;
  const manager = { list: () => [{ id: "docling-desk" }, { id: "private" }],
    ensure: async (_id: string, _p: string, _key: string, raw: unknown) => {
      const { localServiceLeaseRequestSchema } = await import("@larm/core"); localServiceLeaseRequestSchema.parse(raw); calls++; return { status: "starting" };
    }, stop: async () => { calls++; },
  } as unknown as LocalServiceManager;
  const app = new Hono();
  app.onError((err, c) => c.json({ error: err.message }, err instanceof LocalServiceError ? err.status : err instanceof ZodError ? 400 : 500));
  registerLocalServiceRoutes(app, { manager, principals: [{ id: "a", token: "x".repeat(40), services: ["docling-desk"] }], managementToken: "y".repeat(40), maxBodyBytes: 1000 });
  const headers = { authorization: `Bearer ${"x".repeat(40)}`, "idempotency-key": "one", "content-type": "application/json" };
  expect((await app.request("/v1/local-services")).status).toBe(401);
  expect(((await (await app.request("/v1/local-services", { headers })).json()) as { services: unknown[] }).services).toEqual([{ id: "docling-desk" }]);
  expect((await app.request("/v1/local-services/private/leases", { method: "POST", headers, body: "{}" })).status).toBe(403);
  expect((await app.request("/v1/local-services/docling-desk/leases", { method: "POST", headers, body: '{"command":"sh"}' })).status).toBe(400);
  expect((await app.request("/v1/local-services/docling-desk/leases", { method: "POST", headers, body: "{}" })).status).toBe(202);
  expect((await app.request("/v1/management/local-services/docling-desk/stop", { method: "POST", headers, body: "{}" })).status).toBe(403);
  expect(calls).toBe(1);
});
