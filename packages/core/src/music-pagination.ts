import { z } from "zod";
import type { MusicFavorite, MusicFavoriteQuery } from "./music";

export class InvalidMusicCursorError extends Error {}

export function encodeMusicCursor(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeMusicCursor(cursor: string): unknown {
  const bytes = Uint8Array.from(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

const favoriteCursorSchema = z.object({
  version: z.literal(1), kind: z.literal("music-favorites"),
  q: z.string().max(512), tags: z.array(z.string().min(1).max(64)).max(32),
  favoritedAt: z.string().datetime(),
  jobId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
}).strict();

// Search filtering happens before this function, while the cursor binds the
// same search settings and the stable favorite registration ordering key.
export function paginateMusicFavorites(favorites: readonly MusicFavorite[], query: MusicFavoriteQuery) {
  const context = { q: query.q ?? "", tags: [...(query.tags ?? [])].sort() };
  const compare = (a: Pick<MusicFavorite, "favoritedAt" | "jobId">, b: Pick<MusicFavorite, "favoritedAt" | "jobId">) =>
    b.favoritedAt.localeCompare(a.favoritedAt) || b.jobId.localeCompare(a.jobId);
  const matches = [...favorites].sort(compare);
  let cursor: z.infer<typeof favoriteCursorSchema> | undefined;
  if (query.cursor) {
    try {
      cursor = favoriteCursorSchema.parse(decodeMusicCursor(query.cursor));
      if (cursor.q !== context.q || JSON.stringify(cursor.tags) !== JSON.stringify(context.tags)) throw new Error("search changed");
    } catch { throw new InvalidMusicCursorError("invalid music favorites cursor or changed search settings"); }
  }
  const remaining = cursor ? matches.filter((favorite) => compare(favorite, cursor!) > 0) : matches;
  const page = remaining.slice(0, query.limit);
  const last = page.at(-1);
  return { favorites: page, total: matches.length,
    ...(last && remaining.length > page.length ? { nextCursor: encodeMusicCursor({ version: 1,
      kind: "music-favorites", ...context, favoritedAt: last.favoritedAt, jobId: last.jobId }) } : {}) };
}
