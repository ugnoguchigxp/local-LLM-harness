import { isAbsolute, resolve } from "node:path";
import { absoluteOutput, prepareExternalOutput, writeExclusive } from "./benchmark-helpers";

type JsonRecord = Record<string, unknown>;
type ChatSample = {
  iteration: number;
  status: number;
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
  predictedTokensPerSecond: number | null;
  draftTokens: number | null;
  acceptedDraftTokens: number | null;
  finishReason: string | null;
};

const repoRoot = resolve(import.meta.dir, "../../..");
const baseUrl = requiredLoopbackUrl("QWEN_EVAL_BASE_URL");
const label = requiredLabel("QWEN_EVAL_LABEL");
const mode = evaluationMode("QWEN_EVAL_MODE");
const iterations = boundedInteger("QWEN_EVAL_ITERATIONS", 3, 1, 20);
const maxTokens = boundedInteger("QWEN_EVAL_MAX_TOKENS", 192, 64, 1_024);
const timeoutMs = boundedInteger("QWEN_EVAL_TIMEOUT_MS", 300_000, 10_000, 900_000);
const output = await prepareExternalOutput(
  absoluteOutput("QWEN_EVAL_OUTPUT", process.env.QWEN_EVAL_OUTPUT),
  repoRoot,
);

const health = await getJson("/health");
const props = await getJson("/props");
await chat({
  max_tokens: 32,
  messages: [{ role: "user", content: "Reply with exactly OK." }],
  chat_template_kwargs: { reasoning_effort: "medium", enable_thinking: false },
});

const samples: ChatSample[] = [];
let delta: ReturnType<typeof subtractMetrics> | null = null;
if (mode !== "functional") {
  const before = await metricSnapshot();
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const response = await chat({
      max_tokens: maxTokens,
      seed: 20260912 + iteration,
      temperature: 0.2,
      top_p: 0.9,
      messages: [{
        role: "user",
        content: [
          "Implement a compact Python module for an in-memory LRU cache.",
          "It must support get, put, delete, capacity changes, and deterministic iteration from newest to oldest.",
          "Explain the invariants briefly, then provide complete code. Do not omit edge-case handling.",
        ].join(" "),
      }],
      chat_template_kwargs: { reasoning_effort: "medium" },
    });
    samples.push(sample(response, iteration));
  }
  delta = subtractMetrics(await metricSnapshot(), before);
}

const syntax = mode === "throughput" ? null : await pythonSyntaxCheck();
const tool = mode === "throughput" ? null : await toolCallCheck();
const structured = mode === "throughput" ? null : await structuredOutputCheck();
const passed = (syntax?.passed ?? true) && (tool?.passed ?? true) && (structured?.passed ?? true)
  && samples.every((item) => item.status === 200 && item.completionTokens > 0);
const report = {
  schemaVersion: 1,
  kind: "qwen38-direct-server-evaluation",
  recordedAt: new Date().toISOString(),
  label,
  target: { baseUrl, health, props: selectedProps(props) },
  configuration: { mode, iterations, maxTokens, timeoutMs, contextClass: "64K", reasoningEffort: "medium" },
  passed,
  throughput: {
    samples,
    aggregate: {
      promptTokens: delta?.promptTokens ?? null,
      promptSeconds: delta ? round(delta.promptSeconds) : null,
      promptTokensPerSecond: delta ? rate(delta.promptTokens, delta.promptSeconds) : null,
      predictedTokens: delta?.predictedTokens ?? null,
      predictedSeconds: delta ? round(delta.predictedSeconds) : null,
      predictedTokensPerSecond: delta ? rate(delta.predictedTokens, delta.predictedSeconds) : null,
      draftTokens: delta?.draftTokens ?? null,
      acceptedDraftTokens: delta?.acceptedDraftTokens ?? null,
      draftAcceptance: delta ? ratio(delta.acceptedDraftTokens, delta.draftTokens) : null,
    },
  },
  functional: { pythonSyntax: syntax, toolCall: tool, structuredOutput: structured },
};
await writeExclusive(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!passed) process.exitCode = 1;

