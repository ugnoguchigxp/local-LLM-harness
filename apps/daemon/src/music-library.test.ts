import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { musicFavoriteListSchema, musicGenerationRequestSchema, musicTrackListSchema, musicTrackSchema, type MusicProvider } from "@larm/core";
import { AceStepMusicProvider, MusicGenerationManager } from "./music-manager";
import { registerMusicRoutes } from "./routes/music";

function provider(): MusicProvider {
  const upstream = new AceStepMusicProvider({ endpoint: "http://unused" });
  return { id: upstream.id, capabilities: upstream.capabilities,
    load: async () => {}, unload: async () => {}, health: async () => ({ available: true }),
    generate: async (request) => ({ model: "acestep-v15-turbo", format: request.outputFormat,
      audio: new TextEncoder().encode("OggS"), durationSeconds: request.durationSeconds, generationTimeMs: 1 }),
  };
}

async function finished(manager: MusicGenerationManager, id: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const job = manager.get(id)!;
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await Bun.sleep(2);
  }
  throw new Error("music job did not terminate");
}

function routes(manager: MusicGenerationManager) {
  const app = new Hono();
  registerMusicRoutes(app, { manager, maxBodyBytes: 1_000_000 });
  return app;
}

test("library lists and searches old and new tracks, favorites and playback survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-library-"));
  let sequence = 0, now = Date.parse("2020-01-01T00:00:00.000Z");
  const manager = new MusicGenerationManager(provider(), { artifactRoot: root, now: () => now, random: () => String(sequence++) });
  const recovered = new MusicGenerationManager(provider(), { artifactRoot: root, now: () => Date.parse("2030-01-01T00:00:00.000Z") });
  try {
    const old = manager.create(musicGenerationRequestSchema.parse({ prompt: "Old piano melody" }));
    expect((await finished(manager, old.jobId)).status).toBe("completed");
    now += 1000;
    const named = manager.create(musicGenerationRequestSchema.parse({ title: "星の夜", tags: ["ピアノ", "Ambient"], prompt: "gentle nocturnal music", lyrics: "星の光" }));
    expect((await finished(manager, named.jobId)).status).toBe("completed");
    await manager.favorite(named.jobId);
    const app = routes(manager);
    const list = musicTrackListSchema.parse(await (await app.request("/v1/music/tracks?limit=1")).json());
    expect(list.total).toBe(2);
    expect(list.tracks[0]?.id).toBe(named.jobId);
    const next = musicTrackListSchema.parse(await (await app.request(`/v1/music/tracks?limit=1&cursor=${encodeURIComponent(list.nextCursor!)}`)).json());
    expect(next.tracks[0]?.id).toBe(old.jobId);
    expect(next.tracks[0]?.title).toBe("Old piano melody");
    const query = encodeURIComponent("AMBIENT 星 ピアノ");
    const search = musicTrackListSchema.parse(await (await app.request(`/v1/music/tracks?q=${query}&favorite=true`)).json());
    expect(search.tracks).toHaveLength(1);
    const favorites = musicFavoriteListSchema.parse(await (await app.request(`/v1/music/favorites?q=${query}`)).json());
    expect(favorites.favorites[0]?.jobId).toBe(named.jobId);
    expect(musicFavoriteListSchema.parse(await (await app.request("/v1/music/favorites?q=unmatched")).json()).favorites).toEqual([]);
    for (const suffix of ["?limit=0", "?limit=101", "?favorite=maybe", "?cursor=broken", "?q=" + "x".repeat(513)]) {
      expect((await app.request("/v1/music/tracks" + suffix)).status).toBe(400);
    }
    await manager.pruneArtifacts();
    await recovered.initialize();
    const recoveredApp = routes(recovered);
    const detail = musicTrackSchema.parse(await (await recoveredApp.request(`/v1/music/tracks/${named.jobId}`)).json());
    expect(detail).toMatchObject({ title: "星の夜", tags: ["ピアノ", "Ambient"], favorite: true });
    expect(recovered.getTrack(old.jobId)).toBeDefined();
    const audio = await recoveredApp.request(detail.audioUrl, { headers: { range: "bytes=0-3" } });
    expect(audio.status).toBe(206);
    expect(await audio.text()).toBe("OggS");
    expect((await recoveredApp.request(detail.metadataUrl)).status).toBe(200);
  } finally { manager.close(); recovered.close(); await rm(root, { recursive: true, force: true }); }
});

