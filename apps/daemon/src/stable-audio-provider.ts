import { randomInt } from "node:crypto";
import type { MusicGenerationRequest, MusicProvider } from "@larm/core";
import { MusicProviderError } from "./music-errors";
import { encodeMusicAudio } from "./music-audio";
import { inspectMusicWave } from "./music-wave";
import { STABLE_MUSIC_MODEL, STABLE_SFX_MODEL, STABLE_MAX_DURATION_SECONDS } from "@larm/core";

export class StableAudioMusicProvider implements MusicProvider {
  readonly id = "stable-audio";
  readonly capabilities: MusicProvider["capabilities"] = {
    instrumental: true, vocals: false, lyrics: false, referenceAudio: false,
    remix: false, cover: false, repaint: false, stemSeparation: false,
    bpmControl: false, keyControl: false, maxDurationSeconds: STABLE_MAX_DURATION_SECONDS,
    qualityProfile: "high", speedProfile: "fast",
  };
  private readonly base: URL;
  constructor(private readonly options: { endpoint: string; fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; maxAudioBytes?: number }) {
    this.base = new URL(options.endpoint);
    if (!["http:", "https:"].includes(this.base.protocol)) throw new Error("Stable Audio endpoint must use http or https");
    this.base.pathname = `${this.base.pathname.replace(/\/+$/, "")}/`;
    this.base.search = ""; this.base.hash = "";
  }
  async load(): Promise<void> { const health = await this.health(); if (!health.available) throw new MusicProviderError("provider_unavailable", health.reason!); }
  async unload(): Promise<void> {} // Native server uses memory only; the media lease stops its process.
  async health() {
    try {
      const response = await this.fetch("health", { signal: AbortSignal.timeout(5_000) });
      return response.ok ? { available: true } : { available: false, reason: `Stable Audio health returned HTTP ${response.status}` };
    } catch (error) { return { available: false, reason: String(error) }; }
  }
  validate(request: MusicGenerationRequest): void {
    if (![STABLE_MUSIC_MODEL, STABLE_SFX_MODEL].includes(request.model ?? "")) throw new MusicProviderError("invalid_music_model", "Stable Audio requires a configured Music or SFX model");
    if (request.referenceAudio || request.lyrics?.trim()) throw new MusicProviderError("unsupported_feature", "Stable Audio supports prompt-based instrumental music and sound effects");
    if (request.durationSeconds > STABLE_MAX_DURATION_SECONDS) throw new MusicProviderError("unsupported_feature", "Stable Audio Music and SFX support at most 120 seconds; specify durationSeconds from 1 through 120");
    const options = request.providerOptions ?? {};
    if (Object.keys(options).some((key) => key !== "guidance_scale") ||
      (options.guidance_scale !== undefined && (typeof options.guidance_scale !== "number" || !Number.isFinite(options.guidance_scale) || options.guidance_scale < 0 || options.guidance_scale > 10))) {
      throw new MusicProviderError("invalid_music_options", "Stable Audio providerOptions accepts only guidance_scale (0 through 10)");
    }
  }
  async generate(request: MusicGenerationRequest, context: Parameters<MusicProvider["generate"]>[1]) {
    this.validate(request);
    context.signal.throwIfAborted();
    const seed = request.seed ?? randomInt(0, 2_147_483_648);
    const steps = request.quality === "fast" ? 4 : request.quality === "high" ? 12 : 8;
    const hints = [request.bpm ? `${request.bpm} BPM` : "", request.key ? `Key: ${request.key}` : "", request.timeSignature ? `Time signature: ${request.timeSignature}` : ""].filter(Boolean);
    const prompt = [request.prompt, ...hints, ...(request.model === STABLE_MUSIC_MODEL ? ["Instrumental, no vocals."] : [])].join(". ");
    const started = Date.now();
    context.phase("generating");
    const response = await this.fetch("v1/audio/speech", {
      method: "POST", headers: { "content-type": "application/json" }, signal: context.signal,
      body: JSON.stringify({ model: request.model, input: prompt, response_format: "wav", options: {
        duration_seconds: request.durationSeconds, seed, num_inference_steps: steps,
        guidance_scale: request.providerOptions?.guidance_scale ?? 1,
        truncate_output_to_duration: true,
      } }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new MusicProviderError("upstream_error", `Stable Audio returned HTTP ${response.status}`); }
    const maxBytes = this.options.maxAudioBytes ?? 512 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw new MusicProviderError("audio_too_large", "Stable Audio output exceeds size limit"); }
    const reader = response.body?.getReader();
    if (!reader) throw new MusicProviderError("invalid_upstream_response", "Stable Audio returned no audio");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new MusicProviderError("audio_too_large", "Stable Audio output exceeds size limit");
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const waveform = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { waveform.set(chunk, offset); offset += chunk.byteLength; }
    let source: ReturnType<typeof inspectMusicWave>;
    try { source = inspectMusicWave(waveform); }
    catch (error) { throw new MusicProviderError("invalid_upstream_response", error instanceof Error ? error.message : "invalid Stable Audio WAV"); }
    const { durationSeconds } = source;
    const durationHeader = response.headers.get("X-AudioCPP-Audio-Duration-Ms");
    const reportedDuration = durationHeader === null ? durationSeconds : Number(durationHeader) / 1000;
    // The runtime converts the requested seconds to float32 before sample rounding.
    if (!Number.isFinite(reportedDuration) || Math.abs(reportedDuration - durationSeconds) > 1 / source.sampleRateHz || Math.abs(durationSeconds - request.durationSeconds) > 2 / source.sampleRateHz) {
      throw new MusicProviderError("invalid_upstream_response", "Stable Audio returned an unexpected duration");
    }
    context.phase("encoding");
    let audio: Uint8Array;
    try { audio = request.outputFormat === "wav" ? waveform : await encodeMusicAudio(waveform, request.outputFormat, context.signal, maxBytes); }
    catch (error) {
      context.signal.throwIfAborted();
      throw new MusicProviderError("audio_encoding_failed", error instanceof Error ? error.message : "Stable Audio encoding failed");
    }
    context.signal.throwIfAborted();
    const generationTimeMs = Date.now() - started;
    const upstreamWallTimeMs = Number(response.headers.get("X-AudioCPP-Wall-Ms"));
    return { model: request.model!, audio, durationSeconds, format: request.outputFormat, seed, generationTimeMs,
      realtimeFactor: generationTimeMs / 1000 / durationSeconds,
      metadata: { backend: "audio.cpp", steps, prompt, musicalControls: "prompt-hints",
        ...(Number.isFinite(upstreamWallTimeMs) && upstreamWallTimeMs > 0 ? { upstreamWallTimeMs } : {}),
        encoding: { intermediateFormat: "wav16", sourceSampleRateHz: source.sampleRateHz, sourceChannels: source.channels,
          ...(request.outputFormat === "opus" ? { codec: "opus", container: "ogg", bitrateBps: 128_000, bitrateMode: "vbr", sampleRateHz: 48_000 } : {}) } },
    };
  }
  private fetch(path: string, init: RequestInit) { return (this.options.fetchImpl ?? fetch)(new URL(path, this.base), { ...init, redirect: "error" }); }
}
