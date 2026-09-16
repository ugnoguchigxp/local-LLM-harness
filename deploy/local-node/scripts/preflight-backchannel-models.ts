import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  BACKCHANNEL_CASES,
  BACKCHANNEL_RESPONSE_FORMAT,
  BACKCHANNEL_SYSTEM_PROMPT,
  parseBackchannelCompletion,
  parseBackchannelDecision,
  readBackchannelJson,
  summarizeBackchannelCases,
  type BackchannelKind,
} from "./evaluate-backchannel-candidates";
import { absoluteOutput, prepareExternalOutput, writeExclusive } from "./benchmark-helpers";
import { OpenAiChatCompletionSseInspector } from "../../../packages/core/src/index";

type Candidate = {
  id: string;
  model: string;
  modelPath: string;
  extraArgs?: string[];
};

type Activity = {
  state: "idle" | "active" | "draining";
  activeWorkloads: number;
  reservationGuaranteed: false;
};

type CaseResult = {
  id: string;
  input: string;
  expected: BackchannelKind;
  actual?: BackchannelKind;
  validJson: boolean;
  correct: boolean;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
};

class ForegroundContention extends Error {
  constructor() {
    super("LARM foreground activity resumed during candidate preflight");
  }
}

const candidates: readonly Candidate[] = [
  {
    id: "qwen35-2b-q4-k-m",
    model: "qwen35-decision",
    modelPath: "/srv/ai/models/qwen35-decision/Qwen3.5-2B-Q4_K_M.gguf",
  },
  {
    id: "lfm25-1.2b-jp-q4-k-m",
    model: "lfm25-backchannel-jp",
    modelPath: "/srv/ai/models/lfm25-1.2b-jp/LFM2.5-1.2B-JP-Q4_K_M.gguf",
    extraArgs: ["--repeat-penalty", "1.05"],
  },
  {
    id: "gemma3-1b-it-q4-k-m",
    model: "gemma3-backchannel",
    modelPath: "/srv/ai/models/gemma3-1b-it/gemma-3-1b-it-Q4_K_M.gguf",
  },
] as const;

