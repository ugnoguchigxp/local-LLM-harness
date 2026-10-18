import { IMAGE_IMPORT_LIMITS, imageImportRequestIdSchema } from "@larm/core";
import { ImageImportError } from "@larm/backends";
import type { ImageImportManager } from "../image-import-manager";
import { readBodyLimited, RequestBodyError } from "../http-body";
import { Hono } from "hono";
import { errorBody } from "../app-http";
import type { ImageArtifactManager } from "../image-artifact-manager";

export function registerImageArtifactRoutes(app: Hono, manager?: ImageArtifactManager, imports?: ImageImportManager, authConfigured = false): void {
  const principal = (authorization?: string) => authorization ?? "";
  app.post("/v1/image-artifacts/imports", async (c) => {
    c.header("cache-control", "private, no-store");
    try {
      if (!authConfigured) throw new ImageImportError("image_import_auth_not_configured", 503);
      if (!imports?.ready) throw new ImageImportError("image_import_unavailable", 503);
      const key = c.req.header("idempotency-key");
      if (!imageImportRequestIdSchema.safeParse(key).success) throw new ImageImportError("invalid_idempotency_key", 400);
      const type = c.req.header("content-type") ?? "";
      if (!/^multipart\/form-data\s*;/i.test(type)) throw new ImageImportError("invalid_image_multipart", 400);
      const bytes = await readBodyLimited(c.req.raw, IMAGE_IMPORT_LIMITS.inputBytes + IMAGE_IMPORT_LIMITS.multipartOverheadBytes, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]));
      let form: Awaited<ReturnType<Response["formData"]>>;
      try { form = await new Response(bytes, { headers: { "content-type": type } }).formData(); }
      catch { throw new ImageImportError("invalid_image_multipart", 400); }
      const entries = [...form.entries()];
      if (entries.length !== 1 || entries[0]?.[0] !== "file" || !(entries[0][1] instanceof File)) throw new ImageImportError("invalid_image_multipart", 400);
      const file = entries[0][1];
      if (!file.size) throw new ImageImportError("invalid_image", 400);
      if (file.size > IMAGE_IMPORT_LIMITS.inputBytes) throw new ImageImportError("image_input_too_large", 413);
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new ImageImportError("unsupported_image_format", 415);
      const result = await imports.import(principal(c.req.header("authorization")), key!, new Uint8Array(await file.arrayBuffer()), file.type);
      c.header("cache-control", "private, no-store");
      c.header("location", result.receipt.statusUrl);
      if (result.status === 202) c.header("retry-after", "1");
      return c.json(result.receipt, result.status as 200 | 201 | 202 | 400 | 413 | 415 | 503 | 507);
    } catch (error) {
      if (error instanceof ImageImportError) {
        if (error.status === 429) c.header("retry-after", "1");
        return c.json(errorBody(error.code, error.message), error.status);
      }
      if (error instanceof RequestBodyError) return c.json(errorBody(error.code, error.message), error.status);
      return c.json(errorBody("invalid_image_upload", "image upload was not completed"), 400);
    }
  });

  app.get("/v1/image-imports/:requestId", async (c) => {
    try {
      if (!authConfigured) throw new ImageImportError("image_import_auth_not_configured", 503);
      if (!imports) throw new ImageImportError("image_import_unavailable", 503);
      if (!imageImportRequestIdSchema.safeParse(c.req.param("requestId")).success) throw new ImageImportError("invalid_image_import_id", 400);
      c.header("cache-control", "private, no-store");
      return c.json(await imports.receipt(principal(c.req.header("authorization")), c.req.param("requestId")));
    } catch (error) {
      if (error instanceof ImageImportError) return c.json(errorBody(error.code, error.message), error.status);
      return c.json(errorBody("image_import_storage_unavailable", "image import storage is unavailable"), 503);
    }
  });

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
    if (!await (imports ? imports.removeArtifact(id) : manager.delete(id))) {
      return c.json(errorBody("not_found", "image artifact not found"), 404);
    }
    return c.json({ id, deleted: true as const });
  });
}
