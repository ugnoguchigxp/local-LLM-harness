import type { Hono } from "hono";
import { MediaVariantBusyError } from "@larm/backends";
import { imageGenerationRequestSchema } from "@larm/core";
import { errorBody, readJson } from "../app-http";
import { ImageWorkerStopError, type ImageGenerationProvider } from "../image-generation-provider";

export function registerImageGenerationRoutes(app: Hono, provider: ImageGenerationProvider | undefined): void {
  app.post("/v1/images/generations", async (c) => {
    if (!provider) return c.json(errorBody("not_configured", "image generation is not configured"), 503);
    const request = imageGenerationRequestSchema.safeParse(await readJson(c, 32 * 1024));
    if (!request.success) return c.json(errorBody("invalid_image_request", "invalid image generation request"), 400);
    try {
      const result = await provider.generate(request.data, c.req.raw.signal);
      return c.json(result);
    } catch (error) {
      if (error instanceof MediaVariantBusyError) {
        return c.json(errorBody("media_variant_busy", error.message), 409);
      }
      if (error instanceof ImageWorkerStopError) {
        return c.json({ ...errorBody("worker_stop_failed", error.message), ...(error.artifact ? { artifacts: [error.artifact] } : {}) }, 503);
      }
      return c.json(errorBody("image_generation_failed", error instanceof Error ? error.message : "image generation failed"), 503);
    }
  });
}
