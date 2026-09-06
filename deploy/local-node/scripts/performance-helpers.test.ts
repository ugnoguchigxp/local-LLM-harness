import { expect, test } from "bun:test";
import {
  consumeAsrPerformanceResponse,
  consumeLlmPerformanceResponse,
  consumeLlmSsePerformanceResponse,
  consumeTtsPerformanceResponse,
  degradationPercent,
  summarize,
  wavDurationSeconds,
} from "./performance-helpers";

function wav(seconds = 1, sampleRate = 16_000): Uint8Array {
  const dataBytes = Math.round(seconds * sampleRate) * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}

test("summarizes latency and computes degradation in the correct direction", () => {
  expect(summarize([40, 10, 30, 20])).toEqual({ min: 10, p50: 20, p95: 40, max: 40, mean: 25 });
  expect(degradationPercent(100, 125, true)).toBe(25);
  expect(degradationPercent(20, 15, false)).toBe(25);
});

test("parses WAV duration and rejects malformed audio", () => {
  expect(wavDurationSeconds(wav(1.5))).toBe(1.5);
  expect(() => wavDurationSeconds(new Uint8Array(44))).toThrow("audio_fixture_wav_invalid");
});

test("measures validated LLM, ASR, and TTS responses", async () => {
  const times = [110, 120];
  const llm = await consumeLlmPerformanceResponse(new Response(
    '{"choices":[{"message":{"content":"PERFORMANCE"}}],"usage":{"completion_tokens":8}}',
    { headers: { "content-type": "application/json" } },
  ), 100, () => times.shift() ?? 120);
  expect(llm).toMatchObject({ firstByteMs: 10, firstTokenMs: 10, completionTokens: 8, completionTokenSource: "usage" });

  const metadata = {
    id: "chatcmpl-performance",
    object: "chat.completion.chunk",
    created: 1,
    model: "coding-default",
  };
  const sseEvents = [
    `data: ${JSON.stringify({ ...metadata, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...metadata, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...metadata, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    `data: ${JSON.stringify({ ...metadata, choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\n`,
    "data: [DONE]\n\n",
  ];
  let eventIndex = 0;
  const sse = await consumeLlmSsePerformanceResponse(new Response(new ReadableStream({
    pull(controller) {
      const value = sseEvents[eventIndex++];
      if (value === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(value));
    },
  }), { headers: { "content-type": "text/event-stream" } }), 100, () => 110 + eventIndex * 10);
  expect(sse).toMatchObject({
    firstByteMs: 20,
    firstTokenMs: 30,
    completionTokens: 1,
    completionTokenSource: "usage",
    deltaEvents: 1,
  });

  const asr = await consumeAsrPerformanceResponse(new Response('{"text":"性能テスト"}', {
    headers: { "content-type": "application/json" },
  }), 100, 2, () => 200);
  expect(asr).toMatchObject({ totalMs: 100, realtimeFactor: 0.05, audioSecondsPerSecond: 20 });

  const tts = await consumeTtsPerformanceResponse(new Response(wav(2), {
    headers: { "content-type": "audio/wav", "x-voicevox-credit": "VOICEVOX" },
  }), 100, () => 300);
  expect(tts).toMatchObject({
    totalMs: 200,
    firstPlayableAudioMs: 200,
    audioSeconds: 2,
    realtimeFactor: 0.1,
    audioSecondsPerSecond: 10,
  });
});

test("rejects malformed LLM and responses that could not be evaluated", async () => {
  await expect(consumeLlmPerformanceResponse(new Response(
    '{"choices":[]}',
    { headers: { "content-type": "application/json" } },
  ), 0)).rejects.toThrow("llm_response_empty");
  await expect(consumeAsrPerformanceResponse(new Response('{"text":""}', {
    headers: { "content-type": "application/json" },
  }), 0, 1)).rejects.toThrow("asr_response_invalid");
  await expect(consumeTtsPerformanceResponse(new Response(wav(), {
    headers: { "content-type": "audio/wav" },
  }), 0)).rejects.toThrow("tts_credit_missing");
});
