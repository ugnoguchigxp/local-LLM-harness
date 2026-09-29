import { Hono } from "hono";
import { errorBody } from "../app-http";
import type { ImageArtifactManager } from "../image-artifact-manager";

export function registerImageArtifactRoutes(app: Hono, manager?: ImageArtifactManager): void {
  app.get("/v1/image-artifacts", async (c) => {
    if (!manager) {
      return c.json(errorBody("not_configured", "generated image storage is not configured"), 503);
    }
    c.header("cache-control", "private, no-store");
    return c.json(await manager.list());
  });

  app.get("/v1/image-artifacts/:id/content", async (c) => {
    if (!manager) {
      return c.json(errorBody("not_configured", "generated image storage is not configured"), 503);
    }
    const artifact = await manager.content(c.req.param("id"));
    if (!artifact) return c.json(errorBody("not_found", "image artifact not found"), 404);
    c.header("content-type", artifact.mimeType);
    c.header("content-disposition", `inline; filename="${artifact.filename}"`);
    c.header("content-length", String(artifact.bytes));
    c.header("etag", `"sha256:${artifact.sha256}"`);
    c.header("cache-control", "private, no-store");
    return c.body(Bun.file(artifact.path).stream());
  });

  app.get("/v1/image-artifacts/:id", async (c) => {
    if (!manager) {
      return c.json(errorBody("not_configured", "generated image storage is not configured"), 503);
    }
    const artifact = await manager.get(c.req.param("id"));
    if (!artifact) return c.json(errorBody("not_found", "image artifact not found"), 404);
    c.header("cache-control", "private, no-store");
    return c.json(artifact);
  });

  app.delete("/v1/image-artifacts/:id", async (c) => {
    if (!manager) {
      return c.json(errorBody("not_configured", "generated image storage is not configured"), 503);
    }
    const id = c.req.param("id");
    if (!await manager.delete(id)) {
      return c.json(errorBody("not_found", "image artifact not found"), 404);
    }
    return c.json({ id, deleted: true as const });
  });
}