async function pythonSyntaxCheck() {
  const response = await chat({
    max_tokens: 512,
    seed: 20260912,
    temperature: 0.2,
    messages: [{
      role: "user",
      content: [
        "Return only Python code, with no Markdown fence.",
        "Implement def normalize_repo_path(path: str) -> str.",
        "Convert backslashes to slashes, remove dot components, resolve double-dot components without escaping",
        "above the relative root, collapse repeated slashes, and return '.' for an empty result.",
      ].join(" "),
    }],
    chat_template_kwargs: { reasoning_effort: "medium", enable_thinking: false },
  });
  const message = assistantMessage(response.body);
  const code = stripCodeFence(stringValue(message.content));
  const parsed = Bun.spawnSync(
    ["python3", "-c", "import ast,sys; ast.parse(sys.stdin.read())"],
    { stdin: new TextEncoder().encode(code), stdout: "pipe", stderr: "pipe" },
  );
  return {
    passed: response.status === 200 && code.length > 0 && parsed.exitCode === 0,
    status: response.status,
    completionTokens: usageTokens(response.body, "completion_tokens"),
    syntaxError: parsed.exitCode === 0 ? null : new TextDecoder().decode(parsed.stderr).trim().slice(0, 500),
  };
}

async function toolCallCheck() {
  const response = await chat({
    max_tokens: 256,
    seed: 20260912,
    temperature: 0.2,
    messages: [{ role: "user", content: "Read the file /workspace/README.md using the provided tool." }],
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    }],
    tool_choice: "required",
    chat_template_kwargs: { reasoning_effort: "medium" },
  });
  const calls = assistantMessage(response.body).tool_calls;
  const first = Array.isArray(calls) ? recordValue(calls[0]) : undefined;
  const fn = recordValue(first?.function);
  const args = jsonObject(stringValue(fn?.arguments));
  const passed = response.status === 200 && fn?.name === "read_file"
    && args?.path === "/workspace/README.md";
  return {
    passed,
    status: response.status,
    functionName: stringValue(fn?.name) || null,
    arguments: args,
    completionTokens: usageTokens(response.body, "completion_tokens"),
  };
}

async function structuredOutputCheck() {
  const response = await chat({
    max_tokens: 128,
    seed: 20260912,
    temperature: 0.2,
    messages: [{
      role: "user",
      content: "Return the deployment verdict with candidate='qwen38', approved=true, and score=7.",
    }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "deployment_verdict",
        strict: true,
        schema: {
          type: "object",
          properties: {
            candidate: { type: "string" },
            approved: { type: "boolean" },
            score: { type: "integer" },
          },
          required: ["candidate", "approved", "score"],
          additionalProperties: false,
        },
      },
    },
    chat_template_kwargs: { reasoning_effort: "medium", enable_thinking: false },
  });
  const content = stringValue(assistantMessage(response.body).content);
  const parsed = jsonObject(content);
  return {
    passed: response.status === 200 && parsed?.candidate === "qwen38"
      && parsed.approved === true && parsed.score === 7,
    status: response.status,
    value: parsed,
    completionTokens: usageTokens(response.body, "completion_tokens"),
  };
}

async function chat(body: JsonRecord): Promise<{ status: number; totalMs: number; body: JsonRecord }> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: label, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const totalMs = performance.now() - started;
  const parsed = recordValue(await response.json());
  if (!parsed) throw new Error(`chat returned a non-object body with HTTP ${response.status}`);
  return { status: response.status, totalMs: round(totalMs), body: parsed };
}

async function getJson(path: string): Promise<JsonRecord> {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  const value = recordValue(await response.json());
  if (!value) throw new Error(`${path} returned a non-object body`);
  return value;
}

