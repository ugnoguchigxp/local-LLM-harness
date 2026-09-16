import { LarmClient, type LarmClientOptions } from "../../../packages/client/src/index";
import {
  inspectOpenAiChatCompletionJson,
  inspectOpenAiTranscriptionJson,
  isOpenAiSpeechMediaType,
  OpenAiChatCompletionSseInspector,
} from "../../../packages/core/src/index";
import { wavDurationSeconds } from "./performance-helpers";

export type HttpProviderLiveSmokeOptions = {
  baseUrl: string;
  apiToken: string;
  model: string;
  asrModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  expectedReleaseCommit?: string;
  includeAudio?: boolean;
  timeoutMs?: number;
  fetch?: NonNullable<LarmClientOptions["fetch"]>;
};

export type HttpProviderLiveSmokeResult = {
  schemaVersion: 1;
  kind: "http-provider-canary";
  ok: true;
  desiredRelease: string;
  observedAt: string;
  releaseCommit: string;
  configRevision: string;
  bootEpoch: string;
  model: string;
  jsonValidated: true;
  sse: { chunks: number; deltas: number; finishReasons: number };
  audio: null | {
    asrModel: string;
    transcriptionValidated: true;
    ttsModel: string;
    mediaType: string;
    bytes: number;
    durationSeconds: number;
  };
};

const TEXT_LIMIT = 4 * 1024 * 1024;
const AUDIO_LIMIT = 256 * 1024 * 1024;

function silenceWav(seconds = 0.25, sampleRate = 16_000): Uint8Array {
  const dataBytes = Math.round(seconds * sampleRate) * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function mediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isSchemaCanaryCompletion(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length !== 1) return false;
  const choice = choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return false;
  const record = choice as Record<string, unknown>;
  if (record.finish_reason !== "stop") return false;
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string") return false;
  try {
    const structured = JSON.parse(content) as unknown;
    return !!structured
      && typeof structured === "object"
      && !Array.isArray(structured)
      && (structured as Record<string, unknown>).ok === true
      && Object.keys(structured as Record<string, unknown>).length === 1;
  } catch {
    return false;
  }
}

function isShortTextCanaryCompletion(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const choices = (value as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length !== 1) return false;
  const choice = choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return false;
  const record = choice as Record<string, unknown>;
  if (record.finish_reason !== "stop") return false;
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" && content.trim() === "OK";
}

async function responseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel(new Error("response_too_large")).catch(() => undefined);
    throw new Error("response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response_body_missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error("response_too_large");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("response_json_invalid");
  }
}

function voiceNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const voices = (value as Record<string, unknown>).voices;
  if (!Array.isArray(voices)) return [];
  return voices.flatMap((voice) => {
    if (!voice || typeof voice !== "object" || Array.isArray(voice)) return [];
    const name = (voice as Record<string, unknown>).name;
    return typeof name === "string" && name.length > 0 ? [name] : [];
  });
}

async function inspectSse(response: Response): Promise<{ chunks: number; deltas: number; finishReasons: number }> {
  if (mediaType(response) !== "text/event-stream") throw new Error("sse_media_type_invalid");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response_body_missing");
  const inspector = new OpenAiChatCompletionSseInspector();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > TEXT_LIMIT) throw new Error("response_too_large");
      const progress = inspector.push(chunk.value);
      if (!progress.ok) throw new Error(`sse_${progress.reason}`);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const result = inspector.finish();
  if (!result.ok) throw new Error(`sse_${result.reason}`);
  return { chunks: result.chunks, deltas: result.deltas, finishReasons: result.finishReasons };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > 3_600_000) {
    throw new Error("timeoutMs must be an integer from 1 through 3600000");
  }
  return result;
}

