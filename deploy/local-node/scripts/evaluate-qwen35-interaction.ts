import { resolve } from "node:path";
import { absoluteOutput, prepareExternalOutput, writeExclusive } from "./benchmark-helpers";

type JsonRecord = Record<string, unknown>;

const repoRoot = resolve(import.meta.dir, "../../..");
const baseUrl = requiredLoopbackUrl("QWEN35_INTERACTION_BASE_URL");
const model = requiredLabel("QWEN35_INTERACTION_MODEL");
const output = await prepareExternalOutput(
  absoluteOutput("QWEN35_INTERACTION_OUTPUT", process.env.QWEN35_INTERACTION_OUTPUT),
  repoRoot,
);
const timeoutMs = 120_000;

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "指定した都市と日付の天気予報を取得する。",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          date: { type: "string", enum: ["today", "tomorrow"] },
        },
        required: ["city", "date"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_meeting",
      description: "予定名、日付、開始時刻を指定して会議を移動する。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          date: { type: "string" },
          time: { type: "string" },
        },
        required: ["title", "date", "time"],
        additionalProperties: false,
      },
    },
  },
] as const;

const cases: JsonRecord[] = [];

const greeting = await chat({
  messages: [
    { role: "system", content: "日本語で自然かつ簡潔に応答してください。" },
    { role: "user", content: "こんばんは。今日は仕事で少し疲れました。" },
  ],
  tools,
  tool_choice: "auto",
  max_tokens: 96,
});
cases.push({
  id: "conversation-no-tool",
  passed: toolCalls(greeting.body).length === 0 && content(greeting.body).length > 0,
  latencyMs: greeting.latencyMs,
  content: content(greeting.body),
  toolCalls: toolCalls(greeting.body),
  usage: usage(greeting.body),
});

const followUp = await chat({
  messages: [
    { role: "system", content: "日本語で自然かつ簡潔に応答してください。" },
    { role: "user", content: "こんばんは。今日は仕事で少し疲れました。" },
    { role: "assistant", content: content(greeting.body) },
    { role: "user", content: "でも、任せてもらった資料は完成しました。" },
  ],
  tools,
  tool_choice: "auto",
  max_tokens: 96,
});
cases.push({
  id: "conversation-context-follow-up",
  passed: toolCalls(followUp.body).length === 0 && content(followUp.body).length > 0,
  latencyMs: followUp.latencyMs,
  content: content(followUp.body),
  toolCalls: toolCalls(followUp.body),
  usage: usage(followUp.body),
});

const weather = await chat({
  messages: [{ role: "user", content: "東京の明日の天気を調べてください。" }],
  tools,
  tool_choice: "auto",
  max_tokens: 96,
});
const weatherCall = toolCalls(weather.body)[0];
const weatherFunction = recordValue(weatherCall?.function);
const weatherArgs = parseArguments(weatherFunction?.arguments);
const weatherPassed = weatherFunction?.name === "get_weather"
  && weatherArgs?.city === "東京" && weatherArgs?.date === "tomorrow";
cases.push({
  id: "automatic-tool-selection",
  passed: weatherPassed,
  latencyMs: weather.latencyMs,
  content: content(weather.body),
  toolCalls: toolCalls(weather.body),
  usage: usage(weather.body),
});

if (weatherPassed && weatherCall) {
  const toolResult = await chat({
    messages: [
      { role: "user", content: "東京の明日の天気を調べてください。" },
      { role: "assistant", content: null, tool_calls: [weatherCall] },
      {
        role: "tool",
        tool_call_id: typeof weatherCall.id === "string" ? weatherCall.id : "weather-1",
        content: JSON.stringify({ city: "東京", date: "tomorrow", weather: "晴れ", high_c: 27 }),
      },
    ],
    tools,
    tool_choice: "auto",
    max_tokens: 128,
  });
  cases.push({
    id: "tool-result-response",
    passed: toolCalls(toolResult.body).length === 0
      && content(toolResult.body).includes("晴") && content(toolResult.body).includes("27"),
    latencyMs: toolResult.latencyMs,
    content: content(toolResult.body),
    toolCalls: toolCalls(toolResult.body),
    usage: usage(toolResult.body),
  });
}

