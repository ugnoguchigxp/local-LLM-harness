import { z } from "zod";
import type { MeshAsset, MeshAssetList, MeshQuery } from "./mesh";
const normalize = (s: string) => s.normalize("NFKC").toLowerCase();
const cursorSchema = z.object({ version: z.literal(1), context: z.string(), createdAt: z.string().datetime(), id: z.string(), score: z.number() }).strict();
export class InvalidMeshCursorError extends Error {}
export function listMeshAssets(assets: readonly MeshAsset[], query: MeshQuery): MeshAssetList {
  const context = JSON.stringify([query.q ?? "", [...(query.tags ?? [])].map(normalize).sort(), query.sort, query.order]);
  const words = [...new Set(normalize(query.q ?? "").split(/\s+/).filter(Boolean))];
  const direction = query.order === "asc" ? 1 : -1;
  const compare = (a: { score: number; createdAt: string; id: string }, b: { score: number; createdAt: string; id: string }) =>
    (query.sort === "relevance" ? direction * (a.score - b.score) : 0)
    || direction * (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const matches = assets.filter((a) => words.every((w) => normalize([a.title, a.prompt ?? "", ...a.tags].join("\n")).includes(w))
    && (query.tags ?? []).every((t) => a.tags.some((s) => normalize(s) === normalize(t))))
    .map((a) => ({ asset: a, id: a.id, createdAt: a.createdAt,
      score: words.reduce((n, w) => n + (normalize(a.title).includes(w) ? 6 : 0)
        + (a.tags.some((t) => normalize(t).includes(w)) ? 5 : 0) + (normalize(a.prompt ?? "").includes(w) ? 3 : 0), 0) })).sort(compare);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query.cursor) {
    try {
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
      if (cursor.context !== context) throw new Error();
    } catch { throw new InvalidMeshCursorError("invalid cursor or changed search settings"); }
  }
  const remaining = cursor ? matches.filter((a) => compare(a, cursor!) > 0) : matches;
  const page = remaining.slice(0, query.limit), last = page.at(-1);
  return { assets: page.map((a) => a.asset), total: matches.length,
    ...(last && remaining.length > page.length ? { nextCursor: Buffer.from(JSON.stringify({ version: 1, context, createdAt: last.createdAt, id: last.id, score: last.score })).toString("base64url") } : {}) };
}
