/** Public API canary: no backend-only reasoning parameters or backend addresses. */
export async function runLfm25ReasoningSmoke(options: {
  baseUrl: string;
  apiToken: string;
  model?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}) {
  const fetchImpl = options.fetch ?? fetch;
  const model = options.model ?? "lfm2.5-24b-a2b";
  const results = [];
  for (const effort of ["low", "medium", "high", "max"] as const) {
    const started = performance.now();
    const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model, reasoning_effort: effort,
        messages: [{ role: "user", content: 'JSONだけでcodeを文字列"ready"にしてください。' }],
        max_tokens: 4096,
        response_format: { type: "json_schema", json_schema: { name: "readiness", strict: true,
          schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } } },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await response.json() as {
      model?: string; choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
      usage?: { completion_tokens?: number }; timings?: { predicted_per_second?: number };
    };
    const choice = body.choices?.[0];
    if (!response.ok || body.model !== model || choice?.finish_reason !== "stop"
      || !choice.message?.reasoning_content?.trim() || !choice.message.content) {
      throw new Error(`reasoning ${effort} did not return a complete reasoned JSON answer (HTTP ${response.status})`);
    }
    const content = JSON.parse(choice.message.content);
    if (JSON.stringify(content) !== '{"code":"ready"}') throw new Error(`reasoning ${effort} returned unexpected JSON`);
    results.push({ effort, totalMs: performance.now() - started, completionTokens: body.usage?.completion_tokens,
      decodeTokensPerSecond: body.timings?.predicted_per_second });
  }
  return { ok: true, model, results };
}

if (import.meta.main) {
  const apiToken = process.env.LARM_API_TOKEN;
  if (!apiToken) throw new Error("LARM_API_TOKEN is required");
  console.log(JSON.stringify(await runLfm25ReasoningSmoke({ baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
    apiToken, model: process.env.LARM_REASONING_MODEL }), null, 2));
}