export async function runHttpProviderLiveSmoke(
  options: HttpProviderLiveSmokeOptions,
): Promise<HttpProviderLiveSmokeResult> {
  if (!options.apiToken) throw new Error("apiToken is required");
  if (options.expectedReleaseCommit && !/^[a-f0-9]{40}$/.test(options.expectedReleaseCommit)) {
    throw new Error("expectedReleaseCommit must be a full lowercase Git commit");
  }
  const timeoutMs = positiveInteger(options.timeoutMs, 300_000);
  const client = new LarmClient({
    baseUrl: options.baseUrl,
    apiToken: options.apiToken,
    timeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const health = await client.getHealth();
  if (health.releaseCommit === "development") throw new Error("live release identity is development");
  if (options.expectedReleaseCommit && health.releaseCommit !== options.expectedReleaseCommit) {
    throw new Error(`release drift: expected ${options.expectedReleaseCommit}, got ${health.releaseCommit}`);
  }
  const ready = await client.getReadiness();
  if (ready.status !== "ready") throw new Error(`LARM is not ready: ${ready.status}`);
  const catalog = await client.listOpenAiModels();
  const requiredModels = [
    options.model,
    ...((options.includeAudio ?? true) ? [options.asrModel ?? "qwen3-asr-1.7b", options.ttsModel ?? "voicevox-core"] : []),
  ];
  for (const model of requiredModels) {
    if (!catalog.data.some((candidate) => candidate.id === model)) {
      throw new Error(`model is not advertised: ${model}`);
    }
  }

  const jsonPrompt = "Return a JSON object whose only field is ok with the boolean value true.";
  const jsonResponse = await client.createChatCompletion({
    model: options.model,
    messages: [{ role: "user", content: jsonPrompt }],
    temperature: 0,
    // Reasoning-capable Qwen profiles can spend dozens of tokens before
    // emitting the schema-constrained content. Keep the canary bounded while
    // leaving enough room to require finish_reason=stop instead of length.
    max_tokens: 256,
    stream: false,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "larm_live_canary",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean", const: true } },
        },
      },
    },
  });
  if (mediaType(jsonResponse) !== "application/json") throw new Error("json_media_type_invalid");
  const jsonValue = parseJson(await responseBytes(jsonResponse, TEXT_LIMIT));
  const json = inspectOpenAiChatCompletionJson(jsonValue);
  if (!json.ok || json.model !== options.model || json.textChoices < 1) {
    throw new Error("json_completion_invalid");
  }
  if (!isSchemaCanaryCompletion(jsonValue)) throw new Error("json_schema_completion_invalid");

  const shortResponse = await client.createChatCompletion({
    model: options.model,
    messages: [{ role: "user", content: "Reply with just OK." }],
    temperature: 0,
    max_tokens: 256,
    stream: false,
  });
  if (mediaType(shortResponse) !== "application/json") throw new Error("short_json_media_type_invalid");
  const shortValue = parseJson(await responseBytes(shortResponse, TEXT_LIMIT));
  const short = inspectOpenAiChatCompletionJson(shortValue);
  if (!short.ok || short.model !== options.model || !isShortTextCanaryCompletion(shortValue)) {
    throw new Error("short_text_completion_invalid");
  }

  const sseResponse = await client.createChatCompletion({
    model: options.model,
    messages: [{ role: "user", content: "Reply with OK." }],
    temperature: 0,
    max_tokens: 256,
    stream: true,
    stream_options: { include_usage: true },
  });
  const sse = await inspectSse(sseResponse);

  let audio: HttpProviderLiveSmokeResult["audio"] = null;
  if (options.includeAudio ?? true) {
    const asrModel = options.asrModel ?? "qwen3-asr-1.7b";
    const ttsModel = options.ttsModel ?? "voicevox-core";
    const ttsVoice = options.ttsVoice ?? "Kasukabe_Tsumugi";
    const form = new FormData();
    form.append("model", asrModel);
    form.append("response_format", "json");
    form.append("file", new Blob([silenceWav()], { type: "audio/wav" }), "silence.wav");
    const transcriptionResponse = await client.createAudioTranscription(form);
    if (mediaType(transcriptionResponse) !== "application/json") throw new Error("asr_media_type_invalid");
    const transcription = inspectOpenAiTranscriptionJson(parseJson(
      await responseBytes(transcriptionResponse, TEXT_LIMIT),
    ));
    if (!transcription.ok || transcription.text !== "") {
      throw new Error("transcription_non_speech_invalid");
    }

    const voicesResponse = await client.listVoices(ttsModel);
    if (mediaType(voicesResponse) !== "application/json") throw new Error("tts_voices_media_type_invalid");
    const voices = voiceNames(parseJson(await responseBytes(voicesResponse, TEXT_LIMIT)));
    if (!voices.includes(ttsVoice)) throw new Error("tts_voice_not_advertised");

    const speechResponse = await client.createSpeech({
      model: ttsModel,
      input: "疎通確認です。",
      voice: ttsVoice,
      response_format: "wav",
    });
    const speechMediaType = mediaType(speechResponse);
    if (!isOpenAiSpeechMediaType(speechMediaType, "wav")) throw new Error("tts_media_type_invalid");
    const speech = await responseBytes(speechResponse, AUDIO_LIMIT);
    const durationSeconds = wavDurationSeconds(speech);

    const pcmResponse = await client.createSpeech({
      model: ttsModel,
      input: "疎通確認です。",
      voice: ttsVoice,
      response_format: "pcm",
    });
    if (!isOpenAiSpeechMediaType(pcmResponse.headers.get("content-type") ?? "", "pcm")) {
      throw new Error("tts_pcm_media_type_invalid");
    }
    if (pcmResponse.headers.get("x-audio-sample-rate") !== "24000") {
      throw new Error("tts_pcm_sample_rate_invalid");
    }
    if (pcmResponse.headers.get("x-audio-sample-format") !== "s16le") {
      throw new Error("tts_pcm_sample_format_invalid");
    }
    const pcm = await responseBytes(pcmResponse, AUDIO_LIMIT);
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) throw new Error("tts_pcm_body_invalid");
    audio = {
      asrModel,
      transcriptionValidated: true,
      ttsModel,
      mediaType: speechMediaType,
      bytes: speech.byteLength,
      durationSeconds,
    };
  }

  return {
    schemaVersion: 1,
    kind: "http-provider-canary",
    ok: true,
    desiredRelease: options.expectedReleaseCommit ?? health.releaseCommit,
    observedAt: new Date().toISOString(),
    releaseCommit: health.releaseCommit,
    configRevision: health.configRevision,
    bootEpoch: health.bootEpoch,
    model: options.model,
    jsonValidated: true,
    sse,
    audio,
  };
}

if (import.meta.main) {
  try {
    const result = await runHttpProviderLiveSmoke({
      baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
      apiToken: process.env.LARM_API_TOKEN ?? "",
      model: process.env.LARM_HTTP_MODEL ?? "coding-default",
      ...(process.env.LARM_HTTP_ASR_MODEL ? { asrModel: process.env.LARM_HTTP_ASR_MODEL } : {}),
      ...(process.env.LARM_HTTP_TTS_MODEL ? { ttsModel: process.env.LARM_HTTP_TTS_MODEL } : {}),
      ...(process.env.LARM_HTTP_TTS_VOICE ? { ttsVoice: process.env.LARM_HTTP_TTS_VOICE } : {}),
      ...(process.env.LARM_EXPECTED_RELEASE_COMMIT
        ? { expectedReleaseCommit: process.env.LARM_EXPECTED_RELEASE_COMMIT }
        : {}),
      includeAudio: process.env.LARM_HTTP_SMOKE_AUDIO !== "0",
      timeoutMs: Number(process.env.LARM_HTTP_SMOKE_TIMEOUT_MS ?? 300_000),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`HTTP Provider live smoke failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
