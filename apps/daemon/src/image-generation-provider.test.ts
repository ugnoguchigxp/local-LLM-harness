import { expect, test } from "bun:test";
import { MediaVariantManager } from "@larm/backends";
import { ImageGenerationProvider } from "./image-generation-provider";

test("native image startup handles process exits, live listeners and media TIME_WAIT without inference", async () => {
  const child = Bun.spawn(["python3", "-B",
    new URL("../../../deploy/local-node/providers/qwen-image21-turbo-provider.test.py", import.meta.url).pathname,
    "TurboProviderTest.test_occupied_engine_port_is_not_taken_over",
    "TurboProviderTest.test_restart_accepts_closed_engine_connections_in_time_wait",
    "TurboProviderTest.test_audio_time_wait_cannot_break_the_native_reuseport_listener",
    "TurboProviderTest.test_native_exit_including_zero_fails_startup_with_exit_status",
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }).toEqual({ exitCode: 0, output: "" });
});

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

test("arbitrary requested dimensions pass through and return only after worker shutdown", async () => {
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let posts = 0;
  const manager = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 },
    run: async (action) => { if (action === "stop") { stopping.resolve(); await stopped.promise; } },
  });
  const artifact = { id: "image_test", createdAt: new Date().toISOString(), format: "webp", mimeType: "image/webp",
    width: 1200, height: 777, hasAlpha: false, bytes: 10, sha256: "a".repeat(64), contentUrl: "/v1/image-artifacts/image_test/content" };
  const provider = new ImageGenerationProvider("http://image.test", manager, async (_input, init) => {
    posts++;
    expect(JSON.parse(init.body as string)).toMatchObject({ width: 1200, height: 777 });
    return Response.json({ object: "image_generation", status: "succeeded", artifact, durationMs: 1 });
  }, async () => true);
  let completed = false;
  const generation = provider.generate({ prompt: "test", model: "qwen-image-2.1-turbo", width: 1200, height: 777 })
    .then((result) => { completed = true; return result; });
  await stopping.promise;
  expect(completed).toBe(false);
  expect(posts).toBe(1);
  stopped.resolve();
  const result = await generation;
  expect(result.artifacts).toEqual([result.artifact]);
  await manager.close();
});

test("invalid Turbo requests including dimension bounds are rejected before starting a worker", async () => {
  const { Hono } = await import("hono");
  const { registerImageGenerationRoutes } = await import("./routes/image-generations");
  const calls: string[] = [];
  const manager = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 },
    run: async (action, variant) => { calls.push(`${action}:${variant}`); },
  });
  const provider = new ImageGenerationProvider("http://image.test", manager, async () => {
    throw new Error("invalid input must not reach inference");
  });
  const app = new Hono(); registerImageGenerationRoutes(app, provider);
  try {
    for (const invalid of [{ model: "qwen-image-2.1" }, { steps: 40 }, { width: 99 }, { width: 1281 },
      { height: 99 }, { height: 1281 }, { width: 100.5 }, { height: true }]) {
      const result = await app.request("/v1/images/generations", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "A portrait", ...invalid }) });
      expect(result.status).toBe(400);
    }
    expect(calls).toEqual([]);
  } finally { await manager.close(); }
});

test("a worker exit returns 503, logs a terminal event without input, and allows a later request", async () => {
  const { Hono } = await import("hono");
  const { registerImageGenerationRoutes } = await import("./routes/image-generations");
  const calls: string[] = [];
  const events: unknown[] = [];
  let fail = true;
  let submitted = 0;
  const manager = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 },
    run: async (action, variant) => {
      calls.push(`${action}:${variant}`);
      if (action === "start" && fail) throw new Error("image worker exited before becoming healthy (state=failed)");
    },
  });
  const provider = new ImageGenerationProvider("http://image.test", manager, async () => {
    submitted++;
    throw new Error("upstream failed");
  });
  const app = new Hono(); registerImageGenerationRoutes(app, provider, event => events.push(event));
  const request = () => app.request("/v1/images/generations", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "private-input-marker" }) });
  try {
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "image_generation_failed" } });
    expect(submitted).toBe(0);
    expect(calls).toEqual(["start:image", "stop:image"]);
    expect(manager.isOccupied()).toBe(false);
    expect(events).toMatchObject([
      { name: "image_generation_started" },
      { name: "image_generation_completed", labels: { status: "503", outcome: "image_generation_failed" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-input-marker");
    fail = false;
    expect((await request()).status).toBe(503);
    expect(submitted).toBe(1);
    expect(manager.isOccupied()).toBe(false);
  } finally { await manager.close(); }
});

test("image deadline errors return structured 504 after cleanup", async () => {
  const { Hono } = await import("hono");
  const { registerImageGenerationRoutes } = await import("./routes/image-generations");
  const manager = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 }, run: async () => {} });
  const provider = new ImageGenerationProvider("http://image.test", manager, async () => {
    throw new DOMException("deadline", "TimeoutError");
  });
  const app = new Hono(); registerImageGenerationRoutes(app, provider);
  try {
    const response = await app.request("/v1/images/generations", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "test" }) });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: "image_generation_timeout" } });
    expect(manager.isOccupied()).toBe(false);
  } finally { await manager.close(); }
});
