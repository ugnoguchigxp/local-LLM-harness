import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GENERATED_IMAGE_MAX_BYTES,
  DEFAULT_GENERATED_IMAGE_TARGET_BYTES,
  GeneratedImageArtifactRetention,
  GeneratedImageRetentionError,
} from "./generated-image-retention";

async function artifact(
  root: string,
  id: string,
  createdAt: string,
  imageBytes: number,
): Promise<string> {
  const directory = join(root, "2026", "09", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "image.webp"), new Uint8Array(imageBytes));
  await writeFile(join(directory, "metadata.json"), JSON.stringify({ id, createdAt }));
  return directory;
}

test("generated image retention defaults to a 20 GB pool with an 18 GB target", () => {
  const retention = new GeneratedImageArtifactRetention({ artifactRoot: "/srv/ai/generated-images" });
  expect(retention.maxBytes).toBe(DEFAULT_GENERATED_IMAGE_MAX_BYTES);
  expect(retention.targetBytes).toBe(DEFAULT_GENERATED_IMAGE_TARGET_BYTES);
  expect(retention.maxBytes).toBe(20_000_000_000);
  expect(retention.targetBytes).toBe(18_000_000_000);
});

test("capacity pruning removes the oldest complete artifact directory first", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-image-retention-"));
  try {
    const oldest = await artifact(root, "img_oldest", "2026-09-24T10:00:00.000Z", 600);
    const newest = await artifact(root, "img_newest", "2026-09-24T11:00:00.000Z", 600);
    const artifacts = await new GeneratedImageArtifactRetention({
      artifactRoot: root,
      maxBytes: 10_000,
      targetBytes: 9_000,
    }).list();
    const totalBytes = artifacts.reduce((total, item) => total + item.bytes, 0);
    const retention = new GeneratedImageArtifactRetention({
      artifactRoot: root,
      maxBytes: totalBytes - 1,
      targetBytes: artifacts[1]!.bytes,
    });

    const result = await retention.prune();

    expect(result.removedArtifactIds).toEqual(["img_oldest"]);
    expect(result.remainingArtifacts).toBe(1);
    expect(result.remainingBytes).toBe(artifacts[1]!.bytes);
    expect(await lstat(oldest).catch(() => undefined)).toBeUndefined();
    expect((await lstat(newest)).isDirectory()).toBeTrue();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reservation prunes to the low watermark and preserves protected artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-image-reservation-"));
  try {
    const protectedPath = await artifact(root, "img_active", "2026-09-24T09:00:00.000Z", 500);
    const removablePath = await artifact(root, "img_old", "2026-09-24T10:00:00.000Z", 500);
    const artifacts = await new GeneratedImageArtifactRetention({
      artifactRoot: root,
      maxBytes: 10_000,
      targetBytes: 9_000,
    }).list();
    const activeBytes = artifacts.find((item) => item.artifactId === "img_active")!.bytes;
    const oldBytes = artifacts.find((item) => item.artifactId === "img_old")!.bytes;
    const requiredBytes = 400;
    const retention = new GeneratedImageArtifactRetention({
      artifactRoot: root,
      maxBytes: activeBytes + oldBytes + requiredBytes - 1,
      targetBytes: activeBytes + requiredBytes,
    });

    const result = await retention.prune(requiredBytes, new Set(["img_active"]));

    expect(result.removedArtifactIds).toEqual(["img_old"]);
    expect((await lstat(protectedPath)).isDirectory()).toBeTrue();
    expect(await lstat(removablePath).catch(() => undefined)).toBeUndefined();
    expect(result.remainingBytes + requiredBytes).toBeLessThanOrEqual(retention.maxBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention fails closed when protected artifacts prevent reservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-image-protected-"));
  try {
    await artifact(root, "img_active", "2026-09-24T09:00:00.000Z", 900);
    const [stored] = await new GeneratedImageArtifactRetention({
      artifactRoot: root,
      maxBytes: 10_000,
      targetBytes: 9_000,
    }).list();
    const retention = new GeneratedImageArtifactRetention({
      artifactRoot: root,
      maxBytes: stored!.bytes + 99,
      targetBytes: stored!.bytes,
    });

    await expect(retention.prune(100, new Set(["img_active"]))).rejects.toMatchObject({
      code: "image_pool_capacity_exhausted",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention rejects symlink entries instead of following them", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-image-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "larm-image-outside-"));
  try {
    const directory = await artifact(root, "img_unsafe", "2026-09-24T10:00:00.000Z", 100);
    await symlink(join(outside, "outside.webp"), join(directory, "escape.webp"));
    const retention = new GeneratedImageArtifactRetention({ artifactRoot: root });

    await expect(retention.list()).rejects.toBeInstanceOf(GeneratedImageRetentionError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
