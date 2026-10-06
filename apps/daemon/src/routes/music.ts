import { Hono, type Context } from "hono";
import { musicGenerationRequestSchema } from "@larm/core";
import { errorBody, readJson } from "../app-http";
import { MusicProviderError, type MusicGenerationManager } from "../music-manager";

export function registerMusicRoutes(app: Hono, options: {
  manager?: MusicGenerationManager;
  maxBodyBytes: number;
}): void {
  const { manager } = options;
  app.get("/v1/music/providers", async (c) => {
    if (!manager) {
      return c.json(errorBody("not_configured", "music generation is not configured"), 503);
    }
    return c.json({
      providers: [{
        id: manager.provider.id,
        capabilities: manager.provider.capabilities,
        health: await manager.provider.health(),
      }],
    });
  });

  app.post("/v1/music/generations", async (c) => {
    if (!manager) {
      return c.json(errorBody("not_configured", "music generation is not configured"), 503);
    }
    const parsed = musicGenerationRequestSchema.safeParse(await readJson(c, options.maxBodyBytes));
    if (!parsed.success) {
      return c.json(errorBody("invalid_music_request", "invalid music generation request"), 400);
    }
    if (parsed.data.model && !["ace-step-1.5", "acestep-v15-turbo"].includes(parsed.data.model)) {
      return c.json(errorBody("invalid_music_model", "model must match the advertised music service"), 400);
    }
    let job;
    try { job = manager.create(parsed.data); }
    catch (error) {
      if (error instanceof MusicProviderError) return c.json(errorBody(error.code, error.message), 503);
      throw error;
    }
    c.header("location", `/v1/music/generations/${encodeURIComponent(job.jobId)}`);
    c.header("retry-after", "1");
    return c.json(job, 202);
  });

  app.get("/v1/music/generations/:id", (c) => {
    const job = manager?.get(c.req.param("id"));
    if (!job) return c.json(errorBody("not_found", "music generation job not found"), 404);
    c.header("cache-control", "no-store");
    return c.json(job);
  });

  app.delete("/v1/music/generations/:id", async (c) => {
    const job = await manager?.cancel(c.req.param("id"));
    if (!job) return c.json(errorBody("not_found", "music generation job not found"), 404);
    return c.json(job);
  });

  app.get("/v1/music/generations/:id/events", (c) => {
    if (!manager?.get(c.req.param("id"))) {
      return c.json(errorBody("not_found", "music generation job not found"), 404);
    }
    const id = c.req.param("id");
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        unsubscribe = manager.subscribe(id, (job) => {
          controller.enqueue(encoder.encode(
            `event: ${job.status}\ndata: ${JSON.stringify(job)}\n\n`,
          ));
          if (["completed", "failed", "cancelled"].includes(job.status)) {
            unsubscribe?.();
            controller.close();
          }
        });
      },
      cancel() {
        unsubscribe?.();
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  });

  const musicArtifact = async (c: Context, kind: "audio" | "metadata", favoriteOnly = false) => {
    const artifact = manager?.artifact(c.req.param("id") ?? "", kind, favoriteOnly);
    if (!artifact) return c.json(errorBody("not_found", "music artifact not found"), 404);
    c.header("content-type", artifact.contentType);
    c.header("content-disposition", `${kind === "audio" ? "inline" : "attachment"}; filename="${artifact.filename}"`);
    c.header("cache-control", "private, no-store");
    const file = Bun.file(artifact.path);
    if (kind !== "audio") return c.body(file.stream());
    c.header("accept-ranges", "bytes");
    const range = c.req.header("range");
    if (!range) {
      c.header("content-length", String(file.size));
      return c.body(file.stream());
    }
    const matched = /^bytes=(\d*)-(\d*)$/.exec(range);
    const requestedStart = matched?.[1] ? Number(matched[1]) : undefined;
    const requestedEnd = matched?.[2] ? Number(matched[2]) : undefined;
    const start = requestedStart ?? (requestedEnd === undefined ? Number.NaN : Math.max(0, file.size - requestedEnd));
    const end = requestedStart === undefined ? file.size - 1 : Math.min(requestedEnd ?? file.size - 1, file.size - 1);
    if (
      !matched
      || !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || start >= file.size
      || end < start
    ) {
      c.header("content-range", `bytes */${file.size}`);
      return c.body(null, 416);
    }
    c.status(206);
    c.header("content-range", `bytes ${start}-${end}/${file.size}`);
    c.header("content-length", String(end - start + 1));
    return c.body(file.slice(start, end + 1).stream());
  };
  app.get("/v1/music/generations/:id/audio", (c) => musicArtifact(c, "audio"));
  app.get("/v1/music/generations/:id/metadata", (c) => musicArtifact(c, "metadata"));

  app.get("/v1/music/favorites", (c) => {
    if (!manager) {
      return c.json(errorBody("not_configured", "music generation is not configured"), 503);
    }
    c.header("cache-control", "no-store");
    return c.json({ favorites: manager.listFavorites() });
  });

  app.get("/v1/music/favorites/:id", (c) => {
    const favorite = manager?.getFavorite(c.req.param("id"));
    if (!favorite) return c.json(errorBody("not_found", "music favorite not found"), 404);
    c.header("cache-control", "no-store");
    return c.json(favorite);
  });

  app.get("/v1/music/favorites/:id/audio", (c) => musicArtifact(c, "audio", true));
  app.get("/v1/music/favorites/:id/metadata", (c) => musicArtifact(c, "metadata", true));

  app.put("/v1/music/generations/:id/favorite", async (c) => {
    const favorite = await manager?.favorite(c.req.param("id"));
    if (!favorite) return c.json(errorBody("not_found", "completed music generation not found"), 404);
    return c.json(favorite);
  });

  app.delete("/v1/music/generations/:id/favorite", async (c) => {
    const removed = await manager?.unfavorite(c.req.param("id"));
    if (!removed) return c.json(errorBody("not_found", "completed music generation not found"), 404);
    return c.body(null, 204);
  });
}
