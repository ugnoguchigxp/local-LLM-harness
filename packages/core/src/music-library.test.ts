import { expect, test } from "bun:test";
import { listMusicTracks, musicTrackMatches } from "./music-library";
import { musicTrackQuerySchema, type MusicTrack } from "./music";

function track(id: string, title: string, favorite = false): MusicTrack {
  return { id, title, tags: ["ピアノ", "Ambient"], prompt: "Gentle nocturnal music",
    lyrics: "星の夜", instrumental: false, provider: "ace-step", model: "acestep-v15-turbo",
    format: "opus", durationSeconds: 10, createdAt: "2026-10-11T00:00:00.000Z", favorite,
    audioUrl: `/v1/music/tracks/${id}/audio`, metadataUrl: `/v1/music/tracks/${id}/metadata` };
}

test("library searches title, prompt, lyrics and tags with normalized AND matching", () => {
  const item = track("music_a", "ＡＢＣの夜");
  expect(musicTrackMatches(item, "abc AMBIENT 星")).toBe(true);
  expect(musicTrackMatches(item, "gentle ピアノ")).toBe(true);
  expect(musicTrackMatches(item, "ambient guitar")).toBe(false);
  expect(listMusicTracks([item, track("music_b", "別の曲", true)],
    musicTrackQuerySchema.parse({ favorite: "true", q: "星" })).tracks[0]?.id).toBe("music_b");
});

test("library cursor stays stable after deletion and newer insertions", () => {
  const items = [track("music_c", "c"), track("music_b", "b"), track("music_a", "a")];
  const first = listMusicTracks(items, musicTrackQuerySchema.parse({ limit: 1 }));
  expect(first.tracks[0]?.id).toBe("music_c");
  const second = listMusicTracks([track("music_d", "d"), ...items.slice(1)],
    musicTrackQuerySchema.parse({ limit: 1, cursor: first.nextCursor }));
  expect(second.tracks[0]?.id).toBe("music_b");
  expect(second.total).toBe(3);
  const last = listMusicTracks(items, musicTrackQuerySchema.parse({ limit: 1, cursor: second.nextCursor }));
  expect(last.tracks[0]?.id).toBe("music_a");
  expect(last.nextCursor).toBeUndefined();
  expect(() => listMusicTracks(items, musicTrackQuerySchema.parse({ cursor: "invalid" }))).toThrow("cursor");
  for (const limit of ["0", "101", "NaN"]) expect(musicTrackQuerySchema.safeParse({ limit }).success).toBe(false);
});

test("creation ordering supports both directions and stable ascending pagination", () => {
  const oldest = { ...track("music_old", "old"), createdAt: "2025-01-01T00:00:00.000Z" };
  const newest = { ...track("music_new", "new"), createdAt: "2026-01-01T00:00:00.000Z" };
  const items = [newest, oldest];
  expect(listMusicTracks(items, musicTrackQuerySchema.parse({ order: "asc" })).tracks.map((t) => t.id)).toEqual([oldest.id, newest.id]);
  const first = listMusicTracks(items, musicTrackQuerySchema.parse({ order: "asc", limit: 1 }));
  const second = listMusicTracks([newest], musicTrackQuerySchema.parse({ order: "asc", limit: 1, cursor: first.nextCursor }));
  expect(second.tracks[0]?.id).toBe(newest.id);
  expect(() => listMusicTracks(items, musicTrackQuerySchema.parse({ cursor: first.nextCursor }))).toThrow("cursor");
});

test("relevance favors explicit title and tags over prompt and lyrics, with stable cursors", () => {
  const items = [
    { ...track("music_lyrics", "other"), tags: [], prompt: "unrelated", lyrics: "明るい" },
    { ...track("music_prompt", "other"), tags: [], prompt: "明るいピアノ", lyrics: "" },
    { ...track("music_tag", "other"), tags: ["明るい"], prompt: "unrelated", lyrics: "" },
    { ...track("music_title", "明るい"), tags: [], prompt: "unrelated", lyrics: "" },
  ];
  const query = { q: "明るい", sort: "relevance", limit: 1 };
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = listMusicTracks(items, musicTrackQuerySchema.parse({ ...query, cursor }));
    ids.push(...page.tracks.map((item) => item.id)); cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toEqual(["music_title", "music_tag", "music_prompt", "music_lyrics"]);
  const first = listMusicTracks(items, musicTrackQuerySchema.parse(query));
  const afterDelete = listMusicTracks(items.slice(0, 3), musicTrackQuerySchema.parse({ ...query, cursor: first.nextCursor }));
  expect(afterDelete.tracks[0]?.id).toBe("music_tag");
  for (const change of [{ q: "other" }, { order: "asc" }, { tags: "明るい" }, { favorite: "true" }]) {
    expect(() => listMusicTracks(items, musicTrackQuerySchema.parse({ ...query, cursor: first.nextCursor, ...change }))).toThrow("cursor");
  }
});

test("tag filters match every exact normalized tag, and preserve search ordering", () => {
  const items = [track("music_a", "a"), { ...track("music_b", "b"), tags: ["明るい", "アップテンポ"] }];
  expect(listMusicTracks(items, musicTrackQuerySchema.parse({ tags: "明るい,アップテンポ" })).tracks.map((t) => t.id)).toEqual(["music_b"]);
  expect(listMusicTracks(items, musicTrackQuerySchema.parse({ tags: "ＡＭＢＩＥＮＴ" })).tracks.map((t) => t.id)).toEqual(["music_a"]);
  expect(listMusicTracks(items, musicTrackQuerySchema.parse({ tags: "明る" })).total).toBe(0);
  for (const tags of ["", ",", "明るい,", "x".repeat(65)]) expect(musicTrackQuerySchema.safeParse({ tags }).success).toBe(false);
});

test("legacy cursors still paginate newest-first lists", () => {
  const cursor = btoa(JSON.stringify({ createdAt: "2026-10-11T00:00:00.000Z", id: "music_b" }));
  const items = [track("music_b", "b"), track("music_a", "a")];
  expect(listMusicTracks(items, musicTrackQuerySchema.parse({ cursor })).tracks[0]?.id).toBe("music_a");
  expect(() => listMusicTracks(items, musicTrackQuerySchema.parse({ cursor, sort: "relevance" }))).toThrow("cursor");
});
