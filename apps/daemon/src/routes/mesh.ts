import { Hono, type Context } from "hono";
import { InvalidMeshCursorError, meshAssetPatchSchema, meshGenerationRequestSchema, meshQuerySchema } from "@larm/core";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { errorBody, readJson } from "../app-http";
import { MeshError } from "../mesh-store";
import type { MeshManager } from "../mesh-manager";

const viewerDigest = "8367184a607fbe07a78b650c0d359e5ebbd96f7e2b22f95f761f559b63430386";
const escape = (s: string) => s.replace(/[&<>"']/g, (v) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[v]!);
export function registerMeshRoutes(parent: Hono, options: { manager?: MeshManager; maxBodyBytes: number; viewerPath: string }) {
  const app = new Hono();
  const { manager } = options;
  app.onError((error, c) => {
    if (error instanceof MeshError) {
      if (error.status === 429) c.header("retry-after", "10");
      return c.json(errorBody(error.code, error.message), error.status);
    }
    if (error instanceof InvalidMeshCursorError) return c.json(errorBody("invalid_cursor", error.message), 400);
    throw error;
  });
  app.use("/v1/3d/*", async (c, next) => {
    c.header("cache-control", "private, no-store"); c.header("x-content-type-options", "nosniff");
    if (!manager || !manager.store.ready) return c.json(errorBody("not_configured", "3D generation is not configured"), 503);
    await next();
  });
  app.post("/v1/3d/generations", async (c) => {
    const parsed = meshGenerationRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) return c.json(errorBody("invalid_mesh_request", "invalid 3D generation request"), 400);
    const job = await manager!.create(parsed.data, c.req.header("idempotency-key") ?? "");
    c.header("location", job.statusUrl); c.header("retry-after", "1"); return c.json(job, 202);
  });
  app.get("/v1/3d/generations/:id", (c) => { const job = manager!.get(c.req.param("id")); return job ? c.json(job) : c.json(errorBody("not_found", "3D job not found"), 404); });
  app.delete("/v1/3d/generations/:id", async (c) => { const job = await manager!.cancel(c.req.param("id")); return job ? c.json(job) : c.json(errorBody("not_found", "3D job not found"), 404); });
  app.get("/v1/3d/generations/:id/events", (c) => {
    const id = c.req.param("id"), current = manager!.get(id);
    if (!current) return c.json(errorBody("not_found", "3D job not found"), 404);
    let unsubscribe: (() => void) | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => { unsubscribe?.(); if (heartbeat) clearInterval(heartbeat); };
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (job: typeof current) => {
          controller.enqueue(encoder.encode(`event: ${job.status}\ndata: ${JSON.stringify(job)}\n\n`));
          if (["completed", "failed", "cancelled"].includes(job.status)) { cleanup(); controller.close(); }
        };
        unsubscribe = manager!.subscribe(id, emit);
        heartbeat = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 15000);
        emit(manager!.get(id)!);
      }, cancel: cleanup,
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
  });
  app.get("/v1/3d/assets", (c) => {
    const parsed = meshQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json(errorBody("invalid_mesh_query", "invalid library query"), 400);
    return c.json(manager!.store.list(parsed.data));
  });
  app.get("/v1/3d/assets/:id", (c) => { const asset = manager!.store.get(c.req.param("id")); return asset ? c.json(asset) : c.json(errorBody("not_found", "3D asset not found"), 404); });
  app.get("/v1/3d/assets/:id/metadata", (c) => { const asset = manager!.store.get(c.req.param("id")); return asset ? c.json(asset) : c.json(errorBody("not_found", "3D asset not found"), 404); });
  app.patch("/v1/3d/assets/:id", async (c) => {
    const parsed = meshAssetPatchSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) return c.json(errorBody("invalid_mesh_patch", "only title and tags may be edited"), 400);
    const asset = await manager!.store.patch(c.req.param("id"), parsed.data); return asset ? c.json(asset) : c.json(errorBody("not_found", "3D asset not found"), 404);
  });
  app.delete("/v1/3d/assets/:id", async (c) => await manager!.deleteAsset(c.req.param("id")) ? c.body(null, 204) : c.json(errorBody("not_found", "3D asset not found"), 404));
  const binary = async (c: Context, kind: "source" | "content") => {
    const artifact = await manager!.store.content(c.req.param("id") ?? "", kind);
    if (!artifact) return c.json(errorBody("not_found", "3D artifact not found"), 404);
    const etag = `"${artifact.hash}"`;
    c.header("etag", etag); c.header("content-type", artifact.mimeType); c.header("accept-ranges", "bytes");
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    const data = artifact.data, range = c.req.header("range");
    if (range && (!c.req.header("if-range") || c.req.header("if-range") === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, data.length - Number(match[2])) : NaN;
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= data.length || end < start || (match?.[1] === "" && Number(match?.[2]) === 0)) {
        c.header("content-range", `bytes */${data.length}`); return c.body(null, 416);
      }
      c.header("content-range", `bytes ${start}-${end}/${data.length}`); c.header("content-length", String(end - start + 1));
      return new Response(data.subarray(start, end + 1), { status: 206, headers: c.res.headers });
    }
    c.header("content-length", String(data.length)); return new Response(data, { headers: c.res.headers });
  };
  app.get("/v1/3d/assets/:id/content", (c) => binary(c, "content"));
  app.get("/v1/3d/assets/:id/source", (c) => binary(c, "source"));
  app.get("/v1/3d/assets/:id/preview", async (c) => {
    const id = c.req.param("id"), asset = manager!.store.get(id);
    if (!asset) return c.json(errorBody("not_found", "3D asset not found"), 404);
    const [glb, source, viewer] = await Promise.all([manager!.store.content(id, "content"), manager!.store.content(id, "source"), readFile(options.viewerPath, "utf8")]);
    if (!glb || !source) return c.json(errorBody("not_found", "3D asset not found"), 404);
    if (createHash("sha256").update(viewer).digest("hex") !== viewerDigest) throw new MeshError("viewer_unavailable", 503, "viewer integrity check failed");
    const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(asset.title)}</title><style>body{margin:0;background:#20232a;color:white;font:16px sans-serif}h1,p{margin:16px}model-viewer{width:100%;height:75vh}img{max-width:180px}</style><h1>${escape(asset.title)}</h1><model-viewer camera-controls auto-rotate environment-image="neutral" src="data:model/gltf-binary;base64,${glb.data.toString("base64")}"></model-viewer><p><img alt="元画像" src="data:${source.mimeType};base64,${source.data.toString("base64")}"></p><p>${asset.warnings.map(escape).join("<br>")}</p><script type="module">${viewer.replace(/<\/script/gi, "<\\/script")}</script></html>`;
    c.header("content-security-policy", "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src data: blob:; frame-ancestors 'self'");
    return c.html(html);
  });
  parent.route("/", app);
}
