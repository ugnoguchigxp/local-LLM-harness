import { expect, test } from "bun:test";
import { musicGenerationRequestSchema, musicProviderListSchema, type MusicProvider } from "@larm/core";
import { MediaVariantManager } from "@larm/backends";
import { OnDemandMusicProvider, MusicGenerationManager } from "./music-manager";
import { RoutedMusicProvider } from "./music-routing";
import { resolveMusicRoute, STABLE_MUSIC_MODEL, STABLE_SFX_MODEL } from "@larm/core";
import { StableAudioMusicProvider } from "./stable-audio-provider";
import { Hono } from "hono";
import { registerMusicRoutes } from "./routes/music";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parse = (data: Record<string, unknown>) => musicGenerationRequestSchema.parse({ prompt: "test", ...data });
const context = () => ({ jobId: "test", signal: new AbortController().signal, phase: () => {} });
const capabilities: MusicProvider["capabilities"] = { instrumental: true, vocals: true, lyrics: true, referenceAudio: false, remix: false, cover: false, repaint: false, stemSeparation: false, bpmControl: true, keyControl: true, qualityProfile: "high", speedProfile: "fast" };
function fake(id: string, calls: string[], generate?: MusicProvider["generate"]): MusicProvider {
  return { id, capabilities, load: async () => {}, unload: async () => {}, health: async () => ({ available: true }),
    generate: generate ?? (async (request) => { calls.push(`${id}:${request.model}`); return { model: request.model!, audio: new Uint8Array([1]), format: request.outputFormat, durationSeconds: request.durationSeconds, generationTimeMs: 1 }; }) };
}

test("intent routes instrumentals, vocals, lyrics and SFX; legacy aliases preserve automatic routing", () => {
  for (const model of [undefined, "auto", "ace-step-1.5", "acestep-v15-turbo", STABLE_MUSIC_MODEL]) {
    expect(resolveMusicRoute(parse({ model, instrumental: true }))).toEqual({ runtime: "stable-audio", model: STABLE_MUSIC_MODEL });
  }
  for (const data of [{}, { instrumental: false }, { lyrics: "Singing words" }, { model: "ace-step-1.5", lyrics: "Words" }]) {
    expect(resolveMusicRoute(parse(data))).toEqual({ runtime: "music", model: "acestep-v15-turbo" });
  }
  for (const data of [{ task: "sound-effect" }, { model: STABLE_SFX_MODEL }, { task: "sound-effect", model: "ace-step-1.5" }]) {
    expect(resolveMusicRoute(parse(data))).toEqual({ runtime: "stable-audio", model: STABLE_SFX_MODEL });
  }
  expect(parse({ task: "sound-effect", durationSeconds: 1.5 }).durationSeconds).toBe(1.5);
  expect(musicGenerationRequestSchema.safeParse({ prompt: "test", task: "sound-effect", lyrics: "words" }).success).toBeFalse();
  for (const data of [{ model: "acestep-v15-xl-turbo" }, { model: STABLE_MUSIC_MODEL, instrumental: false }, { task: "sound-effect", model: STABLE_MUSIC_MODEL }, { task: "music", model: STABLE_SFX_MODEL }]) {
    expect(() => resolveMusicRoute(parse(data))).toThrow();
  }
});

test("only the selected worker starts and completion waits for its shutdown", async () => {
  const calls: string[] = [];
  const variants = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0, "stable-audio": 0 }, run: async (action, variant) => { calls.push(`${action}:${variant}`); } });
  const provider = new RoutedMusicProvider(new OnDemandMusicProvider(fake("ace", calls), variants), new OnDemandMusicProvider(fake("stable", calls), variants, "stable-audio"));
  for (const data of [{ instrumental: true }, { lyrics: "words" }, { task: "sound-effect" }]) {
    const result = await provider.generate(parse(data), context());
    expect(variants.isOccupied()).toBeTrue();
    await result.release?.();
    expect(variants.isOccupied()).toBeFalse();
  }
  expect(calls).toEqual(["start:stable-audio", `stable:${STABLE_MUSIC_MODEL}`, "stop:stable-audio", "start:music", "ace:acestep-v15-turbo", "stop:music", "start:stable-audio", `stable:${STABLE_SFX_MODEL}`, "stop:stable-audio"]);
  await variants.close();
});