const llamaServer = "/srv/ai/apps/llama.cpp/build-vulkan/bin/llama-server";
export function resolveLarmActivityUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("LARM_BASE_URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("LARM_BASE_URL must not contain credentials, a query, or a fragment");
  }
  const basePath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${basePath.endsWith("/v1") ? basePath : `${basePath}/v1`}/activity`;
  return parsed.toString();
}

const larmActivityUrl = resolveLarmActivityUrl(
  process.env.LARM_BASE_URL?.trim() || "http://127.0.0.1:9810",
);
const providerBaseUrl = "http://127.0.0.1:18080";
const pollMs = 100;

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 3_600_000) {
    throw new Error(`${name} must be an integer from 1 through 3600000`);
  }
  return value;
}

const timeoutMs = positiveInteger("LARM_BACKCHANNEL_TIMEOUT_MS", 30_000);
const idleWaitMs = positiveInteger("LARM_BACKCHANNEL_IDLE_WAIT_MS", 1_800_000);

async function readActivity(): Promise<Activity> {
  const response = await fetch(larmActivityUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`activity endpoint returned HTTP ${response.status}`);
  const value = await readBackchannelJson(response) as Partial<Activity>;
  if (
    (value.state !== "idle" && value.state !== "active" && value.state !== "draining")
    || !Number.isInteger(value.activeWorkloads)
    || value.reservationGuaranteed !== false
  ) {
    throw new Error("activity endpoint returned an invalid contract");
  }
  return value as Activity;
}

async function requireIdle(): Promise<void> {
  const activity = await readActivity();
  if (activity.state !== "idle" || activity.activeWorkloads !== 0) throw new ForegroundContention();
}

async function waitForIdle(candidate: string): Promise<void> {
  const deadline = Date.now() + idleWaitMs;
  while (Date.now() < deadline) {
    const activity = await readActivity();
    if (activity.state === "idle" && activity.activeWorkloads === 0) return;
    await Bun.sleep(pollMs);
  }
  throw new Error(`timed out waiting for an idle window before ${candidate}`);
}

async function runWhileIdle<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let finished = false;
  let contended = false;
  let stopMonitor!: () => void;
  const monitorStopped = new Promise<void>((resolve) => {
    stopMonitor = resolve;
  });
  const monitor = (async () => {
    while (!finished) {
      const stopped = await Promise.race([
        Bun.sleep(pollMs).then(() => false),
        monitorStopped.then(() => true),
      ]);
      if (stopped || finished) return;
      try {
        const activity = await readActivity();
        if (activity.state !== "idle" || activity.activeWorkloads !== 0) {
          contended = true;
          controller.abort();
          return;
        }
      } catch {
        contended = true;
        controller.abort();
        return;
      }
    }
  })();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await requireIdle();
    const result = await operation(controller.signal);
    if (contended) {
      throw new ForegroundContention();
    }
    await requireIdle();
    return result;
  } catch (error) {
    if (contended || error instanceof ForegroundContention) throw new ForegroundContention();
    throw error;
  } finally {
    finished = true;
    stopMonitor();
    clearTimeout(timer);
    await monitor;
  }
}

function serverArgs(candidate: Candidate): string[] {
  return [
    llamaServer,
    "-m", candidate.modelPath,
    "-dev", "Vulkan0",
    "-ngl", "999",
    "--fit", "off",
    "--flash-attn", "on",
    "--ctx-size", "4096",
    "--parallel", "1",
    "--batch-size", "512",
    "--ubatch-size", "512",
    "--threads", "16",
    "--poll", "100",
    "--cache-type-k", "q8_0",
    "--cache-type-v", "q8_0",
    "--host", "127.0.0.1",
    "--port", "18080",
    "--reasoning", "off",
    "--temp", "0",
    "--top-p", "1",
    ...(candidate.extraArgs ?? []),
    "--jinja",
    "--metrics",
    "--no-webui",
  ];
}

async function stopServer(process: Bun.Subprocess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([process.exited, Bun.sleep(5_000)]);
  if (process.exitCode === null) {
    process.kill("SIGKILL");
    await process.exited;
  }
}

async function waitForReady(process: Bun.Subprocess, started: number): Promise<number> {
  while (performance.now() - started < timeoutMs) {
    if (process.exitCode !== null) throw new Error(`llama-server exited with ${process.exitCode} before readiness`);
    await requireIdle();
    try {
      const response = await fetch(`${providerBaseUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return Math.round(performance.now() - started);
      await response.body?.cancel().catch(() => undefined);
    } catch {
      // Startup connection failures are expected until llama-server binds the port.
    }
    await Bun.sleep(50);
  }
  throw new Error("llama-server readiness timed out");
}

