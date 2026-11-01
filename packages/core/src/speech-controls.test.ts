import { expect, test } from "bun:test";
import { inspectSpeechControls, speechControlsSchema } from "./speech-controls";

const audio8 = speechControlsSchema.parse({ speed: { minimum: 1, maximum: 1, default: 1 },
  pitch_scale: { minimum: 0, maximum: 0, default: 0 }, intonation_scale: { minimum: 1, maximum: 1, default: 1 } });
const voicevox = speechControlsSchema.parse({ style: true, speed: { minimum: .5, maximum: 2, default: 1 },
  pitch_scale: { minimum: -.15, maximum: .15, default: 0 }, intonation_scale: { minimum: 0, maximum: 2, default: 1 } });
const base = { model: "any-model", input: "こんにちは" };

test("TTS controls follow the resolved provider rather than its requested model name", () => {
  expect(inspectSpeechControls(audio8, { ...base, speed: 1, pitch_scale: 0, intonation_scale: 1 })).toBeUndefined();
  expect(inspectSpeechControls(audio8, { ...base, model: "voicevox-core", pitch_scale: .03 }))
    .toMatchObject({ code: "unsupported_parameter", param: "pitch_scale" });
  expect(inspectSpeechControls(voicevox, { ...base, model: "new-name", style: 2, speed: 1.5, intonation_scale: 0 })).toBeUndefined();
  expect(inspectSpeechControls(voicevox, { ...base, speed: 2.01 })).toMatchObject({ code: "invalid_request", param: "speed" });
  expect(inspectSpeechControls(undefined, { ...base, style: "sweet" })).toMatchObject({ code: "unsupported_parameter", param: "style" });
  expect(inspectSpeechControls(undefined, { ...base, speed: 1.2 })).toBeUndefined();
  expect(inspectSpeechControls(audio8, { ...base, style: "normal" })).toMatchObject({ param: "style" });
});

test("declared control ranges cannot advertise impossible defaults", () => {
  for (const speed of [{minimum: 2, maximum: 1, default: 1}, {minimum: .5, maximum: 2, default: 3}]) {
    expect(speechControlsSchema.safeParse({ speed }).success).toBe(false);
  }
});
