import type { Hono } from "hono";
import { MediaVariantBusyError } from "@larm/backends";
import { imageGenerationRequestSchema } from "@larm/core";
import { errorBody, readJson } from "../app-http";
import { ImageModelUnavailableError, ImageWorkerStopError, type ImageGenerationProvider } from "../image-generation-provider";
import type { ControlEvent } from "../controller";

export function registerImageGenerationRoutes(app: Hono, provider: ImageGenerationProvider | undefined,
  onEvent?: (event: ControlEvent) => void): void {
  app.post("/v1/images/generations", async (c) => {
    if (!provider) return c.json(errorBody("not_configured", "image generation is not configured"), 503);
    const request = imageGenerationRequestSchema.safeParse(await readJson(c, 32 * 1024));
    if (!request.success) return c.json(errorBody("invalid_image_request", "invalid image generation request"), 400);
    const id = `image_req_${crypto.randomUUID()}`;
    const model = request.data.model ?? "qwen-image-2.1-turbo";
    const started = Date.now();
    let status = 503;
    let outcome = "image_generation_failed";
    onEvent?.({ name: "image_generation_started", labels: { request: id, model } });
    try {
      const result = await provider.generate(request.data, c.req.raw.signal);
      status = 200;
      outcome = "succeeded";
      return c.json(result);
    } catch (error) {
      if (error instanceof ImageModelUnavailableError) {
        outcome = "image_model_unavailable";
        return c.json(errorBody(outcome, error.message), 503);
      }
      if (error instanceof MediaVariantBusyError) {
        status = 409;
        outcome = "media_variant_busy";
        return c.json(errorBody("media_variant_busy", error.message), 409);
      }
      if (error instanceof ImageWorkerStopError) {
        outcome = "worker_stop_failed";
        return c.json({ ...errorBody("worker_stop_failed", error.message), ...(error.artifact ? { artifacts: [error.artifact] } : {}) }, 503);
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        status = 504;
        outcome = "image_generation_timeout";
        return c.json(errorBody(outcome, "image generation deadline exceeded"), 504);
      }
      return c.json(errorBody("image_generation_failed", error instanceof Error ? error.message : "image generation failed"), 503);
    } finally {
      onEvent?.({ name: "image_generation_completed", labels: {
        request: id, model, status: String(status), outcome, elapsedMs: String(Date.now() - started),
      } });
    }
  });
}
