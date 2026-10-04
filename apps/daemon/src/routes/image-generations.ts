import type { Hono } from "hono";
import { MediaVariantBusyError } from "@larm/backends";
import { imageGenerationRequestSchema } from "@larm/core";
import { errorBody, readJson } from "../app-http";
import type { ImageGenerationProvider } from "../image-generation-provider";

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
      throw error;
    }
  });
}
