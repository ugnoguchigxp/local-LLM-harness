import { expect, test } from "bun:test";
import { inspectOpenAiChatCompletionJson } from "./openai-json";

const valid = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "test-model",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "OK" },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

test("accepts a complete OpenAI JSON chat completion", () => {
  expect(inspectOpenAiChatCompletionJson(valid)).toEqual({
    ok: true,
    id: "chatcmpl-test",
    model: "test-model",
    choices: 1,
    textChoices: 1,
    completionTokens: 1,
  });
});

test("accepts a current custom tool-call completion without reporting text", () => {
  expect(inspectOpenAiChatCompletionJson({
    ...valid,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call-test",
          type: "custom",
          custom: { name: "shell", input: "pwd" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  })).toMatchObject({ ok: true, textChoices: 0 });
});

test("rejects incomplete metadata and malformed choices while reporting empty text", () => {
  expect(inspectOpenAiChatCompletionJson({ ...valid, object: undefined })).toEqual({
    ok: false,
    reason: "invalid_completion",
  });
  expect(inspectOpenAiChatCompletionJson({
    ...valid,
    choices: [{ ...valid.choices[0], finish_reason: null }],
  })).toEqual({ ok: false, reason: "invalid_choice" });
  expect(inspectOpenAiChatCompletionJson({
    ...valid,
    choices: [{ ...valid.choices[0], message: { role: "user", content: "OK" } }],
  })).toEqual({ ok: false, reason: "invalid_message" });
  expect(inspectOpenAiChatCompletionJson({
    ...valid,
    choices: [{ ...valid.choices[0], message: { role: "assistant", content: "" } }],
  })).toMatchObject({ ok: true, textChoices: 0 });
  expect(inspectOpenAiChatCompletionJson({
    ...valid,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
  })).toEqual({ ok: false, reason: "invalid_completion" });
  expect(inspectOpenAiChatCompletionJson({
    ...valid,
    choices: [{ ...valid.choices[0], index: 1 }],
  })).toEqual({ ok: false, reason: "invalid_choice" });
});
