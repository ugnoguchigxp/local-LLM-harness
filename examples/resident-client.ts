import { LarmClient } from "../packages/client/src/index";

const startedAt = performance.now();
const model = process.env.LARM_MODEL ?? "coding-default";
const client = new LarmClient({
  baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
  apiToken: process.env.LARM_API_TOKEN,
  timeoutMs: Number(process.env.LARM_CANARY_TIMEOUT_MS ?? 300_000),
});

let output = "";
let firstDeltaMs: number | undefined;
for await (const event of client.streamChatCompletion({
  model,
  max_tokens: 8,
  messages: [{ role: "user", content: "Reply with OK." }],
})) {
  for (const choice of event.choices) {
    const content = choice.delta.content;
    if (typeof content === "string" && content.length > 0) {
      firstDeltaMs ??= performance.now() - startedAt;
      output += content;
    }
  }
}
if (!output) throw new Error("response did not contain assistant content");

console.log(JSON.stringify({
  transport: "openai-http-sse",
  model,
  bootEpoch: client.observedBootEpoch,
  firstDeltaMs: firstDeltaMs === undefined ? null : Math.round(firstDeltaMs),
  totalMs: Math.round(performance.now() - startedAt),
}));