async function metricSnapshot() {
  const response = await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`/metrics returned HTTP ${response.status}`);
  const text = await response.text();
  return {
    promptTokens: metric(text, "llamacpp:prompt_tokens_total"),
    promptSeconds: metric(text, "llamacpp:prompt_seconds_total"),
    predictedTokens: metric(text, "llamacpp:tokens_predicted_total"),
    predictedSeconds: metric(text, "llamacpp:tokens_predicted_seconds_total"),
    draftTokens: metric(text, "llamacpp:spec_decode_num_draft_tokens_total"),
    acceptedDraftTokens: metric(text, "llamacpp:spec_decode_num_accepted_tokens_total"),
  };
}

function metric(text: string, name: string): number {
  const line = text.split("\n").find((value) => value.startsWith(`${name} `));
  const value = Number(line?.trim().split(/\s+/).at(-1));
  if (!Number.isFinite(value)) throw new Error(`metric ${name} is missing`);
  return value;
}

function subtractMetrics(after: Awaited<ReturnType<typeof metricSnapshot>>, before: typeof after) {
  return {
    promptTokens: after.promptTokens - before.promptTokens,
    promptSeconds: after.promptSeconds - before.promptSeconds,
    predictedTokens: after.predictedTokens - before.predictedTokens,
    predictedSeconds: after.predictedSeconds - before.predictedSeconds,
    draftTokens: after.draftTokens - before.draftTokens,
    acceptedDraftTokens: after.acceptedDraftTokens - before.acceptedDraftTokens,
  };
}

function sample(response: Awaited<ReturnType<typeof chat>>, iteration: number): ChatSample {
  const timings = recordValue(response.body.timings);
  const choice = firstChoice(response.body);
  return {
    iteration,
    status: response.status,
    totalMs: response.totalMs,
    promptTokens: usageTokens(response.body, "prompt_tokens"),
    completionTokens: usageTokens(response.body, "completion_tokens"),
    predictedTokensPerSecond: finiteNumber(timings?.predicted_per_second),
    draftTokens: finiteNumber(timings?.draft_n),
    acceptedDraftTokens: finiteNumber(timings?.draft_n_accepted),
    finishReason: stringValue(choice.finish_reason) || null,
  };
}

function selectedProps(props: JsonRecord) {
  const settings = recordValue(props.default_generation_settings);
  const params = recordValue(settings?.params);
  return {
    totalSlots: finiteNumber(props.total_slots),
    contextSize: finiteNumber(settings?.n_ctx),
    chatTemplateSha256: new Bun.CryptoHasher("sha256")
      .update(stringValue(props.chat_template)).digest("hex"),
    temperature: finiteNumber(params?.temperature),
    topP: finiteNumber(params?.top_p),
  };
}

function assistantMessage(body: JsonRecord): JsonRecord {
  return recordValue(firstChoice(body).message) ?? {};
}

function firstChoice(body: JsonRecord): JsonRecord {
  return Array.isArray(body.choices) ? (recordValue(body.choices[0]) ?? {}) : {};
}

function usageTokens(body: JsonRecord, key: string): number {
  return finiteNumber(recordValue(body.usage)?.[key]) ?? 0;
}

function jsonObject(value: string): JsonRecord | undefined {
  try {
    return recordValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function stripCodeFence(value: string): string {
  const fenced = value.match(/```(?:python)?\s*([\s\S]*?)```/iu)?.[1];
  return (fenced ?? value).trim();
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rate(numerator: number, seconds: number): number | null {
  return seconds > 0 ? round(numerator / seconds) : null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
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

function evaluationMode(name: string): "all" | "throughput" | "functional" {
  const value = process.env[name] ?? "all";
  if (value !== "all" && value !== "throughput" && value !== "functional") {
    throw new Error(`${name} must be all, throughput, or functional`);
  }
  return value;
}

if (!isAbsolute(output)) throw new Error("QWEN_EVAL_OUTPUT must be absolute");