test("cancellation and generation failure stop the selected runtime, then allow another model", async () => {
  for (const cancelled of [false, true]) {
    const calls: string[] = [];
    const abort = new AbortController();
    const variants = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 }, run: async (action, variant) => { calls.push(`${action}:${variant}`); } });
    const broken = fake("stable", calls, async (_request, ctx) => { if (cancelled) abort.abort(new Error("cancelled")); ctx.signal.throwIfAborted(); throw new Error("failed"); });
    const provider = new RoutedMusicProvider(new OnDemandMusicProvider(fake("ace", calls), variants), new OnDemandMusicProvider(broken, variants, "stable-audio"));
    await expect(provider.generate(parse({ instrumental: true }), { ...context(), signal: abort.signal })).rejects.toThrow(cancelled ? "cancelled" : "failed");
    const vocal = await provider.generate(parse({ lyrics: "words" }), context());
    await vocal.release?.();
    expect(calls).toEqual(["start:stable-audio", "stop:stable-audio", "start:music", "ace:acestep-v15-turbo", "stop:music"]);
    await variants.close();
  }
});

function wav() {
  const audio = Buffer.alloc(44 + 44100 * 2 * 2 * 1.5);
  audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(2, 22); audio.writeUInt32LE(44100, 24); audio.writeUInt32LE(176400, 28); audio.writeUInt16LE(4, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}
test("Stable adapter sends bounded, reserved options and preserves all output formats and seed metadata", async () => {
  const payloads: Record<string, unknown>[] = [];
  const provider = new StableAudioMusicProvider({ endpoint: "http://127.0.0.1:8092", fetchImpl: (async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(wav(), { headers: { "X-AudioCPP-Audio-Duration-Ms": "1500", "X-AudioCPP-Wall-Ms": "25" } });
  }) as typeof fetch });
  for (const outputFormat of ["wav", "opus", "mp3", "flac"] as const) {
    const result = await provider.generate(parse({ model: STABLE_SFX_MODEL, task: "sound-effect", outputFormat, durationSeconds: 1.5, seed: 42 }), context());
    expect(result.audio.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ model: STABLE_SFX_MODEL, format: outputFormat, durationSeconds: 1.5, seed: 42 });
    const probe = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "json", "pipe:0"], { stdin: result.audio, stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    const decoded = await new Response(probe.stdout).json() as { streams: { codec_name: string }[] };
    expect(await probe.exited).toBe(0);
    expect(decoded.streams[0]?.codec_name).toBe({ wav: "pcm_s16le", opus: "opus", mp3: "mp3", flac: "flac" }[outputFormat]);
  }
  expect(payloads[0]).toMatchObject({ model: STABLE_SFX_MODEL, response_format: "wav", options: { duration_seconds: 1.5, num_inference_steps: 8, seed: 42, guidance_scale: 1, truncate_output_to_duration: true } });
  for (const providerOptions of [{ duration_seconds: 600 }, { model: "XL" }, { guidance_scale: Infinity }, { guidance_scale: -1 }, { audio_input: "/tmp/file" }]) {
    expect(() => provider.validate(parse({ model: STABLE_SFX_MODEL, durationSeconds: 1.5, providerOptions }))).toThrow();
  }
  expect(() => provider.validate(parse({ model: STABLE_MUSIC_MODEL, instrumental: true, durationSeconds: 120 }))).not.toThrow();
  expect(() => provider.validate(parse({ model: STABLE_MUSIC_MODEL, instrumental: true, durationSeconds: 121 }))).toThrow("120 seconds");
});

test("Stable adapter rejects oversized, non-WAV, failed and wrong-duration responses", async () => {
  for (const response of [new Response(wav(), { headers: { "content-length": "999999", "X-AudioCPP-Audio-Duration-Ms": "1500" } }), new Response("not audio"), new Response("failed", { status: 500 }), new Response(wav(), { headers: { "X-AudioCPP-Audio-Duration-Ms": "120000" } })]) {
    const provider = new StableAudioMusicProvider({ endpoint: "http://127.0.0.1:8092", maxAudioBytes: 300000, fetchImpl: async () => response });
    await expect(provider.generate(parse({ model: STABLE_SFX_MODEL, outputFormat: "wav", durationSeconds: 1.5 }), context())).rejects.toThrow();
  }
});

