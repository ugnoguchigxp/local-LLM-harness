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

test("image compatibility response is returned only after worker shutdown", async () => {
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let posts = 0;
  const manager = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 },
    run: async (action) => { if (action === "stop") { stopping.resolve(); await stopped.promise; } },
  });
  const artifact = { id: "image_test", createdAt: new Date().toISOString(), format: "webp", mimeType: "image/webp",
    width: 512, height: 512, hasAlpha: false, bytes: 10, sha256: "a".repeat(64), contentUrl: "/v1/image-artifacts/image_test/content" };
  const provider = new ImageGenerationProvider("http://image.test", manager, async () => {
    posts++;
    return Response.json({ object: "image_generation", status: "succeeded", artifact, durationMs: 1 });
  }, async () => true);
  let completed = false;
  const generation = provider.generate({ prompt: "test", model: "qwen-image-2.1" }).then((result) => { completed = true; return result; });
  await stopping.promise;
  expect(completed).toBe(false);
  expect(posts).toBe(1);
  stopped.resolve();
  const result = await generation;
  expect(result.artifacts).toEqual([result.artifact]);
  await manager.close();
});