async function evaluateCase(candidate: Candidate, item: typeof BACKCHANNEL_CASES[number]): Promise<CaseResult> {
  const started = performance.now();
  try {
    const { response, body } = await runWhileIdle(async (signal) => {
      const response = await fetch(`${providerBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: candidate.model,
          messages: [
            { role: "system", content: BACKCHANNEL_SYSTEM_PROMPT },
            { role: "user", content: item.input },
          ],
          response_format: BACKCHANNEL_RESPONSE_FORMAT,
          temperature: 0,
          max_tokens: 16,
          stream: false,
        }),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { response };
      }
      return { response, body: parseBackchannelCompletion(await readBackchannelJson(response)) };
    });
    if (!response.ok) throw new Error(`provider returned HTTP ${response.status}`);
    if (!body) throw new Error("provider response omitted message content");
    const content = body.choices[0]!.message.content;
    const actual = parseBackchannelDecision(content);
    return {
      ...item,
      actual,
      validJson: true,
      correct: actual === item.expected,
      latencyMs: Math.round(performance.now() - started),
      ...(body.usage?.prompt_tokens === undefined ? {} : { promptTokens: body.usage.prompt_tokens }),
      ...(body.usage?.completion_tokens === undefined ? {} : { completionTokens: body.usage.completion_tokens }),
    };
  } catch (error) {
    if (error instanceof ForegroundContention) throw error;
    return {
      ...item,
      validJson: false,
      correct: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : "unknown evaluation failure",
    };
  }
}

async function smokeSse(candidate: Candidate): Promise<{ firstMeaningfulMs: number; done: boolean; content: string }> {
  const started = performance.now();
  return runWhileIdle(async (signal) => {
    const response = await fetch(`${providerBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: candidate.model,
        messages: [
          { role: "system", content: BACKCHANNEL_SYSTEM_PROMPT },
          { role: "user", content: BACKCHANNEL_CASES[0]!.input },
        ],
        response_format: BACKCHANNEL_RESPONSE_FORMAT,
        temperature: 0,
        max_tokens: 16,
        stream: true,
      }),
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`SSE smoke returned HTTP ${response.status}`);
    const reader = response.body.getReader();
    let content = "";
    let firstMeaningfulMs: number | undefined;
    let responseBytes = 0;
    const inspector = new OpenAiChatCompletionSseInspector((chunk) => {
      for (const choice of chunk.choices) {
        const delta = choice.delta.content;
        if (typeof delta === "string" && delta.length > 0) {
          firstMeaningfulMs ??= Math.round(performance.now() - started);
          content += delta;
        }
      }
    });
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      responseBytes += chunk.value.byteLength;
      if (responseBytes > 64 * 1024) {
        await reader.cancel(new Error("provider response is too large")).catch(() => undefined);
        throw new Error("SSE smoke response is too large");
      }
      const progress = inspector.push(chunk.value);
      if (!progress.ok) {
        await reader.cancel(new Error(progress.reason)).catch(() => undefined);
        throw new Error(`SSE smoke response is invalid: ${progress.reason}`);
      }
    }
    const inspected = inspector.finish();
    if (!inspected.ok) throw new Error(`SSE smoke response is incomplete: ${inspected.reason}`);
    parseBackchannelDecision(content);
    if (firstMeaningfulMs === undefined) throw new Error("SSE smoke did not produce content");
    return { firstMeaningfulMs, done: true, content };
  });
}

async function runCandidate(candidate: Candidate) {
  let attempts = 0;
  const readyAttemptsMs: number[] = [];
  const cases: CaseResult[] = [];
  let sse: Awaited<ReturnType<typeof smokeSse>> | undefined;
  while (true) {
    attempts += 1;
    await waitForIdle(candidate.id);
    await requireIdle();
    const started = performance.now();
    const process = Bun.spawn(serverArgs(candidate), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    try {
      const readyMs = await waitForReady(process, started);
      readyAttemptsMs.push(readyMs);
      while (cases.length < BACKCHANNEL_CASES.length) {
        cases.push(await evaluateCase(candidate, BACKCHANNEL_CASES[cases.length]!));
      }
      sse ??= await smokeSse(candidate);
      await requireIdle();
      return {
        id: candidate.id,
        model: candidate.model,
        attempts,
        readyMs: readyAttemptsMs[0]!,
        readyAttemptsMs,
        cases,
        summary: summarizeBackchannelCases(cases),
        sse,
      };
    } catch (error) {
      if (!(error instanceof ForegroundContention)) throw error;
      console.error(
        `[${candidate.id}] foreground resumed; discarded in-flight sample, retained ${cases.length}/${BACKCHANNEL_CASES.length}`,
      );
    } finally {
      await stopServer(process);
    }
  }
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
    const startedAt = new Date().toISOString();
    const evaluated = [];
    for (const candidate of candidates) {
      console.error(`[${candidate.id}] waiting for an uncontended idle window`);
      evaluated.push(await runCandidate(candidate));
    }
    const result = {
      schemaVersion: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      corpusDigest: createHash("sha256").update(JSON.stringify(BACKCHANNEL_CASES)).digest("hex"),
      executionValidity: {
        providerPath: "standalone llama-server on 127.0.0.1:18080",
        idlePolledEveryMs: pollMs,
        foregroundOverlapAccepted: false,
        reservationGuaranteed: false,
        note: "Every attempt that observed foreground activity was aborted and discarded.",
      },
      candidates: evaluated,
    };
    if (outputPath) await writeExclusive(outputPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Backchannel preflight failed: ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  }
}
