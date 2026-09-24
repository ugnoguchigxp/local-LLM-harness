import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ImageArtifactManager } from "./image-artifact-manager";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })));
});

async function fixture(): Promise<{
  root: string;
  id: string;
  bytes: Uint8Array;
  manager: ImageArtifactManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "larm-image-manager-"));
  roots.push(root);
  const id = "image_01";
  const directory = join(root, "2026", "09", id);
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02]);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "image.webp"), bytes);
  await writeFile(join(directory, "metadata.json"), JSON.stringify({
    id,
    createdAt: "2026-09-24T01:02:03.000Z",
    format: "webp",
    mimeType: "image/webp",
    file: "image.webp",
    width: 512,
    height: 512,
    hasAlpha: false,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    model: "Qwen/Qwen-Image-2.1",
    seed: 12345,
    steps: 40,
  }));
  const manager = new ImageArtifactManager(root, {
    maxBytes: 10_000,
    targetBytes: 8_000,
    pruneIntervalMs: 60_000,
  });
  await manager.initialize();
  return { root, id, bytes, manager };
}

describe("ImageArtifactManager", () => {
  test("lists metadata, resolves content, and deletes the complete artifact", async () => {
    const { id, bytes, manager } = await fixture();
    try {
      const listed = await manager.list();
      expect(listed.images).toHaveLength(1);
      expect(listed.images[0]).toMatchObject({
        id,
        format: "webp",
        contentUrl: `/v1/image-artifacts/${id}/content`,
      });
      expect(listed.totalBytes).toBeGreaterThan(bytes.byteLength);
      expect(await manager.get(id)).toEqual(listed.images[0]);
      expect(await manager.content(id)).toMatchObject({
        filename: "image.webp",
        mimeType: "image/webp",
        bytes: bytes.byteLength,
      });
      expect(await manager.delete(id)).toBe(true);
      expect(await manager.get(id)).toBeUndefined();
      expect(await manager.delete(id)).toBe(false);
    } finally {
      manager.close();
    }
  });

  test("does not publish metadata whose id differs from its directory", async () => {
    const { root, manager } = await fixture();
    try {
      const metadataPath = join(root, "2026", "09", "image_01", "metadata.json");
      const mismatched = {
        id: "different_id",
        createdAt: "2026-09-24T01:02:03.000Z",
        format: "webp",
        mimeType: "image/webp",
        file: "image.webp",
        width: 512,
        height: 512,
        hasAlpha: false,
        bytes: 6,
        sha256: "0".repeat(64),
      };
      await writeFile(metadataPath, JSON.stringify(mismatched));
      expect((await manager.list()).images).toEqual([]);
      expect(await manager.get("image_01")).toBeUndefined();
    } finally {
      manager.close();
    }
  });
});
