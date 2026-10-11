import { z } from "zod";
import type { MusicTrack, MusicTrackList, MusicTrackQuery } from "./music";
import { musicTrackTagsMatch, normalizeMusicText } from "./music-tags";
import { decodeMusicCursor, encodeMusicCursor, InvalidMusicCursorError } from "./music-pagination";
export { InvalidMusicCursorError } from "./music-pagination";

const keySchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
}).strict();
const cursorSchema = keySchema.extend({
  version: z.literal(1),
  sort: z.enum(["createdAt", "relevance"]),
  order: z.enum(["asc", "desc"]),
  q: z.string().max(512),
  tags: z.array(z.string().min(1).max(64)).max(32),
  favorite: z.enum(["all", "true", "false"]),
  score: z.number().int().nonnegative(),
}).strict();

function words(query?: string): string[] {
  return [...new Set(normalizeMusicText(query ?? "").split(/\s+/).filter(Boolean))];
}

export function musicTrackMatches(track: MusicTrack, query?: string): boolean {
  const text = normalizeMusicText([track.title, track.prompt, track.lyrics ?? "", ...track.tags].join("\n"));
  return words(query).every((word) => text.includes(word));
}

function relevance(track: MusicTrack, terms: readonly string[]): number {
  const title = normalizeMusicText(track.title);
  const tags = track.tags.map(normalizeMusicText);
  const prompt = normalizeMusicText(track.prompt);
  const lyrics = normalizeMusicText(track.lyrics ?? "");
  return terms.reduce((score, term) => score
    + (title === term ? 12 : title.includes(term) ? 6 : 0)
    + (tags.includes(term) ? 10 : tags.some((tag) => tag.includes(term)) ? 5 : 0)
    + (prompt.includes(term) ? 3 : 0) + (lyrics.includes(term) ? 1 : 0), 0);
}

type RankedKey = z.infer<typeof keySchema> & { score: number };

// Cursors carry the ordering key and search settings, so deleting a previous
// page's last track or inserting a newer track cannot shift the next page.
export function listMusicTracks(tracks: readonly MusicTrack[], query: MusicTrackQuery): MusicTrackList {
  const context = { sort: query.sort ?? "createdAt", order: query.order ?? "desc", q: query.q ?? "",
    tags: [...(query.tags ?? [])].sort(), favorite: query.favorite ?? "all" } as const;
  const direction = context.order === "asc" ? 1 : -1;
  const compare = (a: RankedKey, b: RankedKey) => context.sort === "relevance"
    ? direction * (a.score - b.score) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    : direction * (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const terms = words(query.q);
  const matches = tracks.filter((track) => musicTrackMatches(track, query.q)
    && musicTrackTagsMatch(track, query.tags)
    && (query.favorite === undefined || track.favorite === (query.favorite === "true")))
    .map((track) => ({ track, createdAt: track.createdAt, id: track.id, score: relevance(track, terms) }));
  matches.sort(compare);
  let cursor: RankedKey | undefined;
  if (query.cursor) {
    try {
      const value = decodeMusicCursor(query.cursor) as Record<string, unknown>;
      if (value.version === undefined) {
        // Preserve cursors issued before sort options were introduced.
        if (context.sort !== "createdAt" || context.order !== "desc" || context.tags.length) throw new Error("legacy cursor ordering changed");
        cursor = { ...keySchema.parse(value), score: 0 };
      } else {
        const parsed = cursorSchema.parse(value);
        if (parsed.sort !== context.sort || parsed.order !== context.order || parsed.q !== context.q
          || parsed.favorite !== context.favorite || JSON.stringify(parsed.tags) !== JSON.stringify(context.tags)) {
          throw new Error("cursor search settings changed");
        }
        cursor = parsed;
      }
    } catch { throw new InvalidMusicCursorError("invalid music library cursor or changed search settings"); }
  }
  const remaining = cursor ? matches.filter((item) => compare(item, cursor!) > 0) : matches;
  const page = remaining.slice(0, query.limit);
  const last = page.at(-1);
  const next = last && remaining.length > page.length
    ? { version: 1, ...context, createdAt: last.createdAt, id: last.id, score: last.score } : undefined;
  return {
    tracks: page.map((item) => item.track),
    total: matches.length,
    ...(next ? { nextCursor: encodeMusicCursor(next) } : {}),
  };
}
