import { z } from "zod";
import type { MusicTrack, MusicTrackList, MusicTrackQuery } from "./music";

const cursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
}).strict();

export class InvalidMusicCursorError extends Error {}

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function musicTrackMatches(track: MusicTrack, query?: string): boolean {
  const words = normalized(query ?? "").split(/\s+/).filter(Boolean);
  const text = normalized([track.title, track.prompt, track.lyrics ?? "", ...track.tags].join("\n"));
  return words.every((word) => text.includes(word));
}

// Cursors contain the stable ordering key, so deleting a previous page's last
// track or inserting a newer track does not shift the next page.
export function listMusicTracks(tracks: readonly MusicTrack[], query: MusicTrackQuery): MusicTrackList {
  const matches = tracks.filter((track) => musicTrackMatches(track, query.q)
    && (query.favorite === undefined || track.favorite === (query.favorite === "true")));
  matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(atob(query.cursor))); }
    catch { throw new InvalidMusicCursorError("invalid music library cursor"); }
  }
  const remaining = cursor ? matches.filter((track) => track.createdAt < cursor.createdAt
    || (track.createdAt === cursor.createdAt && track.id.localeCompare(cursor.id) < 0)) : matches;
  const page = remaining.slice(0, query.limit);
  const last = page.at(-1);
  return {
    tracks: page,
    total: matches.length,
    ...(remaining.length > page.length && last
      ? { nextCursor: btoa(JSON.stringify({ createdAt: last.createdAt, id: last.id })) } : {}),
  };
}
