import { expect, test } from "bun:test";
import { fetchSpeech, type Profile } from "../src/bench";

const profile: Profile = {
  id: "mock", backend: "mock", device: "cpu", precision: "fp32", url: "http://mock/v1/audio/speech",
  model: "mock", responseFormat: "wav", nativeStreaming: false,
};

test("HTTP measurement rejects a missing body", async () => {
  const mock = (async () => new Response(null, { status: 200, headers: { "content-type": "audio/wav" } })) as unknown as typeof fetch;
  await expect(fetchSpeech(profile, "test", 1, 1_000, mock)).rejects.toThrow("response_body_missing");
});

test("HTTP measurement records bytes and measurement points", async () => {
  const body = new Uint8Array(48);
  const mock = (async () => new Response(body, { status: 200, headers: { "content-type": "audio/wav" } })) as unknown as typeof fetch;
  const result = await fetchSpeech(profile, "test", 1, 1_000, mock);
  expect(result.status).toBe(200);
  expect(result.bytes.length).toBe(48);
  expect(result.firstAudioReadyMs).toBeGreaterThanOrEqual(result.firstResponseByteMs);
  expect(result.generationCompleteMs).toBeGreaterThanOrEqual(result.firstAudioReadyMs);
});
