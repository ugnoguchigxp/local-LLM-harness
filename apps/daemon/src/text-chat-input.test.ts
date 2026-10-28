import { expect, test } from "bun:test";
import { loadRegistry, compileProviderRevision } from "@larm/core";
import { prepareLlamaChatRequest } from "@larm/backends";
import { prepareChatInput } from "./chat-input-gateway";
const registry = loadRegistry(import.meta.dir + "/../../../config/local-node");
const runtime = registry.runtimes.find(r => r.id === "lfm25-conversation")!;
const encode = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
const request = { model: "lfm2.5-24b-a2b", messages: [{ role: "user", content: "Return OK" }], max_tokens: 512 };
const window = { maxTokens: 131072, outputReserveTokens: 4096, safetyMarginTokens: 1976 };
const defaults = { endpoint: "http://fixture", runtime: runtime.id, textInput: runtime.textInput,
  window, configRevision: "trial", bootEpoch: "epoch-trial", requestId: "test", signal: new AbortController().signal };

test("canonical LFM model uses effort settings and a text-only input contract", () => {
  expect(runtime.chatInput).toBeUndefined();
  expect(runtime.capability).not.toContain("llm.vision");
  for (const [effort, budget] of [["low",64],["medium",256],["high",512],["max",-1]] as const) {
    const body = JSON.parse(new TextDecoder().decode(prepareLlamaChatRequest(encode({ ...request, reasoning_effort: effort }), runtime)));
    expect(body.reasoning_budget_tokens).toBe(budget);
    expect(body.model).toBe(request.model);
    expect(body.reasoning_effort).toBeUndefined();
  }
  for (const extra of [{reasoning_effort:"none"}, {reasoning_budget_tokens: 0}, {chat_template_kwargs:{enable_thinking:false}}]) {
    expect(() => prepareLlamaChatRequest(encode({ ...request, ...extra }), runtime)).toThrow();
  }
  const changed = structuredClone(runtime); changed.reasoning!.budgets.medium = 300;
  expect(compileProviderRevision({ runtime }).revision).not.toBe(compileProviderRevision({ runtime: changed }).revision);
});

test("text input count uses the exact native chat parser and keeps the public count contract", async () => {
  const body = prepareLlamaChatRequest(encode(request), runtime);
  const checked = await prepareChatInput({ ...defaults, body, fetchImpl: async (url, init) => {
    expect(url).toBe("http://fixture/v1/chat/completions/input_tokens");
    expect(JSON.parse(String(init?.body)).reasoning_budget_tokens).toBe(256);
    return Response.json({ input_tokens: 37, object: "response.input_tokens" });
  } });
  expect(checked.count).toMatchObject({ contractVersion: "larm-chat-input-token-count.v1", model: request.model,
    promptTokens: 37, textTokens: 37, imageTokens: 0, imageCount: 0, maxContextTokens: 131072, fits: true });
});

test("text-only validation rejects images before contacting the engine", async () => {
  let called = false;
  await expect(prepareChatInput({ ...defaults, body: encode({ ...request, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] }),
    fetchImpl: async () => { called = true; return Response.json({input_tokens:1}); } })).rejects.toMatchObject({ code: "image_not_supported" });
  expect(called).toBe(false);
});

test("malformed native counts fail closed and over-limit requests do not fit", async () => {
  for (const input_tokens of [-1, 1.5, "12", null]) {
    await expect(prepareChatInput({ ...defaults, body: encode(request), fetchImpl: async () => Response.json({input_tokens}) })).rejects.toMatchObject({ code: "chat_token_count_unavailable" });
  }
  const result = await prepareChatInput({ ...defaults, body: encode(request), fetchImpl: async () => Response.json({input_tokens:131072}) });
  expect(result.count.fits).toBe(false);
});
