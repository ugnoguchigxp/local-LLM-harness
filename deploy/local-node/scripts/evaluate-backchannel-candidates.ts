import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { LarmClient } from "../../../packages/client/src/index";
import type { AgentProfileSelectorId } from "../../../packages/core/src/index";
import { absoluteOutput, prepareExternalOutput, writeExclusive } from "./benchmark-helpers";

export type BackchannelKind = "ack" | "defer";

export type BackchannelCase = {
  id: string;
  input: string;
  expected: BackchannelKind;
};

export const BACKCHANNEL_CASES: readonly BackchannelCase[] = [
  { id: "empathy-tired", input: "今日は仕事でかなり疲れたよ。", expected: "ack" },
  { id: "achievement", input: "頼まれていた資料、ようやく書き終えました。", expected: "ack" },
  { id: "pause", input: "ちょっと待って、今考えをまとめているところ。", expected: "ack" },
  { id: "continue-listening", input: "まだ話の途中だから、そのまま聞いていて。", expected: "ack" },
  { id: "bad-day", input: "今日は本当にうまくいかない一日だった。", expected: "ack" },
  { id: "no-rush", input: "急がなくていいから、ゆっくり進めよう。", expected: "ack" },
  { id: "research", input: "詳しい資料を調べて、あとで要点を教えて。", expected: "defer" },
  { id: "fact", input: "富士山の正確な標高は何メートル？", expected: "defer" },
  { id: "external-action", input: "来週の予定を火曜日に変更しておいて。", expected: "defer" },
  { id: "ambiguous", input: "例の件、いつもの感じでやっておいて。", expected: "defer" },
  { id: "medical", input: "この胸の痛みは放置しても大丈夫？", expected: "defer" },
  { id: "current-info", input: "今日の東京の天気を教えて。", expected: "defer" },
] as const;

const decisionSchema = z.object({ kind: z.enum(["ack", "defer"]) }).strict();

export const BACKCHANNEL_SYSTEM_PROMPT = [
  "あなたは会話の一時応答を安全に振り分ける分類器です。",
  "JSONだけを返し、形式は必ず {\"kind\":\"ack\"} または {\"kind\":\"defer\"} にしてください。",
  "外部情報、事実確認、現実世界の操作、医療判断、または曖昧な依頼が不要で、単純な相槌だけで安全ならackです。",
  "それ以外は必ずdeferです。質問への回答や、実行したという約束を生成してはいけません。",
].join("\n");

export const BACKCHANNEL_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "backchannel_decision",
    strict: true,
    schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["ack", "defer"] } },
      required: ["kind"],
      additionalProperties: false,
    },
  },
} as const;

const completionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }).passthrough(),
  }).passthrough()).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
}).passthrough();

export function parseBackchannelDecision(content: string): BackchannelKind {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("backchannel decision is not JSON");
  }
  const decision = decisionSchema.safeParse(parsed);
  if (!decision.success) throw new Error("backchannel decision violates the strict schema");
  return decision.data.kind;
}

export function summarizeBackchannelCases(
  cases: readonly { expected: BackchannelKind; actual?: BackchannelKind; validJson: boolean; latencyMs: number }[],
): { total: number; schemaValid: number; correct: number; accuracy: number; medianLatencyMs: number } {
  const latencies = cases.map((item) => item.latencyMs).sort((left, right) => left - right);
  const middle = Math.floor(latencies.length / 2);
  const medianLatencyMs = latencies.length === 0
    ? 0
    : latencies.length % 2 === 1
    ? latencies[middle]!
    : (latencies[middle - 1]! + latencies[middle]!) / 2;
  const correct = cases.filter((item) => item.validJson && item.actual === item.expected).length;
  return {
    total: cases.length,
    schemaValid: cases.filter((item) => item.validJson).length,
    correct,
    accuracy: cases.length === 0 ? 0 : correct / cases.length,
    medianLatencyMs: Math.round(medianLatencyMs),
  };
}

type EvaluationOptions = {
  baseUrl: string;
  apiToken?: string;
  audience: string;
  profiles: string[];
  timeoutMs: number;
  requireIdle: boolean;
  outputPath?: string;
  fetch?: typeof fetch;
};

const BACKCHANNEL_SELECTORS: Record<string, AgentProfileSelectorId> = {
  "contextstill-backchannel-qwen35-2b": "backchannelQwen35",
  "contextstill-backchannel-lfm25-jp-1.2b": "backchannelLfm25Jp",
  "contextstill-backchannel-gemma3-1b": "backchannelGemma3",
};

type CaseResult = BackchannelCase & {
  actual?: BackchannelKind;
  validJson: boolean;
  correct: boolean;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
};

const MAX_RESPONSE_BYTES = 64 * 1024;

export async function readBackchannelJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("provider response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider response has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel(new Error("provider response is too large")).catch(() => undefined);
      throw new Error("provider response is too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("provider response is not UTF-8 JSON");
  }
}

export function parseBackchannelCompletion(value: unknown) {
  return completionSchema.parse(value);
}

