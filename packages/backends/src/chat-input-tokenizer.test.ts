import { expect, test } from "bun:test";
import { countLlamaChatInput, validateLlamaInstructionMessages } from "./chat-input-tokenizer";

const base = { endpoint: "http://engine", signal: new AbortController().signal, requestId: "synthetic" };
const count = () => Response.json({ contractVersion: "llama-chat-token-count.v1", promptTokens: 10, textTokens: 10, imageTokens: 0, imageCount: 0, engineBuild: "fixture" });

test("probe detects omitted duplicate and empty instructions without rewriting the counted request", async () => {
  for (const content of ["", "duplicate"]) {
    const request = { messages: [{ role: "system", content }, { role: "user", content: "hi" }, { role: "system", content }], model: "fixture" };
    const original = structuredClone(request);
    let calls = 0;
    await expect(countLlamaChatInput({ ...base, request, expectedImageCount: 0, fetchImpl: async (url, init) => {
      calls++;
      expect(url).toEndWith("/apply-template");
      const probe = JSON.parse(String(init?.body));
      // The actual defective template keeps only the first instruction.
      return Response.json({ prompt: probe.messages[0].content + probe.messages[1].content });
    } })).rejects.toMatchObject({ status: 422, code: "chat_instruction_template_unsupported" });
    expect(calls).toBe(1);
    expect(request).toEqual(original);
  }
});

test("all supported instruction positions use the untouched body for exact counting", async () => {
  const request = { messages: [{ role: "system", content: "a" }, { role: "user", content: "b" },
    { role: "developer", content: [{ type: "text", text: "c" }] }, { role: "system", content: "d" }, { role: "user", content: "e" }], model: "fixture" };
  const original = structuredClone(request);
  const result = await countLlamaChatInput({ ...base, request, expectedImageCount: 0, fetchImpl: async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/apply-template")) {
      expect(body.messages.map((m: { role: string }) => m.role)).toEqual(request.messages.map(m => m.role));
      return Response.json({ prompt: JSON.stringify(body.messages) });
    }
    expect(url).toEndWith("/tokenize"); expect(body).toEqual(original);
    return count();
  } });
  expect(result.promptTokens).toBe(10); expect(request).toEqual(original);
});

test("unavailable, malformed, oversized and rejected template probes fail closed with fixed codes", async () => {
  for (const response of [new Response("private backend diagnostic", { status: 500 }), Response.json({ tokens: [] }), new Response("x".repeat(70000))]) {
    await expect(validateLlamaInstructionMessages({ ...base, request: { messages: [{ role: "system", content: "synthetic" }] },
      fetchImpl: async () => response })).rejects.toMatchObject({ status: 503, code: "chat_template_validation_unavailable" });
  }
  await expect(validateLlamaInstructionMessages({ ...base, request: { messages: [{ role: "system", content: "synthetic" }] },
    fetchImpl: async () => new Response("private diagnostic", { status: 400 }) })).rejects.toMatchObject({ status: 422, code: "chat_instruction_template_unsupported" });
});

test("no instruction messages need no template probe", async () => {
  const urls: string[] = [];
  await countLlamaChatInput({ ...base, request: { messages: [{ role: "user", content: "hi" }] }, expectedImageCount: 0,
    fetchImpl: async url => { urls.push(url); return count(); } });
  expect(urls).toEqual(["http://engine/tokenize"]);
});
