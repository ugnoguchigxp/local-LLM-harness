import { MediaVariantBusyError, type MediaVariantManager } from "@larm/backends";
import type { ImageGenerationProvider } from "./image-generation-provider";
import type { MeshGenerationRequest, MeshJob } from "@larm/core";
import { MeshError } from "./mesh-store";

export interface MeshProvider {
  image(input: MeshGenerationRequest, signal: AbortSignal): Promise<string>;
  generate(id: string, seed: number, signal: AbortSignal, stage: (stage: MeshJob["stage"]) => Promise<void>): Promise<void>;
}
export class OnDemandMeshProvider implements MeshProvider {
  constructor(private readonly variants: MediaVariantManager, private readonly endpoint: string,
    private readonly imageProvider?: ImageGenerationProvider) {}
  async image(input: MeshGenerationRequest, signal: AbortSignal) {
    if (input.source.type === "image-artifact") return input.source.id;
    if (!this.imageProvider) throw new MeshError("image_unavailable", 503, "Qwen image generation is not configured");
    const deadline = Date.now() + 600_000;
    while (true) {
      signal.throwIfAborted();
      try {
        const result = await this.imageProvider.generate({ model: input.source.imageModel, prompt: input.source.prompt,
          width: 768, height: 768, steps: 8, seed: input.source.imageSeed, format: "png" }, signal);
        return result.artifact.id;
      } catch (error) {
        if (!(error instanceof MediaVariantBusyError)) throw error;
        if (Date.now() >= deadline) throw new MeshError("queue_timeout", 503, "image capacity wait expired");
        await Bun.sleep(100);
      }
    }
  }
  async generate(id: string, seed: number, signal: AbortSignal, stage: (stage: MeshJob["stage"]) => Promise<void>) {
    await stage("waiting_gpu");
    const release = await this.variants.waitFor("mesh", signal);
    let poll: ReturnType<typeof setInterval> | undefined, polling = false, acceptingProgress = true, lastStage = "";
    try {
      poll = setInterval(() => {
        if (polling || signal.aborted) return; polling = true;
        void fetch(new URL("/status", this.endpoint), { signal, redirect: "error" }).then((r) => r.json()).then(async (s: any) => {
          if (acceptingProgress && s.jobId === id && s.stage !== lastStage && ["background", "mesh"].includes(s.stage)) { lastStage = s.stage; await stage(s.stage); }
        }).catch(() => {}).finally(() => { polling = false; });
      }, 1000);
      const response = await fetch(new URL("/generate", this.endpoint), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: id, seed }), signal, redirect: "error" });
      if (!response.ok) { await response.body?.cancel(); throw new MeshError("generation_failed", 503, "3D worker failed; inspect restricted worker logs"); }
      await response.body?.cancel();
    } finally {
      acceptingProgress = false;
      if (poll) clearInterval(poll);
      try { await stage("stopping"); }
      finally { try { await release(); } catch { throw new MeshError("worker_stop_failed", 503, "3D worker shutdown failed; result remains private for recovery"); } }
    }
  }
}
