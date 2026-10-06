import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { musicGenerationRequestSchema } from "@larm/core";
import { MediaVariantManager, MediaVariantStopError } from "@larm/backends";
import { AceStepMusicProvider, MusicGenerationManager, OnDemandMusicProvider } from "./music-manager";

test("cancelled music startup does not submit generation and releases the media reservation", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const abort = new AbortController();
  let submissions = 0;
  const variants = new MediaVariantManager({
    script: "unused", idleTtlMs: { image: 60_000, music: 60_000 },
    run: async () => { started.resolve(); await finish.promise; },
  });
  const provider = new OnDemandMusicProvider(new AceStepMusicProvider({ endpoint: "http://music.test",
    fetchImpl: (async (_input: string | URL | Request, _init?: RequestInit) => {
      submissions++;
      return new Response();
    }) as typeof fetch,
  }), variants);
  try {
    const generation = provider.generate(musicGenerationRequestSchema.parse({ prompt: "test" }), {
      jobId: "test", signal: abort.signal, phase: () => {},
    });
    await started.promise;
    abort.abort(new Error("cancelled"));
    finish.resolve();
    await expect(generation).rejects.toThrow("cancelled");
    expect(submissions).toBe(0);
    (await variants.acquire("image"))();
  } finally {
    variants.close();
  }
});

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
      const payload = JSON.parse(String(init?.body));
      expect(payload.thinking).toBe(false);
      expect(payload.inference_steps).toBe(8);
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

