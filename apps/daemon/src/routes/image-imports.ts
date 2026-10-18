import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { IMAGE_IMPORT_MAX_BODY_BYTES, imageImportRequestIdSchema } from "@larm/core";
import { authenticatedBearerKinds } from "../app-auth";
import { errorBody } from "../app-http";
import { readBodyLimited, RequestBodyError } from "../http-body";
import type { ImageArtifactManager } from "../image-artifact-manager";
import { ImageImportError } from "../image-import-validation";
import { parseImageMultipart } from "../image-import-multipart";

export function registerImageImportRoutes(app: Hono, manager?: ImageArtifactManager): void {
  function principal(c: Context): string | Response {
    // Fail closed even when the daemon is configured for anonymous development.
    if (!authenticatedBearerKinds.has(c.req.raw)) {
      return c.json(errorBody("unauthorized", "valid Control bearer token required"), 401);
    }
    return createHash("sha256").update(c.req.header("authorization")!).digest("hex");
  }
  function failure(c: Context, error: unknown): Response {
    if (error instanceof ImageImportError || error instanceof RequestBodyError) {
      return c.json(errorBody(error.code, error.message), error.status);
    }
    // Never log multipart bodies, filenames, decoder diagnostics, or credentials.
    return c.json(errorBody("image_storage_failed", "image import could not be completed; query the request UUID"), 500);
  }
  app.post("/v1/image-artifacts/imports", async (c) => {
    c.header("cache-control", "private, no-store");
    const subject = principal(c);
    if (subject instanceof Response) return subject;
    if (!manager) return c.json(errorBody("not_configured", "image storage is not configured"), 503);
    const parsed = imageImportRequestIdSchema.safeParse(c.req.header("idempotency-key"));
    if (!parsed.success) return c.json(errorBody("invalid_idempotency_key", "Idempotency-Key must be a UUID"), 400);
    const requestId = parsed.data.toLowerCase();
    c.header("location", `/v1/image-imports/${requestId}`);
    const type = c.req.header("content-type") ?? "";
    if (!/^multipart\/form-data\s*;/i.test(type)) {
      return c.json(errorBody("invalid_multipart", "multipart/form-data with one file field is required"), 400);
    }
    if (![undefined, "identity"].includes(c.req.header("content-encoding")?.toLowerCase())) {
      return c.json(errorBody("unsupported_content_encoding", "image imports accept identity content encoding only"), 415);
    }
    try {
      const body = await readBodyLimited(c.req.raw, IMAGE_IMPORT_MAX_BODY_BYTES, c.req.raw.signal);
      const file = await parseImageMultipart(body, type);
      const artifact = await manager.importImage(subject, requestId, file.bytes, file.mimeType);
      return c.json(artifact, 200);
    } catch (error) { return failure(c, error); }
  });

  app.get("/v1/image-imports/:requestId", async (c) => {
    c.header("cache-control", "private, no-store");
    const subject = principal(c);
    if (subject instanceof Response) return subject;
    if (!manager) return c.json(errorBody("not_configured", "image storage is not configured"), 503);
    const parsed = imageImportRequestIdSchema.safeParse(c.req.param("requestId"));
    if (!parsed.success) return c.json(errorBody("invalid_idempotency_key", "requestId must be a UUID"), 400);
    try {
      const result = await manager.getImport(subject, parsed.data.toLowerCase());
      return result ? c.json(result) : c.json(errorBody("image_import_not_found", "no receipt exists for this principal and UUID; retry the same content and key"), 404);
    } catch (error) { return failure(c, error); }
  });
}
