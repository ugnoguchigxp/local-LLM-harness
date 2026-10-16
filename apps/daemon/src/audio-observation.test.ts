import { expect, test } from "bun:test";
import { AudioObservation } from "./audio-observation";

function wav(): Uint8Array {
  const bytes = new Uint8Array(64);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 16, true); view.setUint32(28, 10, true); view.setUint32(40, 20, true);
  return bytes;
}

test("fragmented WAV observes first playable bytes and only complete duration", () => {
  const bytes = wav(); const audio = new AudioObservation();
  expect(audio.push(bytes.subarray(0, 20))).toBe(false);
  expect(audio.push(bytes.subarray(20, 44))).toBe(false);
  expect(audio.durationSeconds()).toBeUndefined();
  expect(audio.push(bytes.subarray(44, 50))).toBe(true);
  expect(audio.durationSeconds()).toBeUndefined();
  audio.push(bytes.subarray(50));
  expect(audio.durationSeconds()).toBe(2);
});

test("unknown formats, truncated or oversized headers do not invent duration", () => {
  for (const bytes of [new Uint8Array(100000), wav().subarray(0, 50)]) {
    const audio = new AudioObservation(); audio.push(bytes);
    expect(audio.durationSeconds()).toBeUndefined();
  }
});
