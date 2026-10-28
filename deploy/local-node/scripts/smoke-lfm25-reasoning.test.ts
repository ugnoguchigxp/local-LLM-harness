import { expect, test } from "bun:test";
import { runLfm25ReasoningSmoke } from "./smoke-lfm25-reasoning";

test("reasoning canary uses only public OpenAI request fields for all requested levels", async () => {
  const efforts: string[] = [];
  const result = await runLfm25ReasoningSmoke({ baseUrl: "http://larm.test", apiToken: "test",
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      efforts.push(body.reasoning_effort);
      expect(body).not.toHaveProperty("thinking_budget_tokens");
      expect(body).not.toHaveProperty("reasoning_budget_tokens");
      expect(body).not.toHaveProperty("chat_template_kwargs");
      return Response.json({ model: body.model, choices: [{ message: { role: "assistant",
        reasoning_content: "Checking the requested literal.", content: '{"code":"ready"}' }, finish_reason: "stop" }] });
    }) });
  expect(efforts).toEqual(["low", "medium", "high", "max"]);
  expect(result.ok).toBe(true);
});

test("reasoning canary does not accept a response with no reasoning or malformed JSON", async () => {
  for (const message of [{ content: '{"code":"ready"}' }, { reasoning_content: "Checking.", content: '```json\n{}\n```' }]) {
    await expect(runLfm25ReasoningSmoke({ baseUrl: "http://larm.test", apiToken: "test",
      fetch: async () => Response.json({ model: "lfm2.5-24b-a2b", choices: [{ message, finish_reason: "stop" }] }),
    })).rejects.toThrow();
  }
});