const ambiguous = await chat({
  messages: [{ role: "user", content: "来週の定例会議を移動しておいて。" }],
  tools,
  tool_choice: "auto",
  max_tokens: 128,
});
cases.push({
  id: "missing-arguments-clarification",
  passed: toolCalls(ambiguous.body).length === 0 && content(ambiguous.body).length > 0,
  latencyMs: ambiguous.latencyMs,
  content: content(ambiguous.body),
  toolCalls: toolCalls(ambiguous.body),
  usage: usage(ambiguous.body),
});

const ttfcSamples = [];
for (let iteration = 0; iteration < 5; iteration += 1) {
  ttfcSamples.push(await streamingChat({
    messages: [{ role: "user", content: "おはよう。今日は何から始めると良さそう？短く答えて。" }],
    max_tokens: 64,
    seed: 20260924 + iteration,
  }));
}

const passed = cases.every((item) => item.passed === true);
const report = {
  schemaVersion: 1,
  kind: "qwen35-2b-conversation-and-tool-evaluation",
  recordedAt: new Date().toISOString(),
  target: { baseUrl, model },
  configuration: { temperature: 0, topP: 1, reasoning: "off", contextSize: 4096 },
  passed,
  summary: { passed: cases.filter((item) => item.passed === true).length, total: cases.length },
  cases,
  streaming: {
    samples: ttfcSamples,
    firstContentMs: summarize(ttfcSamples.map((item) => item.firstContentMs)),
    totalMs: summarize(ttfcSamples.map((item) => item.totalMs)),
  },
};
await writeExclusive(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!passed) process.exitCode = 1;

async function chat(body: JsonRecord) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, top_p: 1, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const parsed = recordValue(await response.json());
  if (!response.ok || !parsed) throw new Error(`completion returned HTTP ${response.status}`);
  return { latencyMs: round(performance.now() - started), body: parsed };
}

async function streamingChat(body: JsonRecord) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, temperature: 0, top_p: 1, stream: true, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) throw new Error(`stream returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstContentMs: number | null = null;
  let completionTokens: number | null = null;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const event = recordValue(JSON.parse(line.slice(6)));
      const choice = Array.isArray(event?.choices) ? recordValue(event.choices[0]) : undefined;
      const delta = recordValue(choice?.delta);
      if (firstContentMs === null && typeof delta?.content === "string" && delta.content.length > 0) {
        firstContentMs = round(performance.now() - started);
      }
      const eventUsage = recordValue(event?.usage);
      if (typeof eventUsage?.completion_tokens === "number") completionTokens = eventUsage.completion_tokens;
    }
  }
  return { firstContentMs, totalMs: round(performance.now() - started), completionTokens };
}

function assistantMessage(body: JsonRecord): JsonRecord {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  return recordValue(recordValue(choices[0])?.message) ?? {};
}

function content(body: JsonRecord): string {
  const value = assistantMessage(body).content;
  return typeof value === "string" ? value : "";
}

function toolCalls(body: JsonRecord): JsonRecord[] {
  const value = assistantMessage(body).tool_calls;
  return Array.isArray(value) ? value.map(recordValue).filter((item): item is JsonRecord => item !== undefined) : [];
}

function usage(body: JsonRecord): JsonRecord | null {
  return recordValue(body.usage) ?? null;
}

function parseArguments(value: unknown): JsonRecord | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function summarize(values: Array<number | null>) {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted.at(-1),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function requiredLoopbackUrl(name: string): string {
  const value = process.env[name];
  if (!value || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredLabel(name: string): string {
  const value = process.env[name];
  if (!value || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}
