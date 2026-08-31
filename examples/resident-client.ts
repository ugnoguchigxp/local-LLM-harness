import { LarmClient } from "../packages/client/src/index";

const startedAt = performance.now();
const client = new LarmClient({
  baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
  apiToken: process.env.LARM_API_TOKEN,
  timeoutMs: Number(process.env.LARM_CANARY_TIMEOUT_MS ?? 300_000),
});

const result = await client.withAllocation({
  requirements: [{ capability: "llm.general", route: "llm-default" }],
  allowFallback: false,
  deploymentPolicy: "existing-only",
  ttlSeconds: 120,
}, async (allocation, larm) => {
  const response = await larm.chat(allocation.id, {
    model: "larm",
    stream: false,
    max_tokens: 8,
    messages: [{ role: "user", content: "Reply with OK." }],
  });
  if (!response.ok) throw new Error(`chat request failed with HTTP ${response.status}`);
  const output = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  if (!output.choices?.some((choice) => (choice.message?.content?.length ?? 0) > 0)) {
    throw new Error("response did not contain assistant content");
  }
  return {
    allocation: allocation.id,
    catalogRevision: allocation.catalogRevision,
    bindings: allocation.bindings.map(({ capability, route, runtime, release, fallback }) => ({
      capability,
      route,
      runtime,
      release,
      fallback,
    })),
  };
});

console.log(JSON.stringify({
  ...result,
  bootEpoch: client.observedBootEpoch,
  totalMs: Math.round(performance.now() - startedAt),
}));