test("music saves audio before awaiting worker shutdown and only then completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-stop-"));
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  let persisted = false;
  const upstream = new AceStepMusicProvider({ endpoint: "http://unused" });
  const manager = new MusicGenerationManager({
    id: upstream.id, capabilities: upstream.capabilities,
    load: async () => {}, unload: async () => {}, health: async () => ({ available: true }),
    generate: async () => ({ model: "acestep-v15-turbo", audio: new Uint8Array([1, 2]),
      format: "mp3", durationSeconds: 1, generationTimeMs: 1,
      release: async () => {
        const audio = await readFile(join(root, "2026", "10", "music_stop", "output.mp3"));
        persisted = audio.length === 2;
        stopping.resolve(); await stopped.promise;
      },
    }),
  }, { artifactRoot: root, random: () => "stop", now: () => Date.UTC(2026, 9, 6) });
  try {
    const job = manager.create(musicGenerationRequestSchema.parse({ prompt: "test" }));
    await stopping.promise;
    expect(persisted).toBe(true);
    expect(manager.get(job.jobId)?.status).not.toBe("completed");
    stopped.resolve();
    expect((await waitForTerminal(manager, job.jobId)).status).toBe("completed");
  } finally { stopped.resolve(); manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("recovery fails interrupted jobs without submitting them again", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-recovery-"));
  const upstream = new AceStepMusicProvider({ endpoint: "http://unused" });
  await mkdir(join(root, "jobs"));
  await writeFile(join(root, "jobs", "music_interrupted.json"), JSON.stringify({
    jobId: "music_interrupted", status: "loading", phase: "loading",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    request: musicGenerationRequestSchema.parse({ prompt: "test" }),
  }));
  const manager = new MusicGenerationManager(upstream, { artifactRoot: root });
  try {
    await manager.initialize();
    expect(manager.get("music_interrupted")?.error?.code).toBe("generation_interrupted");
  } finally { manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancellation waits for worker cleanup before publishing cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-cancel-"));
  const started = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const upstream = new AceStepMusicProvider({ endpoint: "http://unused" });
  const manager = new MusicGenerationManager({
    id: upstream.id, capabilities: upstream.capabilities,
    load: async () => {}, unload: async () => {}, health: async () => ({ available: true }),
    generate: async (_request, context) => {
      started.resolve();
      try {
        await new Promise<void>((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
        throw new Error("unreachable");
      } finally { stopping.resolve(); await stopped.promise; }
    },
  }, { artifactRoot: root });
  try {
    const job = manager.create(musicGenerationRequestSchema.parse({ prompt: "test" }));
    await started.promise;
    const cancellation = manager.cancel(job.jobId);
    await stopping.promise;
    expect(manager.get(job.jobId)?.status).not.toBe("cancelled");
    stopped.resolve();
    expect((await cancellation)?.status).toBe("cancelled");
  } finally { stopped.resolve(); manager.close(); await rm(root, { recursive: true, force: true }); }
});

for (const stopFails of [false, true]) test(`cancel during stop preserves terminal status across recovery (stopFails=${stopFails})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-stop-race-"));
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const upstream = new AceStepMusicProvider({ endpoint: "http://unused" });
  const provider = {
    id: upstream.id, capabilities: upstream.capabilities,
    load: async () => {}, unload: async () => {}, health: async () => ({ available: true }),
    generate: async () => ({ model: "acestep-v15-turbo", audio: new Uint8Array([1]),
      format: "mp3" as const, durationSeconds: 1, generationTimeMs: 1,
      release: async () => { stopping.resolve(); await stopped.promise;
        if (stopFails) throw new MediaVariantStopError("music", new Error("stop refused")); },
    }),
  };
  const manager = new MusicGenerationManager(provider, { artifactRoot: root });
  const recovered = new MusicGenerationManager(provider, { artifactRoot: root });
  try {
    const job = manager.create(musicGenerationRequestSchema.parse({ prompt: "test" }));
    const observed: string[] = [];
    manager.subscribe(job.jobId, (value) => { observed.push(value.status); });
    await stopping.promise;
    const cancellation = manager.cancel(job.jobId);
    stopped.resolve();
    const terminal = await cancellation;
    expect(terminal?.status).toBe(stopFails ? "failed" : "cancelled");
    expect(observed).not.toContain("completed");
    if (stopFails) expect(terminal?.error?.code).toBe("worker_stop_failed");
    await recovered.initialize();
    expect(recovered.get(job.jobId)?.status).toBe(terminal?.status);
    expect(recovered.artifact(job.jobId, "audio")).toBeDefined();
  } finally { stopped.resolve(); manager.close(); recovered.close(); await rm(root, { recursive: true, force: true }); }
});

test("expired artifacts remove durable jobs and cannot resurrect on restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-expiry-"));
  let now = Date.UTC(2026, 9, 6);
  const upstream = new AceStepMusicProvider({ endpoint: "http://unused" });
  const provider = { id: upstream.id, capabilities: upstream.capabilities,
    load: async () => {}, unload: async () => {}, health: async () => ({ available: true }),
    generate: async () => ({ model: "acestep-v15-turbo", audio: new Uint8Array([1]), format: "mp3" as const, durationSeconds: 1, generationTimeMs: 1 }),
  };
  const manager = new MusicGenerationManager(provider, { artifactRoot: root, now: () => now, retentionMs: 100 });
  const recovered = new MusicGenerationManager(provider, { artifactRoot: root, now: () => now, retentionMs: 100 });
  try {
    const job = manager.create(musicGenerationRequestSchema.parse({ prompt: "test" }));
    manager.subscribe(job.jobId, () => { throw new Error("broken subscriber"); });
    expect((await waitForTerminal(manager, job.jobId)).status).toBe("completed");
    now += 1_000;
    await manager.pruneArtifacts();
    expect(manager.get(job.jobId)).toBeUndefined();
    expect(await lstat(join(root, "jobs", `${job.jobId}.json`)).catch(() => undefined)).toBeUndefined();
    await recovered.initialize();
    expect(recovered.get(job.jobId)).toBeUndefined();
  } finally { manager.close(); recovered.close(); await rm(root, { recursive: true, force: true }); }
});

test("audio download enforces byte limit without content-length and cancels stream", async () => {
  let cancelled = false;
  const provider = new AceStepMusicProvider({ endpoint: "http://unused", maxAudioBytes: 3, pollIntervalMs: 1,
    fetchImpl: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/release_task") return Response.json({ code: 200, data: { task_id: "task" } });
      if (path === "/query_result") return Response.json({ code: 200, data: [{ task_id: "task", status: 1, result: JSON.stringify([{ file: "/v1/audio" }]) }] });
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
        cancel() { cancelled = true; },
      }));
    }) as typeof fetch,
  });
  await expect(provider.generate(musicGenerationRequestSchema.parse({ prompt: "test" }), {
    jobId: "music_limit", signal: new AbortController().signal, phase: () => {},
  })).rejects.toThrow("too large");
  expect(cancelled).toBe(true);
});

test("queued jobs hold activity leases and expire without provider submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-queue-"));
  const started = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  let now = Date.UTC(2026, 9, 6), active = 0, submissions = 0;
  const upstream = new AceStepMusicProvider({ endpoint: "http://unused" });
  const manager = new MusicGenerationManager({
    id: upstream.id, capabilities: upstream.capabilities,
    load: async () => {}, unload: async () => {}, health: async () => ({ available: true }),
    generate: async () => { submissions++; started.resolve(); await proceed.promise;
      return { model: "acestep-v15-turbo", audio: new Uint8Array([1]), format: "mp3", durationSeconds: 1, generationTimeMs: 1 };
    },
  }, { artifactRoot: root, now: () => now, queueTimeoutMs: 100,
    beginWorkload: () => { active++; return () => { active--; }; },
  });
  try {
    const first = manager.create(musicGenerationRequestSchema.parse({ prompt: "first" }));
    await started.promise;
    const second = manager.create(musicGenerationRequestSchema.parse({ prompt: "second" }));
    expect(active).toBe(2);
    now += 1_000; proceed.resolve();
    expect((await waitForTerminal(manager, first.jobId)).status).toBe("completed");
    expect((await waitForTerminal(manager, second.jobId)).error?.code).toBe("queue_timeout");
    expect(submissions).toBe(1);
    expect(active).toBe(0);
  } finally { proceed.resolve(); manager.close(); await rm(root, { recursive: true, force: true }); }
});
