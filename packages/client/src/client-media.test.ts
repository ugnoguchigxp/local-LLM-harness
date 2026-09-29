import { expect, test } from "bun:test";
import { ClientMedia } from "./client-media";
import { LarmStreamProtocolError } from "./errors";

test("media client cancels a body returned with the wrong Chat Completions stream type", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } });
  const media = new ClientMedia(async () => response);

  const consume = async () => {
    for await (const _chunk of media.streamChatCompletion({ model: "test" })) {}
  };
  await expect(consume()).rejects.toBeInstanceOf(LarmStreamProtocolError);
  expect(cancelled).toBe(true);
});

test("media client rejects a stream with no body", async () => {
  const media = new ClientMedia(async () => new Response(null, {
    headers: { "content-type": "text/event-stream" },
  }));

  const consume = async () => {
    for await (const _chunk of media.streamChatCompletion({ model: "test" })) {}
  };
  await expect(consume()).rejects.toMatchObject({ code: "stream_body_missing" });
});

test("media client cancels the upstream when a consumer stops reading a stream", async () => {
  let cancelled = false;
  const chunk = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
  };
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } });
  const media = new ClientMedia(async () => response);

  for await (const value of media.streamChatCompletion({ model: "test" })) {
    expect(value.choices[0]?.delta.content).toBe("hello");
    break;
  }
  expect(cancelled).toBe(true);
});

test("media client keeps allocation-scoped Chat, speech, transcription, and voice adapters explicit", async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const media = new ClientMedia(async (path, init) => {
    requests.push({ path, init });
    return new Response(null);
  });
  const body = { model: "test", messages: [] };

  await media.chat("alloc-a", body);
  await media.chatWithContext("alloc-a", "view-a", body, "llm.reasoning");
  await media.speech("alloc-a", { model: "voicevox-core", input: "hello" });
  await media.transcribe("alloc-a", new Blob(["audio"]));
  await media.voices("alloc-a", "speech.tts");

  expect(requests.map(({ path }) => path)).toEqual([
    "/v1/chat/completions",
    "/v1/chat/completions",
    "/v1/audio/speech",
    "/v1/audio/transcriptions",
    "/v1/audio/voices",
  ]);
  expect(new Headers(requests[0]?.init.headers).get("x-larm-allocation-id")).toBe("alloc-a");
  expect(new Headers(requests[1]?.init.headers).get("x-larm-context-view-id")).toBe("view-a");
  expect(new Headers(requests[1]?.init.headers).get("x-larm-capability")).toBe("llm.reasoning");
  expect(new Headers(requests[4]?.init.headers).get("x-larm-capability")).toBe("speech.tts");
});
