import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { musicGenerationRequestSchema } from "@larm/core";
import { AceStepMusicProvider, MusicGenerationManager, OnDemandMusicProvider } from "./music-manager";
import { MediaVariantManager } from "@larm/backends";
import { Hono } from "hono";
import { registerMusicRoutes } from "./routes/music";

async function wave(): Promise<Uint8Array> {
  const child = Bun.spawn([
    "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", "-f", "wav", "pipe:1",
  ], { stdout: "pipe", stderr: "ignore" });
  const audio = new Uint8Array(await new Response(child.stdout).arrayBuffer());
  expect(await child.exited).toBe(0);
  return audio;
}

for (const mode of ["success", "bad-wave", "download-failed", "too-large", "cancel"] as const) {
  test(`default Opus pipeline deletes upstream WAV on ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "larm-opus-"));
    const upstreamRoot = join(root, "upstream");
    const upstreamFile = join(upstreamRoot, "generated.wav");
    const artifactRoot = join(root, "artifacts");
    await mkdir(upstreamRoot);
    const waveform = mode === "bad-wave" ? new Uint8Array([1, 2]) : await wave();
    await writeFile(upstreamFile, waveform);
    const abort = new AbortController();
    const provider = new AceStepMusicProvider({
      endpoint: "http://music.test", upstreamOutputRoot: upstreamRoot,
      maxAudioBytes: mode === "too-large" ? 100 : undefined,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/release_task") {
          expect(JSON.parse(String(init?.body)).audio_format).toBe("wav32");
          return Response.json({ code: 200, data: { task_id: "task" } });
        }
        if (url.pathname === "/query_result") return Response.json({ code: 200,
          data: [{ status: 1, result: [{ file: `/v1/audio?path=${encodeURIComponent(upstreamFile)}` }] }],
        });
        if (mode === "cancel") { abort.abort(new Error("cancelled")); throw abort.signal.reason; }
        return new Response(waveform, { status: mode === "download-failed" ? 502 : 200 });
      }) as typeof fetch,
    });
    const manager = new MusicGenerationManager(provider, { artifactRoot });
    const recovered = new MusicGenerationManager(provider, { artifactRoot });
    try {
      const request = musicGenerationRequestSchema.parse({ prompt: "test", durationSeconds: 2 });
      if (mode === "success") {
        const app = new Hono();
        registerMusicRoutes(app, { manager, maxBodyBytes: 1_000_000 });
        const created = await app.request("/v1/music/generations", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "test", durationSeconds: 2 }),
        });
        expect(created.status).toBe(202);
        const job = await created.json() as { jobId: string };
        for (let index = 0; index < 1000 && manager.get(job.jobId)?.status !== "completed"; index++) {
          if (manager.get(job.jobId)?.status === "failed") break;
          await Bun.sleep(5);
        }
        const result = manager.get(job.jobId);
        expect(result?.status).toBe("completed");
        expect(result?.result?.format).toBe("opus");
        expect(result?.result?.metadata?.encoding).toMatchObject({ bitrateBps: 128_000, bitrateMode: "vbr", sampleRateHz: 48_000 });
        const artifact = manager.artifact(job.jobId, "audio")!;
        expect(artifact).toMatchObject({ contentType: "audio/ogg", filename: "output.opus" });
        expect((await readFile(artifact.path)).subarray(0, 4).toString()).toBe("OggS");
        expect((await readdir(join(artifact.path, ".."))).sort()).toEqual(["metadata.json", "output.opus"]);
        const download = await app.request(`/v1/music/generations/${job.jobId}/audio`);
        expect(download.headers.get("content-type")).toBe("audio/ogg");
        expect(new TextDecoder().decode((await download.arrayBuffer()).slice(0, 4))).toBe("OggS");
        const range = await app.request(`/v1/music/generations/${job.jobId}/audio`, { headers: { range: "bytes=0-3" } });
        expect(range.status).toBe(206);
        expect(await range.text()).toBe("OggS");
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
        try {
          const overHttp = await fetch(`${server.url}v1/music/generations/${job.jobId}/audio`, {
            headers: { range: "bytes=0-3" },
          });
          expect(overHttp.status).toBe(206);
          expect(overHttp.headers.get("content-length")).toBe("4");
          expect(await overHttp.text()).toBe("OggS");
        } finally { server.stop(true); }
        await manager.pruneArtifacts();
        await manager.favorite(job.jobId);
        await recovered.initialize();
        expect(recovered.listFavorites()[0]?.format).toBe("opus");
        expect(recovered.artifact(job.jobId, "audio", true)?.contentType).toBe("audio/ogg");
      } else {
        await expect(provider.generate(request, { jobId: "test", signal: abort.signal, phase: () => {} }))
          .rejects.toThrow(mode === "bad-wave" ? "encoding failed" : mode === "download-failed" ? "502"
            : mode === "too-large" ? "too large" : "cancelled");
      }
      expect(await lstat(upstreamFile).catch(() => undefined)).toBeUndefined();
    } finally { manager.close(); recovered.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("Opus requires intermediate cleanup configuration before submitting", async () => {
  let calls = 0;
  const provider = new AceStepMusicProvider({ endpoint: "http://music.test",
    fetchImpl: (async (_input: string | URL | Request) => { calls++; return new Response(); }) as typeof fetch,
  });
  await expect(provider.generate(musicGenerationRequestSchema.parse({ prompt: "test" }), {
    jobId: "test", signal: new AbortController().signal, phase: () => {},
  })).rejects.toThrow("output root");
  expect(calls).toBe(0);
});

test("worker shutdown removes unfinished intermediates but leaves links and other files alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-opus-stop-"));
  const upstreamRoot = join(root, "upstream");
  await mkdir(upstreamRoot);
  const outside = join(root, "outside.wav");
  await writeFile(outside, "outside");
  await symlink(outside, join(upstreamRoot, "link.wav"));
  await writeFile(join(upstreamRoot, "keep.txt"), "keep");
  const abort = new AbortController();
  const variants = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 }, run: async () => {} });
  const upstream = new AceStepMusicProvider({ endpoint: "http://music.test", upstreamOutputRoot: upstreamRoot,
    fetchImpl: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/release_task") {
        await writeFile(join(upstreamRoot, "unfinished.wav"), "partial");
        abort.abort(new Error("cancelled"));
        throw abort.signal.reason;
      }
      return Response.json({});
    }) as typeof fetch,
  });
  const provider = new OnDemandMusicProvider(upstream, variants);
  try {
    await expect(provider.generate(musicGenerationRequestSchema.parse({ prompt: "test" }), {
      jobId: "test", signal: abort.signal, phase: () => {},
    })).rejects.toThrow("cancelled");
    expect((await readdir(upstreamRoot)).sort()).toEqual(["keep.txt", "link.wav"]);
    expect(await readFile(outside, "utf8")).toBe("outside");
  } finally { variants.close(); await rm(root, { recursive: true, force: true }); }
});
