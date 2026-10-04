import { expect, test } from "bun:test";
import { MediaVariantManager } from "@larm/backends";
import { ImageGenerationProvider } from "./image-generation-provider";

test("cancellation during cold startup does not submit an image and releases the media reservation", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const abort = new AbortController();
  let submitted = false;
  const manager = new MediaVariantManager({
    script: "unused", idleTtlMs: { image: 60_000, music: 60_000 },
    run: async () => { started.resolve(); await finish.promise; },
  });
  const provider = new ImageGenerationProvider("http://image.test", manager, (async () => {
    submitted = true;
    return new Response();
  }));
  try {
    const generation = provider.generate({ prompt: "test" }, abort.signal);
    await started.promise;
    abort.abort(new Error("cancelled"));
    finish.resolve();
    await expect(generation).rejects.toThrow("cancelled");
    expect(submitted).toBe(false);
    (await manager.acquire("music"))();
  } finally {
    manager.close();
  }
});

test("upstream errors cancel the response body and release the media reservation", async () => {
  let cancelled = false;
  const manager = new MediaVariantManager({
    script: "unused", idleTtlMs: { image: 60_000, music: 60_000 }, run: async () => {},
  });
  const provider = new ImageGenerationProvider("http://image.test", manager, (async () => new Response(
    new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 },
  )));
  try {
    await expect(provider.generate({ prompt: "test" })).rejects.toThrow("HTTP 503");
    expect(cancelled).toBe(true);
    (await manager.acquire("music"))();
  } finally {
    manager.close();
  }
});
