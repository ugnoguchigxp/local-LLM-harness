import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MusicArtifactRetention } from "./music-artifact-retention";

async function artifact(
  root: string,
  id: string,
  format: "wav" | "mp3" | "opus",
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

test("Opus metadata preserves favorites and uses regular retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-opus-retention-"));
  try {
    const favorite = await artifact(root, "music_opus_favorite", "opus", "2026-09-20T10:00:00.000Z", 100, true);
    const regular = await artifact(root, "music_opus_regular", "opus", "2026-09-24T10:00:00.000Z", 100);
    let now = Date.parse("2026-09-24T12:00:00.000Z");
    const retention = new MusicArtifactRetention({ artifactRoot: root, retentionMs: 86_400_000,
      wavRetentionMs: 3_600_000, maxBytes: 10_000, favoriteMaxBytes: 5_000, now: () => now });
    expect((await retention.list()).every((entry) => entry.format === "opus")).toBe(true);
    expect(await retention.prune()).toEqual([]);
    now += 86_400_000;
    expect(await retention.prune()).toEqual(["music_opus_regular"]);
    expect(await lstat(regular).catch(() => undefined)).toBeUndefined();
    expect((await lstat(favorite)).isDirectory()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("favorites ignore TTL and are not evicted at capacity", async () => {
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

    expect(await retention.prune()).toEqual([]);
    expect((await lstat(oldest)).isDirectory()).toBeTrue();
    await expect(retention.assertCapacity(1, true)).rejects.toThrow("storage is full");
    expect((await lstat(newest)).isDirectory()).toBeTrue();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capacity rejects new data without removing saved tracks", async () => {
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

    expect(await retention.prune()).toEqual([]);
    expect((await lstat(oldest)).isDirectory()).toBeTrue();
    await expect(retention.assertCapacity(1, false)).rejects.toThrow("storage is full");
    expect((await lstat(newest)).isDirectory()).toBeTrue();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("zero retention preserves all completed formats regardless of age", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-persistent-"));
  try {
    for (const format of ["opus", "mp3", "wav"] as const) {
      await artifact(root, `music_${format}`, format, "2020-01-01T00:00:00.000Z", 100);
    }
    const retention = new MusicArtifactRetention({ artifactRoot: root, retentionMs: 0,
      wavRetentionMs: 3_600_000, maxBytes: 10_000, favoriteMaxBytes: 5_000 });
    expect(await retention.prune()).toEqual([]);
    expect(await retention.list()).toHaveLength(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("indefinite storage still cleans abandoned partial saves and protects active jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-partial-"));
  try {
    for (const id of ["music_partial", "music_active"]) {
      const directory = join(root, "2026", "09", id);
      await mkdir(directory, { recursive: true });
      const file = join(directory, "output.opus.tmp");
      await writeFile(file, "partial");
      await utimes(file, new Date("2020-01-01"), new Date("2020-01-01"));
    }
    const retention = new MusicArtifactRetention({ artifactRoot: root, retentionMs: 0,
      wavRetentionMs: 3_600_000, maxBytes: 10_000, favoriteMaxBytes: 5_000 });
    expect(await retention.prune(new Set(["music_active"]))).toEqual(["music_partial"]);
    expect((await retention.list()).map((artifact) => artifact.jobId)).toEqual(["music_active"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
