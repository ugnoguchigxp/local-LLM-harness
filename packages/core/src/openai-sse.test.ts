import { expect, test } from "bun:test";
import { inspectOpenAiChatCompletionSse } from "./openai-sse";

test("accepts OpenAI chat completion chunks and a terminal DONE event", () => {
  expect(inspectOpenAiChatCompletionSse([
    ": heartbeat\r\n\r\n",
    "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\r\n\r\n",
    "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"0\"},\"finish_reason\":null}]}\n\n",
    "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DONE]\n\n",
  ].join(""))).toEqual({ ok: true, chunks: 3, deltas: 1, finishReasons: 1 });
});

test("accepts an optional usage-only chunk without treating it as a delta", () => {
  expect(inspectOpenAiChatCompletionSse([
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"1\"}}]}\n\n",
    "data: {\"choices\":[],\"usage\":{\"completion_tokens\":1}}\n\n",
    "data: [DONE]\n\n",
  ].join(""))).toEqual({ ok: true, chunks: 2, deltas: 1, finishReasons: 0 });
});

test("rejects malformed, incomplete, and post-terminal streams", () => {
  expect(inspectOpenAiChatCompletionSse(new Uint8Array([0xff]))).toEqual({
    ok: false,
    reason: "invalid_utf8",
  });
  expect(inspectOpenAiChatCompletionSse("data: not-json\n\n")).toEqual({
    ok: false,
    reason: "invalid_json",
  });
  expect(inspectOpenAiChatCompletionSse("data: {\"choices\":[]}\n\ndata: [DONE]\n\n")).toEqual({
    ok: false,
    reason: "invalid_chunk",
  });
  expect(inspectOpenAiChatCompletionSse("data: {\"choices\":[{\"index\":0,\"delta\":{}}]}\n\ndata: [DONE]\n\n"))
    .toEqual({ ok: false, reason: "missing_delta" });
  expect(inspectOpenAiChatCompletionSse([
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"}}]}\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: [DONE]\n\n",
  ].join(""))).toEqual({ ok: false, reason: "missing_delta" });
  expect(inspectOpenAiChatCompletionSse("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"}}]}\n\n"))
    .toEqual({ ok: false, reason: "missing_done" });
  expect(inspectOpenAiChatCompletionSse([
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"}}]}\n\n",
    "data: [DONE]\n\n",
    "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"y\"}}]}\n\n",
  ].join(""))).toEqual({ ok: false, reason: "data_after_done" });
});
