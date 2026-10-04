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
    await expect(manager.acquire("music")).rejects.toBeInstanceOf(MediaVariantBusyError);
    releaseImage();
    const releaseImageAgain = await manager.acquire("image");
    releaseImageAgain();
    expect(calls).toEqual(["start:image"]);
    await Bun.sleep(40);
    expect(calls).toEqual(["start:image", "stop:image"]);
    const releaseMusic = await manager.acquire("music");
    expect(calls.at(-1)).toBe("start:music");
    releaseMusic();
    await Bun.sleep(40);
    expect(calls.at(-1)).toBe("stop:music");
  } finally {
    manager.close();
  }
});
