import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadRegistry, reasoningPolicySchema, compileProviderRevision } from "@larm/core";
import { prepareLlamaChatRequest } from "./llama-chat";

const runtime = loadRegistry(join(import.meta.dir, "../../../config/local-node")).runtimes
  .find(runtime => runtime.id === "lfm25-conversation")!;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const adapt = (value: unknown) => JSON.parse(new TextDecoder().decode(prepareLlamaChatRequest(bytes(value), runtime)));

test("configured reasoning efforts produce the native budget read by the pinned engine", () => {
  for (const [effort, budget] of [["low", 64], ["medium", 256], ["high", 512], ["max", -1]] as const) {
    const body = adapt({ model: "public-alias", messages: [], reasoning_effort: effort });
    expect(body).toEqual({ model: "public-alias", messages: [], reasoning_budget_tokens: budget,
      chat_template_kwargs: { enable_thinking: true } });
    expect(body).not.toHaveProperty("reasoning_effort");
  }
  expect(adapt({ messages: [] }).reasoning_budget_tokens).toBe(256);
  expect(adapt({ messages: [], reasoning_effort: null }).reasoning_budget_tokens).toBe(256);
});

test("the experimental LFM3 uses the same effort policy and rejects backend overrides", () => {
  const lfm3 = loadRegistry(join(import.meta.dir, "../../../config/local-node")).runtimes
    .find(item => item.id === "lfm3-conversation")!;
  for (const [effort, budget] of [["low", 64], ["medium", 256], ["high", 512], ["max", -1]] as const) {
    const result = JSON.parse(new TextDecoder().decode(prepareLlamaChatRequest(bytes({ messages: [], reasoning_effort: effort }), lfm3)));
    expect(result.reasoning_budget_tokens).toBe(budget);
  }
  for (const fields of [{ max_tokens: 1, n_predict: 12 }, { reasoning_format: "none" }]) {
    expect(() => prepareLlamaChatRequest(bytes({ messages: [], ...fields }), lfm3)).toThrow();
  }
});

test("opted-in Qwen none disables template thinking without consuming a reasoning budget", () => {
  const registry = loadRegistry(join(import.meta.dir, "../../../config/local-node"));
  const qwen = registry.runtimes.find(item => item.id === "qwen38-rocmfp4-fast-conversation")!;
  const adaptQwen = (fields: Record<string, unknown>) => JSON.parse(new TextDecoder().decode(
    prepareLlamaChatRequest(bytes({ model: "public-alias", messages: [], ...fields }), qwen)));
  const result = adaptQwen({ reasoning_effort: "none", prompt_cache_key: "conversation",
    chat_template_kwargs: { preserve_thinking: false }, stream: true, max_tokens: 128 });
  expect(result).toMatchObject({ model: "public-alias", prompt_cache_key: "conversation", stream: true,
    max_tokens: 128, chat_template_kwargs: { enable_thinking: false, preserve_thinking: false },
    reasoning_budget_tokens: -1 });
  expect(result).not.toHaveProperty("reasoning_effort");
  expect(adaptQwen({}).chat_template_kwargs.enable_thinking).toBe(true);
  expect(adaptQwen({}).reasoning_budget_tokens).toBe(256);
  for (const fields of [
    { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: true } },
    { reasoning_effort: "medium", chat_template_kwargs: { enable_thinking: false } },
    { chat_template_kwargs: { enable_thinking: false } },
    { reasoning_effort: "none", reasoning_budget_tokens: 0 },
    { reasoning_effort: "none", reasoning_format: "none" },
  ]) expect(() => adaptQwen(fields)).toThrow();
  const disabled = structuredClone(qwen);
  delete disabled.reasoning!.allowNone;
  expect(() => prepareLlamaChatRequest(bytes({ messages: [], reasoning_effort: "none" }), disabled))
    .toThrow("this provider supports");
  expect(compileProviderRevision({ runtime: qwen }).revision)
    .not.toBe(compileProviderRevision({ runtime: disabled }).revision);
});

test("public callers cannot override internal budgets or disable required thinking", () => {
  for (const field of ["thinking_budget_tokens", "thinking_token_budget", "reasoning_budget_tokens", "reasoning_control"]) {
    expect(() => adapt({ messages: [], [field]: 0 })).toThrow("use reasoning_effort");
  }
  for (const effort of ["none", "minimal", "xhigh", "invalid"]) {
    expect(() => adapt({ messages: [], reasoning_effort: effort })).toThrow("this provider supports");
  }
  expect(() => adapt({ messages: [], chat_template_kwargs: { enable_thinking: false } })).toThrow("requires reasoning");
  expect(() => adapt({ messages: [], max_tokens: 1, n_predict: 12 })).toThrow("n_predict is not supported");
  expect(() => adapt({ messages: [], reasoning_format: "none" })).toThrow("reasoning_format is not supported");
});

test("JSON Schema parser compatibility is applied only without tools and without explicit choice", () => {
  const schema = { type: "json_schema", json_schema: { name: "fixture", schema: { type: "object" } } };
  expect(adapt({ messages: [], response_format: schema }).tool_choice).toBe("none");
  const tools = [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }];
  expect(adapt({ messages: [], response_format: schema, tools })).not.toHaveProperty("tool_choice");
  expect(adapt({ messages: [], response_format: schema, tool_choice: "required" }).tool_choice).toBe("required");
  expect(adapt({ messages: [] })).not.toHaveProperty("tool_choice");
});

test("other runtimes pass through and policy changes invalidate the provider revision", () => {
  const other = loadRegistry(join(import.meta.dir, "../../../config/local-node")).runtimes
    .find(runtime => runtime.id === "ornith15-strix-conversation")!;
  const body = bytes({ messages: [], reasoning_effort: "medium" });
  expect(prepareLlamaChatRequest(body, other)).toBe(body);
  const changed = structuredClone(runtime);
  changed.reasoning!.budgets.medium = 300;
  expect(compileProviderRevision({ runtime }).revision).not.toBe(compileProviderRevision({ runtime: changed }).revision);
  expect(reasoningPolicySchema.safeParse({ defaultEffort: "medium", budgets: { low: 300, medium: 64, high: 512, max: -1 } }).success).toBe(false);
});
