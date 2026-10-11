import { expect, test } from "bun:test";
import { paginateMusicFavorites } from "./music-pagination";
import { listMusicTags } from "./music-tags";
import { listMusicTracks } from "./music-library";
import { musicFavoriteQuerySchema, musicTagQuerySchema, musicTrackQuerySchema, type MusicFavorite, type MusicTrack } from "./music";

const favorites: MusicFavorite[] = Array.from({ length: 125 }, (_, i) => ({
  jobId: `music_${String(i).padStart(3, "0")}`, format: "opus", model: "ace-step", durationSeconds: 10,
  createdAt: "2026-10-11T00:00:00.000Z", favoritedAt: "2026-10-11T01:00:00.000Z",
  audioUrl: "/audio", metadataUrl: "/metadata",
}));
const tracks = favorites.map((favorite, i) => ({ id: favorite.jobId, title: "title", prompt: "neutral",
  tags: [`タグ${String(i).padStart(3, "0")}`], provider: "ace-step", model: "ace-step", format: "opus",
  durationSeconds: 10, instrumental: false, createdAt: favorite.createdAt, favorite: true,
  audioUrl: "/audio", metadataUrl: "/metadata" })) as MusicTrack[];

test("all music lists default to 50 then the next 50 without duplicates", () => {
  const loaders = [
    (cursor?: string) => { const page = listMusicTracks(tracks, musicTrackQuerySchema.parse({ cursor })); return { ...page, items: page.tracks.map((item) => item.id) }; },
    (cursor?: string) => { const page = paginateMusicFavorites(favorites, musicFavoriteQuerySchema.parse({ cursor })); return { ...page, items: page.favorites.map((item) => item.jobId) }; },
    (cursor?: string) => { const page = listMusicTags(tracks, musicTagQuerySchema.parse({ cursor })); return { ...page, items: page.tags.map((item) => item.tag) }; },
  ];
  for (const load of loaders) {
    const first = load(), second = load(first.nextCursor), last = load(second.nextCursor);
    expect([first.items.length, second.items.length, last.items.length]).toEqual([50, 50, 25]);
    expect([first.total, second.total, last.total]).toEqual([125, 125, 125]);
    expect(new Set([...first.items, ...second.items, ...last.items]).size).toBe(125);
    expect(last.nextCursor).toBeUndefined();
  }
});

test("favorite cursor survives boundary deletion and new favorites, and binds search settings", () => {
  const query = musicFavoriteQuerySchema.parse({ q: "明るい", tags: "ピアノ", limit: 1 });
  const first = paginateMusicFavorites(favorites, query);
  const changed = [{ ...favorites[0]!, jobId: "music_new", favoritedAt: "2026-10-12T01:00:00.000Z" }, ...favorites.slice(0, -1)];
  const next = paginateMusicFavorites(changed, { ...query, cursor: first.nextCursor });
  expect(next.favorites[0]?.jobId).toBe("music_123");
  expect(() => paginateMusicFavorites(favorites, { ...query, q: "暗い", cursor: first.nextCursor })).toThrow("cursor");
  expect(() => paginateMusicFavorites(favorites, { ...query, tags: ["ギター"], cursor: first.nextCursor })).toThrow("cursor");
});

test("tag pages honor count ordering and ties, and can continue after deleting the boundary tag", () => {
  const items = [...tracks, ...tracks.slice(0, 2)];
  const first = listMusicTags(items, { limit: 2 });
  expect(first.tags).toEqual([{ tag: "タグ000", count: 2 }, { tag: "タグ001", count: 2 }]);
  const second = listMusicTags(items.filter((track) => track.tags[0] !== "タグ001"), { limit: 1, cursor: first.nextCursor });
  expect(second.tags[0]).toEqual({ tag: "タグ002", count: 1 });
  const expanded = [{ ...tracks[0]!, tags: ["㍿".repeat(64), "z"] }];
  const wide = listMusicTags(expanded, { limit: 1 });
  expect(listMusicTags(expanded, { limit: 1, cursor: wide.nextCursor }).tags).toHaveLength(1);
});

test("invalid and cross-endpoint cursors are rejected, empty and exact pages have no continuation", () => {
  const tagCursor = listMusicTags(tracks, { limit: 1 }).nextCursor;
  const favoriteCursor = paginateMusicFavorites(favorites, { limit: 1 }).nextCursor;
  const trackCursor = listMusicTracks(tracks, { limit: 1 }).nextCursor;
  expect(() => paginateMusicFavorites(favorites, { limit: 50, cursor: tagCursor })).toThrow("cursor");
  expect(() => listMusicTags(tracks, { limit: 50, cursor: favoriteCursor })).toThrow("cursor");
  expect(() => listMusicTags(tracks, { limit: 50, cursor: trackCursor })).toThrow("cursor");
  expect(() => listMusicTracks(tracks, { limit: 50, cursor: favoriteCursor })).toThrow("cursor");
  for (const cursor of ["broken", btoa("null"), btoa("[]")]) {
    expect(() => listMusicTags(tracks, { limit: 50, cursor })).toThrow("cursor");
    expect(() => paginateMusicFavorites(favorites, { limit: 50, cursor })).toThrow("cursor");
  }
  expect(listMusicTags([], { limit: 50 })).toEqual({ tags: [], total: 0 });
  expect(paginateMusicFavorites([], { limit: 50 })).toEqual({ favorites: [], total: 0 });
  expect(listMusicTags(tracks.slice(0, 50)).nextCursor).toBeUndefined();
  expect(paginateMusicFavorites(favorites.slice(0, 50), { limit: 50 }).nextCursor).toBeUndefined();
  for (const schema of [musicFavoriteQuerySchema, musicTagQuerySchema]) {
    for (const limit of [0, 101, "no", ""]) expect(schema.safeParse({ limit }).success).toBe(false);
    expect(schema.parse({}).limit).toBe(50);
  }
});
