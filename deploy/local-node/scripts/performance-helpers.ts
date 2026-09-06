import { OpenAiChatCompletionSseInspector } from "../../../packages/core/src/index";

export type MetricSummary = {
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
};

export type TimedBody = {
  firstByteMs: number;
  totalMs: number;
  responseBytes: number;
};

export type LlmPerformance = TimedBody & {
  firstTokenMs: number;
  completionTokens: number;
  completionTokenSource: "usage" | "content-events";
  outputTokensPerSecond: number;
};

export type AudioPerformance = TimedBody & {
  firstPlayableAudioMs: number;
  audioSeconds: number;
  realtimeFactor: number;
  audioSecondsPerSecond: number;
  audio: Uint8Array;
};

const MAX_TEXT_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_RESPONSE_BYTES = 256 * 1024 * 1024;

export function summarize(values: number[]): MetricSummary | null {
  if (values.length === 0) return null;
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("performance metrics must be finite");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ]!;
  return {
    min: round(sorted[0]!),
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    max: round(sorted.at(-1)!),
    mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

export function degradationPercent(
  standalone: number | undefined,
  mixed: number | undefined,
  lowerIsBetter: boolean,
): number | null {
  if (standalone === undefined || mixed === undefined || standalone <= 0 || mixed < 0) return null;
  const ratio = mixed / standalone;
  return round((lowerIsBetter ? ratio - 1 : 1 - ratio) * 100);
}

export function wavDurationSeconds(bytes: Uint8Array): number {
  if (bytes.byteLength < 44 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("audio_fixture_wav_invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.byteLength) throw new Error("audio_fixture_wav_invalid");
    if (id === "fmt ") {
      if (size < 16) throw new Error("audio_fixture_wav_invalid");
      byteRate = view.getUint32(start + 8, true);
    } else if (id === "data") {
      dataBytes = size;
    }
    if (byteRate !== undefined && dataBytes !== undefined) break;
    offset = end + (size % 2);
  }
  if (!byteRate || dataBytes === undefined || dataBytes === 0) {
    throw new Error("audio_fixture_wav_invalid");
  }
  const duration = dataBytes / byteRate;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("audio_fixture_wav_invalid");
  return duration;
}

export async function consumeLlmPerformanceResponse(
  response: Response,
  requestStarted: number,
  now: () => number = () => performance.now(),
): Promise<LlmPerformance> {
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    throw new Error("llm_content_type_invalid");
  }
  const body = await readBody(response, MAX_TEXT_RESPONSE_BYTES, requestStarted, now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
  } catch {
    throw new Error("llm_response_invalid");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) throw new Error("llm_response_invalid");
  const content = parsed.choices.flatMap((choice) => {
    if (!isRecord(choice) || !isRecord(choice.message)) return [];
    const message = choice.message;
    return ["content", "reasoning_content", "reasoning"].flatMap((key) => {
      const value = message[key];
      return typeof value === "string" && value.length > 0 ? [value] : [];
    });
  }).join("");
  if (!content) throw new Error("llm_response_empty");
  const usage = parsed.usage;
  const completionTokens = isRecord(usage)
    && Number.isInteger(usage.completion_tokens)
    && Number(usage.completion_tokens) > 0
    ? Number(usage.completion_tokens)
    : undefined;
  const tokens = completionTokens ?? Math.max(1, content.trim().split(/\s+/u).length);
  const elapsedSeconds = Math.max(body.timing.totalMs / 1_000, 0.001);
  return {
    ...body.timing,
    firstTokenMs: body.timing.totalMs,
    completionTokens: tokens,
    completionTokenSource: completionTokens === undefined ? "content-events" : "usage",
    outputTokensPerSecond: round(tokens / elapsedSeconds),
  };
}

export async function consumeLlmSsePerformanceResponse(
  response: Response,
  requestStarted: number,
  now: () => number = () => performance.now(),
): Promise<LlmPerformance & { deltaEvents: number }> {
  if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
    throw new Error("llm_sse_content_type_invalid");
  }
  if (!response.ok) throw new Error(`http_${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response_body_missing");
  const inspector = new OpenAiChatCompletionSseInspector();
  let firstByteAt: number | undefined;
  let firstTokenAt: number | undefined;
  let lastByteAt: number | undefined;
  let previousDeltas = 0;
  let responseBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value.byteLength === 0) continue;
    const receivedAt = now();
    firstByteAt ??= receivedAt;
    lastByteAt = receivedAt;
    responseBytes += chunk.value.byteLength;
    if (responseBytes > MAX_TEXT_RESPONSE_BYTES) {
      await reader.cancel(new Error("response_too_large")).catch(() => undefined);
      throw new Error("response_too_large");
    }
    const progress = inspector.push(chunk.value);
    if (!progress.ok) {
      await reader.cancel(new Error(progress.reason)).catch(() => undefined);
      throw new Error(`llm_sse_${progress.reason}`);
    }
    if (progress.deltas > previousDeltas) firstTokenAt ??= receivedAt;
    previousDeltas = progress.deltas;
  }
  const inspected = inspector.finish();
  if (!inspected.ok) throw new Error(`llm_sse_${inspected.reason}`);
  if (firstByteAt === undefined || firstTokenAt === undefined || lastByteAt === undefined) {
    throw new Error("empty_response");
  }
  const totalMs = round(lastByteAt - requestStarted);
  const completionTokens = inspector.getCompletionTokens() ?? inspected.deltas;
  return {
    firstByteMs: round(firstByteAt - requestStarted),
    firstTokenMs: round(firstTokenAt - requestStarted),
    totalMs,
    responseBytes,
    completionTokens,
    completionTokenSource: inspector.getCompletionTokens() === undefined ? "content-events" : "usage",
    outputTokensPerSecond: round(completionTokens / Math.max(totalMs / 1_000, 0.001)),
    deltaEvents: inspected.deltas,
  };
}

export async function consumeAsrPerformanceResponse(
  response: Response,
  requestStarted: number,
  audioSeconds: number,
  now: () => number = () => performance.now(),
): Promise<TimedBody & { audioSeconds: number; realtimeFactor: number; audioSecondsPerSecond: number }> {
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    throw new Error("asr_content_type_invalid");
  }
  const body = await readBody(response, MAX_TEXT_RESPONSE_BYTES, requestStarted, now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
  } catch {
    throw new Error("asr_response_invalid");
  }
  if (!isRecord(parsed) || typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
    throw new Error("asr_response_invalid");
  }
  return {
    ...body.timing,
    audioSeconds: round(audioSeconds),
    realtimeFactor: round(body.timing.totalMs / (audioSeconds * 1_000)),
    audioSecondsPerSecond: round(audioSeconds / (body.timing.totalMs / 1_000)),
  };
}

export async function consumeTtsPerformanceResponse(
  response: Response,
  requestStarted: number,
  now: () => number = () => performance.now(),
): Promise<AudioPerformance> {
  if (!response.headers.get("content-type")?.startsWith("audio/")) {
    throw new Error("tts_content_type_invalid");
  }
  if (!response.headers.has("x-voicevox-credit")) throw new Error("tts_credit_missing");
  const body = await readWavBody(response, MAX_AUDIO_RESPONSE_BYTES, requestStarted, now);
  const audioSeconds = wavDurationSeconds(body.bytes);
  return {
    ...body.timing,
    firstPlayableAudioMs: body.firstPlayableAudioMs,
    audioSeconds: round(audioSeconds),
    realtimeFactor: round(body.timing.totalMs / (audioSeconds * 1_000)),
    audioSecondsPerSecond: round(audioSeconds / (body.timing.totalMs / 1_000)),
    audio: body.bytes,
  };
}

async function readWavBody(
  response: Response,
  maximumBytes: number,
  requestStarted: number,
  now: () => number,
): Promise<{ timing: TimedBody; firstPlayableAudioMs: number; bytes: Uint8Array }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response_body_missing");
  let firstByteAt: number | undefined;
  let firstPlayableAt: number | undefined;
  let lastByteAt: number | undefined;
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value.byteLength === 0) continue;
    const receivedAt = now();
    firstByteAt ??= receivedAt;
    lastByteAt = receivedAt;
    size += chunk.value.byteLength;
    if (size > maximumBytes) throw new Error("response_too_large");
    chunks.push(chunk.value);
    if (firstPlayableAt === undefined && size <= 1024 * 1024) {
      const prefix = concatenate(chunks, size);
      if (hasPlayableWavPrefix(prefix)) firstPlayableAt = receivedAt;
    }
  }
  if (!response.ok) throw new Error(`http_${response.status}`);
  if (firstByteAt === undefined || lastByteAt === undefined || size === 0) throw new Error("empty_response");
  const bytes = concatenate(chunks, size);
  wavDurationSeconds(bytes);
  firstPlayableAt ??= lastByteAt;
  return {
    timing: {
      firstByteMs: round(firstByteAt - requestStarted),
      totalMs: round(lastByteAt - requestStarted),
      responseBytes: size,
    },
    firstPlayableAudioMs: round(firstPlayableAt - requestStarted),
    bytes,
  };
}

function hasPlayableWavPrefix(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset + 4, true);
    if (ascii(bytes, offset, 4) === "data") return size > 0 && bytes.byteLength > offset + 8;
    offset += 8 + size + (size % 2);
  }
  return false;
}

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBody(
  response: Response,
  maximumBytes: number,
  requestStarted: number,
  now: () => number,
): Promise<{ timing: TimedBody; bytes: Uint8Array }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response_body_missing");
  let firstByteAt: number | undefined;
  let lastByteAt: number | undefined;
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value.byteLength === 0) continue;
    const receivedAt = now();
    firstByteAt ??= receivedAt;
    lastByteAt = receivedAt;
    size += chunk.value.byteLength;
    if (size > maximumBytes) throw new Error("response_too_large");
    chunks.push(chunk.value);
  }
  if (!response.ok) throw new Error(`http_${response.status}`);
  if (firstByteAt === undefined || lastByteAt === undefined || size === 0) {
    throw new Error("empty_response");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    timing: {
      firstByteMs: round(firstByteAt - requestStarted),
      totalMs: round(lastByteAt - requestStarted),
      responseBytes: size,
    },
    bytes,
  };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
