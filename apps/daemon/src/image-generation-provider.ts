import type { MediaVariantManager } from "@larm/backends";
import { imageGenerationResponseSchema, type ImageGenerationRequest } from "@larm/core";

export class ImageGenerationProvider {
  constructor(private readonly endpoint: string, private readonly variants: MediaVariantManager,
    private readonly fetchImpl: (input: URL, init: RequestInit) => Promise<Response> = fetch) {}

  async generate(input: ImageGenerationRequest, signal?: AbortSignal) {
    const release = await this.variants.acquire("image", signal);
    try {
      signal?.throwIfAborted();
      const response = await this.fetchImpl(new URL("/v1/generations", this.endpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`image provider returned HTTP ${response.status}`);
      }
      return imageGenerationResponseSchema.parse(await response.json());
    } finally {
      release();
    }
  }
}
