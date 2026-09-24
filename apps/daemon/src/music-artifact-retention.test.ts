import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MusicArtifactRetention } from "./music-artifact-retention";

async function artifact(
  root: string,
  id: string,
  format: "wav" | "mp3",
  createdAt: string,
  bytes: number,
  favorite = false,
): Promise<string> {
  const directory = join(root, "2026", "09", id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `output.${format}`), new Uint8Array(bytes));
  await writeFile(join(directory, "metadata.json"), JSON.stringify({
    id,
    format,
    createdAt,
    favorite,
    ...(favorite ? { favoritedAt: createdAt } : {}),
  }));
  return directory;
}

test("retention removes WAV sooner while retaining MP3", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-retention-"));
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  try {
    const wav = await artifact(root, "music_old_wav", "wav", "2026-09-24T10:00:00.000Z", 100);
    const mp3 = await artifact(root, "music_old_mp3", "mp3", "2026-09-24T10:00:00.000Z", 100);
    const retention = new MusicArtifactRetention({
      artifactRoot: root,
      retentionMs: 24 * 60 * 60 * 1_000,
      wavRetentionMs: 60 * 60 * 1_000,
      maxBytes: 10_000,
      favoriteMaxBytes: 5_000,
      now: () => now,
    });

    expect(await retention.prune()).toEqual(["music_old_wav"]);
    expect(await lstat(wav).catch(() => undefined)).toBeUndefined();
    expect((await lstat(mp3)).isDirectory()).toBeTrue();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("favorites ignore TTL but stay inside their reserved capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-favorites-"));
  try {
    const oldest = await artifact(root, "music_favorite_old", "mp3", "2026-09-20T10:00:00.000Z", 800, true);
    const newest = await artifact(root, "music_favorite_new", "mp3", "2026-09-20T11:00:00.000Z", 800, true);
    const newestBytes = 800 + (await readFile(join(newest, "metadata.json"))).byteLength;
    const retention = new MusicArtifactRetention({
      artifactRoot: root,
      retentionMs: 60 * 60 * 1_000,
      wavRetentionMs: 60 * 60 * 1_000,
      maxBytes: 10_000,
      favoriteMaxBytes: newestBytes,
      now: () => Date.parse("2026-09-24T12:00:00.000Z"),
    });

    expect(await retention.prune()).toEqual(["music_favorite_old"]);
    expect(await lstat(oldest).catch(() => undefined)).toBeUndefined();
    expect((await lstat(newest)).isDirectory()).toBeTrue();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capacity pruning removes oldest artifacts first", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-capacity-"));
  try {
    const oldest = await artifact(root, "music_oldest", "mp3", "2026-09-24T10:00:00.000Z", 800);
    const newest = await artifact(root, "music_newest", "mp3", "2026-09-24T11:00:00.000Z", 800);
    const metadataBytes = (await readFile(join(oldest, "metadata.json"))).byteLength
      + (await readFile(join(newest, "metadata.json"))).byteLength;
    const retention = new MusicArtifactRetention({
      artifactRoot: root,
      retentionMs: 24 * 60 * 60 * 1_000,
      wavRetentionMs: 60 * 60 * 1_000,
      maxBytes: 800 + Math.ceil(metadataBytes / 2),
      favoriteMaxBytes: 0,
      now: () => Date.parse("2026-09-24T12:00:00.000Z"),
    });

    expect(await retention.prune()).toEqual(["music_oldest"]);
    expect(await lstat(oldest).catch(() => undefined)).toBeUndefined();
    expect((await lstat(newest)).isDirectory()).toBeTrue();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