test("manual deletion removes a track from search, favorites and durable recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-library-delete-"));
  const manager = new MusicGenerationManager(provider(), { artifactRoot: root });
  const recovered = new MusicGenerationManager(provider(), { artifactRoot: root });
  try {
    const job = manager.create(musicGenerationRequestSchema.parse({ prompt: "remove me" }));
    await finished(manager, job.jobId);
    await manager.favorite(job.jobId);
    const app = routes(manager);
    expect((await app.request(`/v1/music/tracks/${job.jobId}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/v1/music/tracks/${job.jobId}/audio`)).status).toBe(404);
    expect((await app.request(`/v1/music/generations/${job.jobId}/audio`)).status).toBe(404);
    expect((await app.request(`/v1/music/tracks/${job.jobId}`, { method: "DELETE" })).status).toBe(404);
    await recovered.initialize();
    expect(recovered.listTracks({ limit: 50 }).tracks).toEqual([]);
    expect(recovered.listFavorites()).toEqual([]);
  } finally { manager.close(); recovered.close(); await rm(root, { recursive: true, force: true }); }
});

test("interrupted deletion is finished at startup without resurrecting a song", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-library-trash-"));
  const manager = new MusicGenerationManager(provider(), { artifactRoot: root });
  const recovered = new MusicGenerationManager(provider(), { artifactRoot: root });
  try {
    const job = manager.create(musicGenerationRequestSchema.parse({ prompt: "crash during delete" }));
    await finished(manager, job.jobId);
    await manager.pruneArtifacts();
    await rename(dirname(manager.artifact(job.jobId, "audio")!.path), join(root, `.deleted-${job.jobId}`));
    await recovered.initialize();
    expect(recovered.get(job.jobId)).toBeUndefined();
    expect(recovered.listTracks({ limit: 50 }).total).toBe(0);
    expect((await readdir(root)).some((name) => name.startsWith(".deleted-"))).toBe(false);
  } finally { manager.close(); recovered.close(); await rm(root, { recursive: true, force: true }); }
});

test("full storage rejects new saves and favorite moves without evicting songs", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-library-full-"));
  const manager = new MusicGenerationManager(provider(), { artifactRoot: root, random: () => "saved" });
  let limited: MusicGenerationManager | undefined;
  try {
    const job = manager.create(musicGenerationRequestSchema.parse({ prompt: "keep forever" }));
    await finished(manager, job.jobId);
    await manager.pruneArtifacts();
    const bytes = (await readFile(manager.artifact(job.jobId, "metadata")!.path)).byteLength + 4;
    limited = new MusicGenerationManager(provider(), { artifactRoot: root, maxArtifactBytes: bytes,
      favoriteMaxArtifactBytes: 0, random: () => "full" });
    await limited.initialize();
    const app = routes(limited);
    const favorite = await app.request(`/v1/music/generations/${job.jobId}/favorite`, { method: "PUT" });
    expect(favorite.status).toBe(507);
    expect(await favorite.json()).toMatchObject({ error: { code: "music_storage_full" } });
    expect(limited.getTrack(job.jobId)?.favorite).toBe(false);
    const next = limited.create(musicGenerationRequestSchema.parse({ prompt: "no room" }));
    expect((await finished(limited, next.jobId)).error?.code).toBe("music_storage_full");
    expect(limited.artifact(next.jobId, "audio")).toBeUndefined();
    expect(limited.getTrack(job.jobId)).toBeDefined();
    expect(await readFile(limited.artifact(job.jobId, "audio")!.path, "utf8")).toBe("OggS");
  } finally { manager.close(); limited?.close(); await rm(root, { recursive: true, force: true }); }
});

test("concurrent generations cannot exceed library capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-library-concurrent-"));
  const upstream = provider();
  let arrived = 0, sequence = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const manager = new MusicGenerationManager({ ...upstream, generate: async (request, context) => {
    if (++arrived === 2) release();
    await barrier;
    return { ...await upstream.generate(request, context), audio: new Uint8Array(100_000) };
  } }, { artifactRoot: root, concurrency: 2, maxArtifactBytes: 150_000,
    favoriteMaxArtifactBytes: 0, random: () => String(sequence++) });
  try {
    const jobs = ["first", "second"].map((prompt) => manager.create(musicGenerationRequestSchema.parse({ prompt })));
    const results = await Promise.all(jobs.map((job) => finished(manager, job.jobId)));
    expect(results.filter((job) => job.status === "completed")).toHaveLength(1);
    expect(results.find((job) => job.status === "failed")?.error?.code).toBe("music_storage_full");
    expect(manager.listTracks({ limit: 50 }).total).toBe(1);
  } finally { manager.close(); await rm(root, { recursive: true, force: true }); }
});
