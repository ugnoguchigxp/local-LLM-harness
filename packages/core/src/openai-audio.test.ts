import { expect, test } from "bun:test";
import {
  inspectOpenAiTranscriptionJson,
  isOpenAiSpeechMediaType,
} from "./openai-audio";

test("validates JSON transcription responses", () => {
  expect(inspectOpenAiTranscriptionJson({ text: "こんにちは" })).toEqual({
    ok: true,
    text: "こんにちは",
  });
  expect(inspectOpenAiTranscriptionJson({ text: "", duration: 0, segments: [] }).ok).toBe(true);
  expect(inspectOpenAiTranscriptionJson({ text: 1 }).ok).toBe(false);
  expect(inspectOpenAiTranscriptionJson({ text: "ok", duration: -1 }).ok).toBe(false);
});

test("matches speech response formats to their public media types", () => {
  expect(isOpenAiSpeechMediaType("audio/wav", "wav")).toBe(true);
  expect(isOpenAiSpeechMediaType("audio/pcm;rate=24000", "pcm")).toBe(true);
  expect(isOpenAiSpeechMediaType("audio/mpeg", "mp3")).toBe(true);
  expect(isOpenAiSpeechMediaType("application/json", "wav")).toBe(false);
  expect(isOpenAiSpeechMediaType("audio/wav")).toBe(true);
});
