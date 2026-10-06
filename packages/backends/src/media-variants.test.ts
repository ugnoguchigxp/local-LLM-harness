import { expect, test } from "bun:test";
import { MediaVariantBusyError, MediaVariantManager } from "./media-variants";

test("media requests start on demand, share an idle worker, and exclude the other variant", async () => {
  const calls: string[] = [];
  const manager = new MediaVariantManager({
    script: "unused",
    idleTtlMs: { image: 20, music: 20 },
    run: async (action, variant) => { calls.push(`${action}:${variant}`); },
  });
  try {
    const releaseImage = await manager.acquire("image");
    const releaseConcurrentImage = await manager.acquire("image");
    expect(calls).toEqual(["start:image"]);
    await expect(manager.acquire("music")).rejects.toBeInstanceOf(MediaVariantBusyError);
    releaseConcurrentImage();
    releaseImage();
    const releaseImageAgain = await manager.acquire("image");
    releaseImageAgain();
    expect(calls).toEqual(["start:image", "start:image"]);
    await Bun.sleep(40);
    expect(calls).toEqual(["start:image", "start:image", "stop:image"]);
    const releaseMusic = await manager.acquire("music");
    expect(calls.at(-1)).toBe("start:music");
    releaseMusic();
    await Bun.sleep(40);
    expect(calls.at(-1)).toBe("stop:music");
  } finally {
    manager.close();
  }
});

test("a failed switch revalidates the previous worker before reusing it", async () => {
  const calls: string[] = [];
  const manager = new MediaVariantManager({
    script: "unused",
    idleTtlMs: { image: 60_000, music: 60_000 },
    run: async (action, variant) => {
      calls.push(`${action}:${variant}`);
      if (action === "start" && variant === "music") throw new Error("start failed after stopping image");
    },
  });
  try {
    (await manager.acquire("image"))();
    await expect(manager.acquire("music")).rejects.toThrow("start failed");
    (await manager.acquire("image"))();
    expect(calls).toEqual(["start:image", "start:music", "stop:music", "start:image"]);
  } finally {
    manager.close();
  }
});

test("closing during startup rejects acquisition and prevents subsequent starts", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const calls: string[] = [];
  const manager = new MediaVariantManager({
    script: "unused",
    idleTtlMs: { image: 5, music: 5 },
    run: async (action, variant) => {
      calls.push(`${action}:${variant}`);
      started.resolve();
      await finish.promise;
    },
  });
  const acquisition = manager.acquire("image");
  await started.promise;
  manager.close();
  finish.resolve();
  await expect(acquisition).rejects.toThrow("closed");
  await expect(manager.acquire("music")).rejects.toThrow("closed");
  expect(calls).toEqual(["start:image", "stop:image"]);
});

test("release after close does not schedule an idle stop during shutdown", async () => {
  const calls: string[] = [];
  const manager = new MediaVariantManager({
    script: "unused",
    idleTtlMs: { image: 5, music: 5 },
    run: async (action, variant) => { calls.push(`${action}:${variant}`); },
  });
  const release = await manager.acquire("image");
  manager.close();
  release();
  await Bun.sleep(20);
  expect(calls).toEqual(["start:image", "stop:image"]);
});

test("an aborted queued request does not start a media worker", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const abort = new AbortController();
  const calls: string[] = [];
  const manager = new MediaVariantManager({
    script: "unused",
    idleTtlMs: { image: 60_000, music: 60_000 },
    run: async (action, variant) => {
      calls.push(`${action}:${variant}`);
      started.resolve();
      await finish.promise;
    },
  });
  try {
    const image = manager.acquire("image");
    await started.promise;
    const music = manager.acquire("music", abort.signal);
    abort.abort(new Error("cancelled"));
    finish.resolve();
    (await image)();
    await expect(music).rejects.toThrow("cancelled");
    expect(calls).toEqual(["start:image"]);
  } finally {
    manager.close();
  }
});


test("completion waits for immediate stop and excludes concurrent workers", async () => {
  const stopped = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  const calls: string[] = [];
  const manager = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 },
    run: async (action, variant) => {
      calls.push(`${action}:${variant}`);
      if (action === "stop") { stopping.resolve(); await stopped.promise; }
    },
  });
  const release = await manager.acquire("image");
  await expect(manager.acquire("image")).rejects.toBeInstanceOf(MediaVariantBusyError);
  let finished = false;
  const completion = release().then(() => { finished = true; });
  await stopping.promise;
  expect(finished).toBe(false);
  stopped.resolve();
  await completion;
  expect(calls).toEqual(["start:image", "stop:image"]);
  await release();
  expect(calls).toHaveLength(2);
  await manager.close();
});

test("failed stop quarantines the group without another generation start", async () => {
  const calls: string[] = [];
  const manager = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 },
    run: async (action, variant) => { calls.push(`${action}:${variant}`); if (action === "stop") throw new Error("stop denied"); },
  });
  const release = await manager.acquire("image");
  await expect(release()).rejects.toThrow("worker shutdown failed");
  await expect(manager.acquire("music")).rejects.toThrow("quarantined");
  expect(calls).toEqual(["start:image", "stop:image"]);
  await expect(manager.close()).rejects.toThrow("worker shutdown failed");
});

test("queued music reserves the next slot before a new image", async () => {
  const manager = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 }, run: async () => {} });
  const image = await manager.acquire("image");
  const music = manager.waitForMusic(new AbortController().signal);
  await image();
  await expect(manager.acquire("image")).rejects.toBeInstanceOf(MediaVariantBusyError);
  await (await music)();
  await manager.close();
});
