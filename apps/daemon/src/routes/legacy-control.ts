import { Hono } from "hono";
import { prepareRequestSchema, releaseRequestSchema, resolveRequestSchema } from "@larm/core";
import type { ControlPlane } from "../controller";
import { errorBody, readJson } from "../app-http";

export function registerLegacyControlRoutes(app: Hono, options: {
  control: ControlPlane;
  maxBodyBytes: number;
}): void {
  app.post("/prepare", async (c) => {
    const parsed = prepareRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "profile or capabilities is required"), 400);
    }
    const result = await options.control.prepare(parsed.data);
    return c.json(result.body, result.status as 200 | 202 | 400 | 404 | 409 | 503);
  });

  app.post("/release", async (c) => {
    const parsed = releaseRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "leaseId is required"), 400);
    }
    const result = await options.control.release(parsed.data.leaseId);
    return c.json(result.body, result.status as 200 | 404);
  });

  app.post("/resolve", async (c) => {
    const parsed = resolveRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("bad_request", "capability is required"), 400);
    }
    const result = options.control.resolve(parsed.data.capability);
    return c.json(result.body, result.status as 200 | 404 | 503);
  });
}
