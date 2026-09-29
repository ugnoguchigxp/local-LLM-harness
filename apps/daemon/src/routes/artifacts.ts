import { Hono } from "hono";
import type { ArtifactManager } from "../artifact-manager";
import { errorBody } from "../app-http";

export function registerArtifactRoutes(app: Hono, manager?: ArtifactManager): void {
  app.get("/v1/artifact-operations/:id", (c) => {
    if (!manager) {
      return c.json(errorBody("not_configured", "artifact management is not configured"), 503);
    }
    const operation = manager.getOperation(c.req.param("id"));
    if (!operation) return c.json(errorBody("not_found", "artifact operation not found"), 404);
    return c.json(operation);
  });

  app.post("/v1/artifacts/:id/stage", async (c) => {
    if (!manager) {
      return c.json(errorBody("not_configured", "artifact management is not configured"), 503);
    }
    return c.json(await manager.stage(c.req.param("id")), 202);
  });
}
