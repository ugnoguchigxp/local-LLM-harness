import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CONTEXT_TOKENIZER_PROBE_CORPUS, LlamaContextTokenizer } from "./context-tokenizer";

test("llama context tokenizer verifies identity and counts the rendered chat prompt", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/props") {
        return Response.json({
          build_info: "build-v1",
          chat_template: "template-v1",
          default_generation_settings: { n_ctx: 262144 },
        });
      }
      if (url.pathname === "/apply-template") {
        return Response.json({ prompt: "rendered prompt" });
      }
      if (url.pathname === "/tokenize") {
        const body = await request.json() as { content: string; with_pieces: boolean };
        return Response.json({
          tokens: [...body.content].map((_, index) => index),
          ...(body.with_pieces ? { pieces: [...body.content] } : {}),
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const endpoint = `http://127.0.0.1:${server.port}`;
    const tokenizer = new LlamaContextTokenizer();
    expect(await tokenizer.countChatTokens(endpoint, { messages: [] })).toBe(15);
    const identity = await tokenizer.identity(endpoint);
    expect(identity).toMatchObject({
      engineBuild: "build-v1",
      contextLimitTokens: 262144,
      chatTemplateDigest: createHash("sha256").update("template-v1").digest("hex"),
    });
    expect(identity.tokenizerDigest).toHaveLength(64);
    expect(CONTEXT_TOKENIZER_PROBE_CORPUS).toHaveLength(5);
  } finally {
    server.stop(true);
  }
});

test("llama context tokenizer fails closed on non-JSON responses", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("not json", { headers: { "content-type": "text/plain" } }),
  });
  try {
    await expect(new LlamaContextTokenizer().countSourceTokens(
      `http://127.0.0.1:${server.port}`,
      "source",
    )).rejects.toMatchObject({ code: "context_tokenizer_response_invalid" });
  } finally {
    server.stop(true);
  }
});
