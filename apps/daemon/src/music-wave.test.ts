import { expect, test } from "bun:test";
import { inspectMusicWave } from "./music-wave";
import { StableAudioMusicProvider } from "./stable-audio-provider";
import { musicGenerationRequestSchema, STABLE_SFX_MODEL } from "@larm/core";

function wave(samples = 66_150) {
  const audio = Buffer.alloc(44 + samples * 4);
  audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(2, 22);
  audio.writeUInt32LE(44100, 24); audio.writeUInt32LE(176400, 28); audio.writeUInt16LE(4, 32);
  audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}
test("native WAV validation checks sample data and accepts padded ancillary chunks and subviews", () => {
  expect(inspectMusicWave(wave())).toEqual({ durationSeconds: 1.5, sampleRateHz: 44100, channels: 2 });
  const junk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 0, 0]);
  const audio = Buffer.concat([wave().subarray(0, 12), junk, wave().subarray(12)]);
  audio.writeUInt32LE(audio.length - 8, 4);
  const surrounded = Buffer.concat([Buffer.alloc(3), audio, Buffer.alloc(7)]);
  expect(inspectMusicWave(surrounded.subarray(3, 3 + audio.length)).durationSeconds).toBe(1.5);
});

test("native WAV validation rejects truncation, forged RIFF sizes, bad format and inconsistent chunks", () => {
  const mutate = (fn: (audio: Buffer) => void) => { const audio = wave(); fn(audio); return audio; };
  for (const audio of [
    wave().subarray(0, 44), wave().subarray(0, 43), wave().subarray(0, wave().length - 1),
    mutate((b) => b.writeUInt32LE(0xffff_ffff, 40)),
    mutate((b) => b.writeUInt32LE(b.length - 45, 40)),
    mutate((b) => b.writeUInt32LE(0, 24)),
    mutate((b) => b.writeUInt32LE(1, 28)),
    mutate((b) => b.writeUInt16LE(1, 32)),
    mutate((b) => b.writeUInt16LE(32, 34)),
    mutate((b) => b.writeUInt16LE(3, 20)),
    mutate((b) => b.writeUInt32LE(15, 16)),
    mutate((b) => b.write("JUNK", 36)),
    mutate((b) => b.write("RIFF", 8)),
    mutate((b) => b.writeUInt16LE(0, 22)),
  ]) expect(() => inspectMusicWave(audio)).toThrow();
});

const request = (seconds = 1.5) => musicGenerationRequestSchema.parse({ prompt: "test", model: STABLE_SFX_MODEL, durationSeconds: seconds, outputFormat: "wav" });
const context = () => ({ jobId: "test", signal: new AbortController().signal, phase: () => {} });
test("Stable validates actual samples even when the upstream claims the requested duration", async () => {
  for (const audio of [wave(100), wave().subarray(0, 44)]) {
    const provider = new StableAudioMusicProvider({ endpoint: "http://unused", fetchImpl: async () => new Response(audio, { headers: { "X-AudioCPP-Audio-Duration-Ms": "1500" } }) });
    await expect(provider.generate(request(), context())).rejects.toMatchObject({ code: "invalid_upstream_response" });
  }
});

test("Stable uses WAV duration when no timing header exists and tolerates float32 sample rounding", async () => {
  const provider = new StableAudioMusicProvider({ endpoint: "http://unused", fetchImpl: async () => new Response(wave(145529), { headers: { "X-AudioCPP-Wall-Ms": "Infinity" } }) });
  const result = await provider.generate(request(3.3), context());
  expect(result.durationSeconds).toBe(145529 / 44100);
  expect(result.metadata).not.toHaveProperty("upstreamWallTimeMs");
  expect(result.metadata?.encoding.sourceSampleRateHz).toBe(44100);
});

test("Stable cancels an oversized streaming response without relying on content-length", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(64)); }, cancel() { cancelled = true; } });
  const provider = new StableAudioMusicProvider({ endpoint: "http://unused", maxAudioBytes: 100, fetchImpl: async () => new Response(body) });
  await expect(provider.generate(request(), context())).rejects.toMatchObject({ code: "audio_too_large" });
  expect(cancelled).toBeTrue();
});

test("Stable reports encoding failure and releases the worker when encoded output exceeds its limit", async () => {
  const audio = wave();
  let state = 42;
  for (let offset = 44; offset < audio.length; offset++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    audio[offset] = state >>> 24;
  }
  const { MediaVariantManager } = await import("@larm/backends");
  const { OnDemandMusicProvider } = await import("./music-manager");
  const calls: string[] = [];
  const variants = new MediaVariantManager({ script: "unused", idleTtlMs: { image: 0, music: 0 }, run: async (action, variant) => { calls.push(`${action}:${variant}`); } });
  const stable = new StableAudioMusicProvider({ endpoint: "http://unused", maxAudioBytes: audio.length, fetchImpl: async () => new Response(audio) });
  const provider = new OnDemandMusicProvider(stable, variants, "stable-audio");
  try {
    await expect(provider.generate({ ...request(), outputFormat: "flac" }, context())).rejects.toMatchObject({ code: "audio_encoding_failed", message: expect.stringContaining("too large") });
    expect(calls).toEqual(["start:stable-audio", "stop:stable-audio"]);
    expect(variants.isOccupied()).toBeFalse();
  } finally { await variants.close(); }
});
