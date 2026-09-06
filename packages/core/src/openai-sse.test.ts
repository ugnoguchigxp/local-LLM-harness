import { expect, test } from "bun:test";
import {
  inspectOpenAiChatCompletionSse,
  OpenAiChatCompletionSseInspector,
} from "./openai-sse";

const metadata = {
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 1,
  model: "test-model",
};

function event(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ ...metadata, ...value })}\n\n`;
}

const successfulInspection = {
  ok: true as const,
  id: "chatcmpl-test",
  model: "test-model",
  chunks: 3,
  deltas: 1,
  finishReasons: 1,
};

test("accepts OpenAI chat completion chunks and a terminal DONE event", () => {
  expect(inspectOpenAiChatCompletionSse([
    ": heartbeat\r\n\r\n",
    event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
    event({ choices: [{ index: 0, delta: { content: "0" }, finish_reason: null }] }),
    event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ].join(""))).toEqual(successfulInspection);
});

test("accepts an optional usage-only chunk without treating it as a delta", () => {
  expect(inspectOpenAiChatCompletionSse([
    event({ choices: [{ index: 0, delta: { content: "1" }, finish_reason: null }] }),
    event({ choices: [], usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 } }),
    event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ].join(""))).toEqual(successfulInspection);
});

test("accepts schema roles and recognized reasoning and tool deltas", () => {
  expect(inspectOpenAiChatCompletionSse([
    event({ choices: [{
      index: 0,
      delta: { role: "developer", reasoning_content: "think" },
      finish_reason: null,
    }] }),
    event({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call-1", type: "function" }] },
        finish_reason: null,
      }],
    }),
    event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ].join(""))).toEqual({ ...successfulInspection, deltas: 2 });
});

test("incrementally validates arbitrary UTF-8 and CRLF chunk boundaries", () => {
  const source = [
    event({ choices: [{ index: 0, delta: { content: "こんにちは" }, finish_reason: null }] }),
    event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ].join("").replaceAll("\n", "\r\n");
  const bytes = new TextEncoder().encode(source);
  const inspector = new OpenAiChatCompletionSseInspector();
  let sawMeaningfulDelta = false;
  for (let index = 0; index < bytes.length; index += 1) {
    const progress = inspector.push(bytes.subarray(index, index + 1));
    expect(progress.ok).toBeTrue();
    if (progress.ok && progress.deltas > 0) sawMeaningfulDelta = true;
  }
  expect(sawMeaningfulDelta).toBeTrue();
  expect(inspector.finish()).toEqual({
    ...successfulInspection,
    chunks: 2,
  });
});

test("incremental validation rejects an incomplete EOF", () => {
  const inspector = new OpenAiChatCompletionSseInspector();
  expect(inspector.push(event({
    choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
  }))).toEqual(expect.objectContaining({ ok: true, deltas: 1 }));
  expect(inspector.finish()).toEqual({ ok: false, reason: "missing_done" });
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
  expect(inspectOpenAiChatCompletionSse(event({ choices: [] }) + "data: [DONE]\n\n")).toEqual({
    ok: false,
    reason: "invalid_chunk",
  });
  expect(inspectOpenAiChatCompletionSse(
    event({ choices: [{ index: 0, delta: {}, finish_reason: null }] }) + "data: [DONE]\n\n",
  )).toEqual({ ok: false, reason: "missing_delta" });
  expect(inspectOpenAiChatCompletionSse([
    event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }),
    event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ].join(""))).toEqual({ ok: false, reason: "missing_delta" });
  expect(inspectOpenAiChatCompletionSse([
    event({ choices: [{ index: 0, delta: { unknown: true, function_call: {} }, finish_reason: null }] }),
    "data: [DONE]\n\n",
  ].join(""))).toEqual({ ok: false, reason: "missing_delta" });
  expect(inspectOpenAiChatCompletionSse([
    event({ choices: [{ index: 0, delta: { tool_calls: [{}] } }] }),
    "data: [DONE]\n\n",
  ].join(""))).toEqual({ ok: false, reason: "invalid_chunk" });
  expect(inspectOpenAiChatCompletionSse(
    event({ choices: [{ index: 0, delta: { content: 12 } }] }) + "data: [DONE]\n\n",
  )).toEqual({ ok: false, reason: "invalid_chunk" });
  expect(inspectOpenAiChatCompletionSse(
    event({ choices: [{ index: -1, delta: { content: "x" } }] }) + "data: [DONE]\n\n",
  )).toEqual({ ok: false, reason: "invalid_chunk" });
  expect(inspectOpenAiChatCompletionSse(
    event({ choices: [
      { index: 0, delta: { content: "x" }, finish_reason: null },
      { index: 0, delta: { content: "y" }, finish_reason: null },
    ] }) + "data: [DONE]\n\n",
  )).toEqual({ ok: false, reason: "invalid_chunk" });
  expect(inspectOpenAiChatCompletionSse(
    event({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] }),
  )).toEqual({ ok: false, reason: "missing_done" });
  expect(inspectOpenAiChatCompletionSse([
    event({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] }),
    "data: [DONE]\n\n",
  ].join(""))).toEqual({ ok: false, reason: "missing_finish" });
  expect(inspectOpenAiChatCompletionSse([
    event({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] }),
    event({ id: "chatcmpl-drift", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ].join(""))).toEqual({ ok: false, reason: "invalid_chunk" });
  expect(inspectOpenAiChatCompletionSse([
    event({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }),
    event({ choices: [{ index: 0, delta: { content: "y" }, finish_reason: null }] }),
    "data: [DONE]\n\n",
  ].join(""))).toEqual({ ok: false, reason: "invalid_chunk" });
  expect(inspectOpenAiChatCompletionSse([
    event({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }] }),
    "data: [DONE]\n\n",
    event({ choices: [{ index: 0, delta: { content: "y" }, finish_reason: null }] }),
  ].join(""))).toEqual({ ok: false, reason: "data_after_done" });
});
