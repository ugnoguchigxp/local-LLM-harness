import { readFile } from "node:fs/promises";
import { LarmClient } from "../packages/client/src/index";
import { inspectOpenAiTranscriptionJson } from "../packages/core/src/index";

const audioPath = process.env.LARM_CANARY_AUDIO_FILE;
if (!audioPath) throw new Error("LARM_CANARY_AUDIO_FILE is required");
const asrModel = process.env.LARM_ASR_MODEL ?? "qwen3-asr-1.7b";
const llmModel = process.env.LARM_MODEL ?? "coding-default";
const ttsModel = process.env.LARM_TTS_MODEL ?? "voicevox-core";
const client = new LarmClient({
  baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
  apiToken: process.env.LARM_API_TOKEN,
});

const startedAt = performance.now();
const form = new FormData();
form.set("model", asrModel);
form.set("response_format", "json");
form.set("file", new Blob([await readFile(audioPath)], { type: "audio/wav" }), "sample.wav");
const transcription = inspectOpenAiTranscriptionJson(
  await (await client.createAudioTranscription(form)).json(),
);
if (!transcription.ok) throw new Error("transcription response violated the public contract");
const asrCompletedMs = performance.now() - startedAt;

type SpeechMetric = { sequence: number; requestStartedMs: number; completedMs: number; bytes: number };
const speechMetrics: SpeechMetric[] = [];
let speechQueue = Promise.resolve();
let sequence = 0;
let firstSpeechStartedMs: number | undefined;
const enqueueSpeech = (input: string) => {
  const current = ++sequence;
  speechQueue = speechQueue.then(async () => {
    const requestStartedMs = performance.now() - startedAt;
    firstSpeechStartedMs ??= requestStartedMs;
    const response = await client.createSpeech({
      model: ttsModel,
      input,
      voice: process.env.LARM_TTS_VOICE ?? "Kasukabe_Tsumugi",
      response_format: "wav",
    });
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("audio/")) {
      await response.body?.cancel(new Error("speech response is not audio")).catch(() => undefined);
      throw new Error("speech response violated the public contract");
    }
    const bytes = (await response.arrayBuffer()).byteLength;
    speechMetrics.push({
      sequence: current,
      requestStartedMs: Math.round(requestStartedMs),
      completedMs: Math.round(performance.now() - startedAt),
      bytes,
    });
  });
};

function completePhrases(value: string): { phrases: string[]; remainder: string } {
  const phrases: string[] = [];
  let offset = 0;
  const endings = /[。！？!?](?:[」』】）)]|\s)*/gu;
  for (const match of value.matchAll(endings)) {
    const end = match.index + match[0].length;
    const phrase = value.slice(offset, end).trim();
    if (phrase) phrases.push(phrase);
    offset = end;
  }
  return { phrases, remainder: value.slice(offset) };
}

let pendingText = "";
let firstLlmDeltaMs: number | undefined;
for await (const event of client.streamChatCompletion({
  model: llmModel,
  messages: [{ role: "user", content: transcription.text }],
  stream_options: { include_usage: true },
})) {
  for (const choice of event.choices) {
    const content = choice.delta.content;
    if (typeof content !== "string" || content.length === 0) continue;
    firstLlmDeltaMs ??= performance.now() - startedAt;
    pendingText += content;
    const segmented = completePhrases(pendingText);
    pendingText = segmented.remainder;
    for (const phrase of segmented.phrases) enqueueSpeech(phrase);
  }
}
if (pendingText.trim()) enqueueSpeech(pendingText.trim());
await speechQueue;

console.log(JSON.stringify({
  transport: "openai-http-sse",
  models: { asr: asrModel, llm: llmModel, tts: ttsModel },
  asrCompletedMs: Math.round(asrCompletedMs),
  firstLlmDeltaMs: firstLlmDeltaMs === undefined ? null : Math.round(firstLlmDeltaMs),
  firstSpeechStartedMs: firstSpeechStartedMs === undefined ? null : Math.round(firstSpeechStartedMs),
  speechSegments: speechMetrics,
  totalMs: Math.round(performance.now() - startedAt),
}));
