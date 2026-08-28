import { LarmClient } from "../packages/client/src/index";

const startedAt = performance.now();
let firstByteAt: number | undefined;
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
    stream: true,
    max_tokens: 8,
    messages: [{ role: "user", content: "Reply with OK." }],
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("streaming response body is missing");
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    firstByteAt ??= performance.now();
    output += decoder.decode(chunk.value, { stream: true });
  }
  output += decoder.decode();
  if (!output.includes("data: ") || !output.includes("data: [DONE]")) {
    throw new Error("stream did not contain data and completion markers");
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
  ttfbMs: firstByteAt === undefined ? null : Math.round(firstByteAt - startedAt),
  totalMs: Math.round(performance.now() - startedAt),
}));
