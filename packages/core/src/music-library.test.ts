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
