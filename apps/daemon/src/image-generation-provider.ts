import type { MediaVariantManager } from "@larm/backends";
import { imageGenerationRequestSchema, imageGenerationResponseSchema, type ImageGenerationRequest } from "@larm/core";
import { withAbort } from "./http-body";

async function readWorkerJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("image worker returned an empty response");
  const limit = 64 * 1024;
  try {
    if (Number(response.headers.get("content-length")) > limit) throw new Error("image worker response exceeds size limit");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await withAbort(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error("image worker response exceeds size limit");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

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
        if (response.status === 503 && response.headers.get("content-type")?.includes("application/json")) {
          let error: unknown;
          try { error = await readWorkerJson(response, signal); }
          catch { signal.throwIfAborted(); }
          if (typeof error === "object" && error !== null && "error" in error && error.error === "image_model_unavailable") {
            throw new ImageModelUnavailableError();
          }
        } else { await response.body?.cancel(); }
        throw new Error(`image provider returned HTTP ${response.status}`);
      }
      const result = imageGenerationResponseSchema.parse(await readWorkerJson(response, signal));
      const image = result.artifact;
      const sources = flux ? ["leejet/flux-3-image-klein-GGUF", "black-forest-labs/flux-3-image-klein"]
        : ["AtomicChat/Qwen-Image-2.1-Turbo-GGUF"];
      if (!image.model || !sources.includes(image.model) || !image.modelRevision || !/^[a-f0-9]{40}$/.test(image.modelRevision)
        || image.steps !== (flux ? 16 : 8) || image.width !== (input.width ?? 512) || image.height !== (input.height ?? 512)
        || image.format !== (input.format ?? "webp") || image.seed !== (input.seed ?? 0)
        || image.contentUrl !== `/v1/image-artifacts/${image.id}/content`) {
        throw new Error("generated image metadata does not match the requested model or output parameters");
      }
      if (this.verifyArtifact && !await this.verifyArtifact(result.artifact.id)) throw new Error("generated image artifact is not readable by Control");
      artifact = result.artifact;
      return { ...result, artifacts: [result.artifact] };
    } finally {
      try { await release(); }
      catch (error) { throw new ImageWorkerStopError(artifact, error); }
    }
  }
}
