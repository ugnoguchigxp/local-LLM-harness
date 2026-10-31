import type { MediaVariantManager } from "@larm/backends";
import { imageGenerationRequestSchema, imageGenerationResponseSchema, type ImageGenerationRequest } from "@larm/core";

export class ImageModelUnavailableError extends Error {
  constructor() { super("flux-3-image-klein is not configured on this node"); }
}

export class ImageWorkerStopError extends Error {
  constructor(readonly artifact: unknown, cause: unknown) {
    super("image artifact saved but model worker shutdown failed", { cause });
  }
}

export class ImageGenerationProvider {
  constructor(private readonly endpoint: string, private readonly variants: MediaVariantManager,
    private readonly fetchImpl: (input: URL, init: RequestInit) => Promise<Response> = fetch,
    private readonly verifyArtifact?: (id: string) => Promise<boolean>,
    private readonly beginWorkload?: () => () => void,
    private readonly flux3Endpoint?: string,
    private readonly flux3Variant: "image" | "image-flux3" = "image-flux3") {}

  async generate(input: ImageGenerationRequest, signal?: AbortSignal) {
    input = imageGenerationRequestSchema.parse(input);
    if (input.model === "flux-3-image-klein" && !this.flux3Endpoint) throw new ImageModelUnavailableError();
    const finish = this.beginWorkload?.();
    try { return await this.generateTracked(input, signal); }
    finally { finish?.(); }
  }

  private async generateTracked(input: ImageGenerationRequest, signal?: AbortSignal) {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(900_000)]);
    const flux = input.model === "flux-3-image-klein";
    const endpoint = flux ? this.flux3Endpoint! : this.endpoint;
    const release = await this.variants.acquire(flux ? this.flux3Variant : "image", signal);
    let artifact: unknown;
    try {
      signal?.throwIfAborted();
      const response = await this.fetchImpl(new URL("/v1/generations", endpoint), {
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
      const result = imageGenerationResponseSchema.parse(await response.json());
      if (this.verifyArtifact && !await this.verifyArtifact(result.artifact.id)) throw new Error("generated image artifact is not readable by Control");
      artifact = result.artifact;
      return { ...result, artifacts: [result.artifact] };
    } finally {
      try { await release(); }
      catch (error) { throw new ImageWorkerStopError(artifact, error); }
    }
  }
}
