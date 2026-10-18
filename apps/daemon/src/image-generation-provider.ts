import type { MediaVariantManager } from "@larm/backends";
import { imageGenerationResponseSchema, type ImageGenerationRequest } from "@larm/core";

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
    private readonly onMonitoringTransition?: (id: string, state: string, reason?: string) => void) {}

  async generate(input: ImageGenerationRequest, signal?: AbortSignal) {
    const monitoringId = `image-${crypto.randomUUID()}`;
    const observe = (state: string, reason?: string) => { try { this.onMonitoringTransition?.(monitoringId, state, reason); } catch { /* Observation only. */ } };
    const finish = this.beginWorkload?.();
    observe("started");
    try { const result = await this.generateTracked(input, signal); observe(signal?.aborted ? "cancelled" : "completed"); return result; }
    catch (e) { observe(signal?.aborted ? "cancelled" : "failed", "generation_failed"); throw e; }
    finally { finish?.(); }
  }

  private async generateTracked(input: ImageGenerationRequest, signal?: AbortSignal) {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(900_000)]);
    const release = await this.variants.acquire("image", signal);
    let artifact: unknown;
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
