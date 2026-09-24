import { resolve } from "node:path";
import { absoluteOutput, prepareExternalOutput, writeExclusive } from "./benchmark-helpers";

type JsonRecord = Record<string, unknown>;
type ThinkingMode = "auto" | "off";

const repoRoot = resolve(import.meta.dir, "../../..");
const baseUrl = requiredLoopbackUrl("TTFC_EVAL_BASE_URL");
const label = requiredLabel("TTFC_EVAL_LABEL");
const mode = thinkingMode(process.env.TTFC_EVAL_THINKING ?? "auto");
const iterations = boundedInteger("TTFC_EVAL_ITERATIONS", 3, 1, 20);
const maxTokens = boundedInteger("TTFC_EVAL_MAX_TOKENS", 512, 32, 2_048);
const timeoutMs = boundedInteger("TTFC_EVAL_TIMEOUT_MS", 300_000, 10_000, 900_000);
const output = await prepareExternalOutput(
  absoluteOutput("TTFC_EVAL_OUTPUT", process.env.TTFC_EVAL_OUTPUT),
  repoRoot,
);

await streamCompletion(0, 32);
const samples = [];
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  samples.push(await streamCompletion(iteration, maxTokens));
}

const report = {
  schemaVersion: 1,
  kind: "streaming-time-to-first-character",
  recordedAt: new Date().toISOString(),
  target: { baseUrl, label },
  configuration: { mode, iterations, maxTokens, timeoutMs, temperature: 0 },
  aggregate: {
    firstSseMs: summarize(samples.map((sample) => sample.firstSseMs)),
    firstReasoningCharacterMs: summarize(
      samples.map((sample) => sample.firstReasoningCharacterMs),
    ),
    firstContentCharacterMs: summarize(samples.map((sample) => sample.firstContentCharacterMs)),
    firstAnyTextCharacterMs: summarize(samples.map((sample) => sample.firstAnyTextCharacterMs)),
    totalMs: summarize(samples.map((sample) => sample.totalMs)),
  },
  samples,
};
await writeExclusive(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

async function streamCompletion(iteration: number, outputTokens: number) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: label,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: outputTokens,
      seed: 20260924 + iteration,
      temperature: 0,
      top_p: 0.9,
      messages: [{
        role: "user",
        content: [
          "日本語で、ローカルLLMを対話アプリに組み込む際のレイテンシ設計を説明してください。",
          "TTFT、decode速度、同時実行、KV cacheの関係を具体的に述べ、最後に実務上の推奨をまとめてください。",
        ].join(""),
      }],
      chat_template_kwargs: mode === "off"
        ? { reasoning_effort: "medium", enable_thinking: false }
        : { reasoning_effort: "medium" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const headersMs = elapsed(started);
  if (!response.ok || !response.body) {
    throw new Error(`stream returned HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstByteMs: number | null = null;
  let firstSseMs: number | null = null;
  let firstReasoningCharacterMs: number | null = null;
  let firstContentCharacterMs: number | null = null;
  let finishReason: string | null = null;
  let completionTokens: number | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs === null && value.byteLength > 0) firstByteMs = elapsed(started);
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;
      const chunk = recordValue(JSON.parse(data));
      if (!chunk) continue;
      if (firstSseMs === null) firstSseMs = elapsed(started);
      const choice = Array.isArray(chunk.choices) ? recordValue(chunk.choices[0]) : undefined;
      const delta = recordValue(choice?.delta);
      const reasoning = stringValue(delta?.reasoning_content) || stringValue(delta?.reasoning);
      const content = stringValue(delta?.content);
      if (firstReasoningCharacterMs === null && reasoning.length > 0) {
        firstReasoningCharacterMs = elapsed(started);
      }
      if (firstContentCharacterMs === null && content.length > 0) {
        firstContentCharacterMs = elapsed(started);
      }
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      const usage = recordValue(chunk.usage);
      if (typeof usage?.completion_tokens === "number") completionTokens = usage.completion_tokens;
    }
  }

  const firstAnyTextCharacterMs = minimum(
    firstReasoningCharacterMs,
    firstContentCharacterMs,
  );
  if (firstSseMs === null || firstAnyTextCharacterMs === null) {
    throw new Error(`stream ${iteration} did not emit text`);
  }
  if (mode === "off" && firstContentCharacterMs === null) {
    throw new Error(`thinking-off stream ${iteration} did not emit visible content`);
  }
  return {
    iteration,
    headersMs,
    firstByteMs,
    firstSseMs,
    firstReasoningCharacterMs,
    firstContentCharacterMs,
    firstAnyTextCharacterMs,
    totalMs: elapsed(started),
    completionTokens,
    finishReason,
  };
}

function summarize(values: Array<number | null>) {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: round(sorted[0]!),
    median: round(sorted[Math.floor(sorted.length / 2)]!),
    max: round(sorted.at(-1)!),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function minimum(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function elapsed(started: number): number {
  return round(performance.now() - started);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredLoopbackUrl(name: string): string {
  const value = process.env[name];
  if (!value || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(value)) {
    throw new Error(`${name} must be an explicit loopback HTTP URL`);
  }
  return value;
}

function requiredLabel(name: string): string {
  const value = process.env[name];
  if (!value || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error(`${name} must be a safe model label`);
  }
  return value;
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function thinkingMode(value: string): ThinkingMode {
  if (value !== "auto" && value !== "off") {
    throw new Error("TTFC_EVAL_THINKING must be auto or off");
  }
  return value;
}
