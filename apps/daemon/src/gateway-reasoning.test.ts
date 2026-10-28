import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadRegistry } from "@larm/core";
import { ExecutionGate } from "./execution-gate";
import { proxyGateway } from "./gateway";

const runtime = loadRegistry(join(import.meta.dir, "../../../config/local-node")).runtimes
  .find(runtime => runtime.id === "lfm25-conversation")!;

test("resolved gateway forwards one native budget for every public effort and rejects hidden overrides", async () => {
  for (const [effort, budget] of [[undefined, 256], ["low", 64], ["medium", 256], ["high", 512], ["max", -1], ["none", null], ["raw", null], ["n_predict", null], ["reasoning_format", null]] as const) {
    let sent: Record<string, unknown> | undefined;
    let contextPreparations = 0;
    const body = ({ model: "lfm2.5-24b-a2b", messages: [],
      ...(effort === "raw" ? { thinking_budget_tokens: 0 }
        : effort === "n_predict" ? { max_tokens: 1, n_predict: 12 }
        : effort === "reasoning_format" ? { reasoning_format: "none" }
        : effort ? { reasoning_effort: effort } : {}) });
    const request = new Request("http://localhost/v1/chat/completions", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = await proxyGateway({ request, allocationId: "test", protocol: "openai.chat-completions.v1",
      upstreamPath: "/v1/chat/completions", runtime, bodyMode: "buffered", maxBodyBytes: 4096, timeoutMs: 1000,
      chatInputWindow: { maxTokens: 131072, outputReserveTokens: 4096, safetyMarginTokens: 1976 },
      bootEpoch: "test", executionGate: new ExecutionGate(), errorFormat: "openai",
      prepareRequestBody: async bytes => {
        contextPreparations++;
        // A context view is bound to the public request, before adaptation.
        expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(body);
        return new TextEncoder().encode(JSON.stringify({ ...body,
          messages: [{ role: "user", content: "materialized context" }] }));
      },
      revalidate: () => ({ ok: true, binding: { runtime: runtime.id, endpoint: runtime.deployment.endpoint } }),
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/v1/chat/completions/input_tokens")) return Response.json({ input_tokens: 12 });
        sent = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array));
        return Response.json({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
      } });
    await response.arrayBuffer();
    expect(response.status).toBe(budget === null ? 400 : 200);
    expect(contextPreparations).toBe(budget === null ? 0 : 1);
    if (budget === null) expect(sent).toBeUndefined();
    else expect(sent).toMatchObject({ model: "lfm2.5-24b-a2b", reasoning_budget_tokens: budget,
      messages: [{ role: "user", content: "materialized context" }] });
  }
});
