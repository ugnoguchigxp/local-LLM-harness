import { expect, test } from "bun:test";
import { consumeRetentionStream } from "./verify-prompt-cache-retention";

function response(options: { mismatch?: boolean; noDone?: boolean; noTimings?: boolean } = {}) {
  const base = { id: "synthetic", object: "chat.completion.chunk", created: 1, model: "fixture" };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: "private synthetic output" }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(!options.noTimings ? { timings: { prompt_n: 4, cache_n: 13996, prompt_ms: 25, private: "discard" } } : {}) },
    { ...base, choices: [], usage: { prompt_tokens: 14000, completion_tokens: 2, total_tokens: 14002,
      prompt_tokens_details: { cached_tokens: options.mismatch ? 0 : 13996 } } },
  ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (options.noDone ? "" : "data: [DONE]\n\n"),
    { headers: { "content-type": "text/event-stream" } });
}

test("retention E2E combines split SSE timing and usage evidence without retaining text", async () => {
  let firstTokenEvents = 0;
  const result = await consumeRetentionStream(response(), performance.now(), () => { firstTokenEvents++; });
  expect(firstTokenEvents).toBe(1);
  expect(result).toMatchObject({ prompt_n: 4, cache_n: 13996, prompt_tokens: 14000, cached_tokens: 13996, prompt_ms: 25 });
  expect(result.first_token_ms).toBeGreaterThanOrEqual(0);
  expect(result.total_ms).toBeGreaterThanOrEqual(result.first_token_ms);
  expect(JSON.stringify(result)).not.toContain("private");
});

test("inconsistent cache counters cannot pass retention acceptance", async () => {
  await expect(consumeRetentionStream(response({ mismatch: true }), performance.now())).rejects.toThrow("inconsistent cache counters");
});

test("missing timing evidence and truncated streams cannot look like cache hits", async () => {
  await expect(consumeRetentionStream(response({ noTimings: true }), performance.now())).rejects.toThrow("missing complete numeric cache evidence");
  await expect(consumeRetentionStream(response({ noDone: true }), performance.now())).rejects.toThrow("retention_stream_incomplete");
});