async function evaluateCase(
  fetchImpl: typeof fetch,
  provider: { baseUrl: string; model: string; credential: { token: string } },
  item: BackchannelCase,
  timeoutMs: number,
): Promise<CaseResult> {
  const started = performance.now();
  try {
    const response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.credential.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: BACKCHANNEL_SYSTEM_PROMPT },
          { role: "user", content: item.input },
        ],
        response_format: BACKCHANNEL_RESPONSE_FORMAT,
        temperature: 0,
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`provider returned HTTP ${response.status}`);
    }
    const completion = parseBackchannelCompletion(await readBackchannelJson(response));
    const actual = parseBackchannelDecision(completion.choices[0]!.message.content);
    return {
      ...item,
      actual,
      validJson: true,
      correct: actual === item.expected,
      latencyMs,
      ...(completion.usage?.prompt_tokens !== undefined
        ? { promptTokens: completion.usage.prompt_tokens }
        : {}),
      ...(completion.usage?.completion_tokens !== undefined
        ? { completionTokens: completion.usage.completion_tokens }
        : {}),
    };
  } catch (error) {
    return {
      ...item,
      validJson: false,
      correct: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : "unknown evaluation failure",
    };
  }
}

export async function evaluateBackchannelCandidates(options: EvaluationOptions) {
  if (options.profiles.length === 0 || new Set(options.profiles).size !== options.profiles.length) {
    throw new Error("profiles must be a non-empty unique list");
  }
  const fetchImpl = options.fetch ?? fetch;
  const larm = new LarmClient({
    baseUrl: options.baseUrl,
    ...(options.apiToken ? { apiToken: options.apiToken } : {}),
    timeoutMs: options.timeoutMs,
    fetch: fetchImpl,
  });
  const healthBefore = await larm.getHealth();
  const profiles = await larm.listAgentProfiles();
  const startedAt = new Date().toISOString();
  const candidates = [];

  for (const profileId of options.profiles) {
    const advertised = profiles.profiles.find((profile) => profile.id === profileId);
    if (!advertised || advertised.selectionPolicy !== "explicit-only") {
      throw new Error(`explicit backchannel profile is not advertised: ${profileId}`);
    }
    const advertisedProvider = advertised.providers.find((provider) => provider.name === "backchannel");
    if (advertisedProvider?.capability !== "llm.backchannel.classifier") {
      throw new Error(`backchannel provider is not advertised by ${profileId}`);
    }
    const activity = await larm.getServiceActivity();
    if (activity.state === "draining" || (options.requireIdle && activity.state !== "idle")) {
      throw new Error(`LARM is ${activity.state} before ${profileId}; evaluation was not started`);
    }

    const candidateStarted = performance.now();
    const selector = BACKCHANNEL_SELECTORS[profileId];
    if (!selector) throw new Error(`no public profile selector is configured for ${profileId}`);
    const evaluated = await larm.withAgentConnection({
      profile: selector,
      audience: options.audience,
      client: "larm-backchannel-evaluator",
      ttlSeconds: 300,
      allowFallback: false,
      deploymentPolicy: "existing-only",
    }, async (_connection, claim) => {
      const provider = claim.providers.find((item) => item.name === "backchannel");
      if (!provider || provider.apiStyle !== "openai") {
        throw new Error(`claimed backchannel provider is invalid: ${profileId}`);
      }
      const readyMs = Math.round(performance.now() - candidateStarted);
      const cases: CaseResult[] = [];
      for (const item of BACKCHANNEL_CASES) {
        cases.push(await evaluateCase(fetchImpl, provider, item, options.timeoutMs));
      }
      return {
        profile: profileId,
        model: provider.model,
        readyMs,
        cases,
        summary: summarizeBackchannelCases(cases),
      };
    }, { timeoutMs: options.timeoutMs, pollIntervalMs: 250 });
    candidates.push(evaluated);
  }

  const healthAfter = await larm.getHealth();
  if (
    healthAfter.releaseCommit !== healthBefore.releaseCommit
    || healthAfter.configRevision !== healthBefore.configRevision
    || healthAfter.bootEpoch !== healthBefore.bootEpoch
  ) {
    throw new Error("LARM identity changed during backchannel evaluation");
  }
  const result = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    releaseCommit: healthBefore.releaseCommit,
    configRevision: healthBefore.configRevision,
    bootEpoch: healthBefore.bootEpoch,
    corpusDigest: createHash("sha256").update(JSON.stringify(BACKCHANNEL_CASES)).digest("hex"),
    executionValidity: {
      idleGate: options.requireIdle,
      oneCandidateAtATime: true,
      reservationGuaranteed: false,
      note: "The idle snapshot is race-prone until LARM provides a benchmark lease.",
    },
    candidates,
  };
  if (options.outputPath) await writeExclusive(options.outputPath, JSON.stringify(result, null, 2));
  return result;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 3_600_000) {
    throw new Error(`${name} must be an integer from 1 through 3600000`);
  }
  return value;
}

if (import.meta.main) {
  try {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const outputPath = process.env.LARM_BACKCHANNEL_OUTPUT
      ? await prepareExternalOutput(
        absoluteOutput("LARM_BACKCHANNEL_OUTPUT", process.env.LARM_BACKCHANNEL_OUTPUT),
        repoRoot,
      )
      : undefined;
    const profiles = (process.env.LARM_BACKCHANNEL_PROFILES
      ?? [
        "contextstill-backchannel-qwen35-2b",
        "contextstill-backchannel-lfm25-jp-1.2b",
        "contextstill-backchannel-gemma3-1b",
      ].join(","))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const result = await evaluateBackchannelCandidates({
      baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
      ...(process.env.LARM_API_TOKEN ? { apiToken: process.env.LARM_API_TOKEN } : {}),
      audience: process.env.LARM_AGENT_AUDIENCE ?? "same-host",
      profiles,
      timeoutMs: envPositiveInteger("LARM_BACKCHANNEL_TIMEOUT_MS", 300_000),
      requireIdle: process.env.LARM_BACKCHANNEL_REQUIRE_IDLE !== "0",
      ...(outputPath ? { outputPath } : {}),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Backchannel evaluation failed: ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  }
}
