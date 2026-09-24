import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { musicGenerationRequestSchema } from "@larm/core";
import { AceStepMusicProvider, MusicGenerationManager } from "./music-manager";

async function waitForTerminal(manager: MusicGenerationManager, id: string) {
  for (let index = 0; index < 100; index++) {
    const job = manager.get(id)!;
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await Bun.sleep(2);
  }
  throw new Error("job did not finish");
}

test("ACE-Step job is normalized and materialized behind download URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-"));
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(url.pathname);
    if (url.pathname === "/release_task") {
      return Response.json({ data: { task_id: "upstream-1", status: "queued" }, code: 200 });
    }
    if (url.pathname === "/query_result") {
      return Response.json({
        data: [{
          task_id: "upstream-1",
          status: 1,
          result: JSON.stringify([{
            file: "/v1/audio?path=%2Ftmp%2Foutput.wav",
            metas: { duration: 30, bpm: 120 },
            seed_value: "42",
            dit_model: "acestep-v15-turbo",
          }]),
        }],
        code: 200,
      });
    }
    if (url.pathname === "/v1/audio") {
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "content-type": "audio/wav", "content-length": "4" },
      });
    }
    return new Response("missing", { status: 404 });
  };
  try {
    const manager = new MusicGenerationManager(new AceStepMusicProvider({
      endpoint: "http://127.0.0.1:8001",
      fetchImpl: fetchImpl as typeof fetch,
      pollIntervalMs: 1,
    }), { artifactRoot: root, random: () => "fixed" });
    const request = musicGenerationRequestSchema.parse({
      prompt: "cinematic electronic ambient music",
      durationSeconds: 30,
      instrumental: true,
      seed: 42,
      outputFormat: "wav",
    });
    const created = manager.create(request);
    expect(created.status).toBe("queued");
    const completed = await waitForTerminal(manager, created.jobId);
    expect(completed.status).toBe("completed");
    expect(completed.result).toMatchObject({
      provider: "ace-step",
      model: "acestep-v15-turbo",
      seed: 42,
      durationSeconds: 30,
      format: "wav",
      audioUrl: "/v1/music/generations/music_fixed/audio",
      metadataUrl: "/v1/music/generations/music_fixed/metadata",
    });
    expect(completed.result).not.toHaveProperty("audioPath");
    expect(calls).toEqual(["/release_task", "/query_result", "/v1/audio"]);

    const audio = manager.artifact(created.jobId, "audio")!;
    expect(new Uint8Array(await Bun.file(audio.path).arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
    const metadata = JSON.parse(await readFile(manager.artifact(created.jobId, "metadata")!.path, "utf8"));
    expect(metadata.audioFile).toBe("output.wav");
    expect(metadata).not.toHaveProperty("audioPath");
    expect(metadata.request.prompt).toBe(request.prompt);

    const favorite = await manager.favorite(created.jobId);
    expect(favorite?.audioUrl).toBe("/v1/music/favorites/music_fixed/audio");
    expect(manager.listFavorites()).toHaveLength(1);

    const recovered = new MusicGenerationManager(new AceStepMusicProvider({
      endpoint: "http://127.0.0.1:8001",
      fetchImpl: fetchImpl as typeof fetch,
    }), { artifactRoot: root });
    await recovered.initialize();
    expect(recovered.listFavorites()).toEqual(manager.listFavorites());
    expect(recovered.artifact(created.jobId, "audio")?.filename).toBe("output.wav");
    recovered.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("music request rejects lyrics on an instrumental", () => {
  expect(musicGenerationRequestSchema.safeParse({
    prompt: "ambient",
    instrumental: true,
    lyrics: "should not be used",
  }).success).toBeFalse();
});

test("music request defaults to compact MP3 output", () => {
  expect(musicGenerationRequestSchema.parse({ prompt: "ambient" }).outputFormat).toBe("mp3");
});

test("ACE-Step upstream output is removed only from its configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-upstream-"));
  const artifactRoot = join(root, "artifacts");
  const upstreamRoot = join(root, "upstream");
  const upstreamFile = join(upstreamRoot, "generated.mp3");
  await mkdir(upstreamRoot);
  await writeFile(upstreamFile, new Uint8Array([1, 2, 3]));
  const fetchImpl = async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/release_task") {
      return Response.json({ data: { task_id: "upstream-cleanup" }, code: 200 });
    }
    if (url.pathname === "/query_result") {
      return Response.json({
        data: [{
          status: 1,
          result: JSON.stringify([{ file: `/v1/audio?path=${encodeURIComponent(upstreamFile)}` }]),
        }],
        code: 200,
      });
    }
    if (url.pathname === "/v1/audio") return new Response(new Uint8Array([1, 2, 3]));
    return new Response("missing", { status: 404 });
  };
  try {
    const manager = new MusicGenerationManager(new AceStepMusicProvider({
      endpoint: "http://127.0.0.1:8001",
      fetchImpl: fetchImpl as typeof fetch,
      upstreamOutputRoot: upstreamRoot,
    }), { artifactRoot, random: () => "cleanup" });
    const created = manager.create(musicGenerationRequestSchema.parse({ prompt: "ambient" }));
    const completed = await waitForTerminal(manager, created.jobId);

    expect(completed.status).toBe("completed");
    expect(completed.result?.metadata?.upstreamArtifactCleanup).toBe("removed");
    expect(await lstat(upstreamFile).catch(() => undefined)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