test("the public API rejects XL and invalid Stable options before admitting jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-routing-"));
  const stable = new StableAudioMusicProvider({ endpoint: "http://unused" });
  const manager = new MusicGenerationManager(new RoutedMusicProvider(fake("ace", []), stable), { artifactRoot: root });
  const app = new Hono(); registerMusicRoutes(app, { manager, maxBodyBytes: 1024 * 1024 });
  try {
    await manager.initialize();
    const discovery = musicProviderListSchema.parse(await (await app.request("/v1/music/providers")).json());
    expect(discovery.providers[0]!.models).toEqual([
      { id: STABLE_MUSIC_MODEL, task: "music", maxDurationSeconds: 120, defaultDurationSeconds: 120 },
      { id: "acestep-v15-turbo", task: "vocals", maxDurationSeconds: 600, defaultDurationSeconds: 180 },
      { id: STABLE_SFX_MODEL, task: "sound-effect", maxDurationSeconds: 120, defaultDurationSeconds: 5 },
    ]);
    for (const data of [{ model: "acestep-v15-xl-turbo" }, { task: "sound-effect", durationSeconds: 1.5, providerOptions: { duration_seconds: 600 } }, { instrumental: true, model: STABLE_SFX_MODEL, lyrics: "words" }, { instrumental: true, durationSeconds: 121 }]) {
      const response = await app.request("/v1/music/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "test", ...data }) });
      expect(response.status).toBe(400);
    }
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});

test("public requests with omitted Stable options are admitted with model-appropriate defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-defaults-"));
  const captured: Parameters<MusicProvider["generate"]>[0][] = [];
  const validator = new StableAudioMusicProvider({ endpoint: "http://unused" });
  const stable: MusicProvider = { ...fake("stable", []), validate: (request) => validator.validate(request),
    generate: async (request) => { captured.push(request); return { model: request.model!, audio: new Uint8Array([1]), format: request.outputFormat, durationSeconds: request.durationSeconds, generationTimeMs: 1 }; } };
  const manager = new MusicGenerationManager(new RoutedMusicProvider(fake("ace", []), stable), { artifactRoot: root });
  const app = new Hono(); registerMusicRoutes(app, { manager, maxBodyBytes: 1024 * 1024 });
  try {
    await manager.initialize();
    for (const data of [{ instrumental: true }, { task: "sound-effect" }, { model: STABLE_MUSIC_MODEL }, { model: STABLE_SFX_MODEL }]) {
      const response = await app.request("/v1/music/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "test", ...data }) });
      expect(response.status).toBe(202);
      const accepted = await response.json() as { jobId: string };
      for (let attempt = 0; attempt < 1000 && manager.get(accepted.jobId)?.status !== "completed"; attempt++) await Bun.sleep(1);
      expect(manager.get(accepted.jobId)?.status).toBe("completed");
    }
    await manager.close();
    expect(captured.map((request) => [request.model, request.durationSeconds])).toEqual([
      [STABLE_MUSIC_MODEL, 120], [STABLE_SFX_MODEL, 5], [STABLE_MUSIC_MODEL, 120], [STABLE_SFX_MODEL, 5],
    ]);
  } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});


test("closing music waits for worker cleanup and storage before returning", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-music-close-"));
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const provider = fake("test", [], async (request) => ({ model: "acestep-v15-turbo", audio: new Uint8Array([1]),
    format: request.outputFormat, durationSeconds: request.durationSeconds, generationTimeMs: 1,
    release: async () => { stopping.resolve(); await stopped.promise; } }));
  const manager = new MusicGenerationManager(provider, { artifactRoot: root });
  try {
    await manager.initialize();
    const job = manager.create(parse({}));
    await stopping.promise;
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    const repeated = manager.close();
    await Bun.sleep(1);
    expect(closed).toBeFalse();
    stopped.resolve();
    await Promise.all([closing, repeated]);
    expect(closed).toBeTrue();
    expect(manager.get(job.jobId)?.status).toBe("cancelled");
  } finally { stopped.resolve(); await manager.close(); await rm(root, { recursive: true, force: true }); }
});
