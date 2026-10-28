import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadRegistry, compileProviderRevision } from "@larm/core";
import { prepareLlamaChatRequest } from "./llama-chat";
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test("STRIX explicitly permits none and keeps other runtime contracts", () => {
  const qwen = loadRegistry(join(import.meta.dir, "../../../config/local-node")).runtimes
    .find(item => item.id === "qwen38-rocmfp4-strix-conversation")!;
  const input = { model: "qwen3.8-27b-rocmfp4-strix", messages: [], reasoning_effort: "none", prompt_cache_key: "none-case" };
  const result = JSON.parse(new TextDecoder().decode(prepareLlamaChatRequest(bytes(input), qwen)));
  expect(result).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, reasoning_budget_tokens: -1,
    prompt_cache_key: "none-case" });
  expect(result).not.toHaveProperty("reasoning_effort");
  expect(() => prepareLlamaChatRequest(bytes({ ...input, chat_template_kwargs: { enable_thinking: true } }), qwen)).toThrow("conflicts");
  expect(() => prepareLlamaChatRequest(bytes({ ...input, reasoning_budget_tokens: 0 }), qwen)).toThrow("use reasoning_effort");
  const optOut = structuredClone(qwen);
  delete optOut.reasoning!.allowNone;
  expect(() => prepareLlamaChatRequest(bytes(input), optOut)).toThrow("supports");
  expect(compileProviderRevision({ runtime: qwen }).revision).not.toBe(compileProviderRevision({ runtime: optOut }).revision);
});
