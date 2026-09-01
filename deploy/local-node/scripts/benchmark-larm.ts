import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { LarmClient } from "../../../packages/client/src/index";
import {
  daemonHealthSchema,
  sloBenchmarkSummarySchema,
  sloSeriesIdSchema,
  type SloBenchmarkSummary,
} from "../../../packages/core/src/index";
import {
  absoluteOutput,
  consumeBenchmarkResponse,
  prepareExternalOutput,
  writeExclusive,
} from "./benchmark-helpers";
import { runSaaaWebSocketSmoke } from "./smoke-saaa-websocket";

type SeriesId = (typeof sloSeriesIdSchema.options)[number];
type BindingIdentity = { route: string; runtime: string; release: string; fallback: boolean };
type RawSample = BindingIdentity & {
  iteration: number;
  bootEpoch: string;
  ttfbMs: number;
  totalMs: number;
  startupMs: number;
  status: number;
};

const repoRoot = resolve(import.meta.dir, "../../..");
const rawOutput = await prepareExternalOutput(
  absoluteOutput("LARM_BENCHMARK_OUTPUT", process.env.LARM_BENCHMARK_OUTPUT),
  repoRoot,
);
const summaryOutput = process.env.LARM_BENCHMARK_SUMMARY
  ? await prepareExternalOutput(
    absoluteOutput("LARM_BENCHMARK_SUMMARY", process.env.LARM_BENCHMARK_SUMMARY),
    repoRoot,
  )
  : undefined;
if (summaryOutput === rawOutput) throw new Error("benchmark raw and summary outputs must be different paths");
const commit = process.env.LARM_BENCHMARK_COMMIT;
if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("LARM_BENCHMARK_COMMIT must be a full commit hash");
const iterations = boundedInteger("LARM_BENCHMARK_ITERATIONS", 5, 3, 100);
const warmups = boundedInteger("LARM_BENCHMARK_WARMUPS", 1, 0, 10);
const requestedSeries = process.env.LARM_BENCHMARK_SERIES ?? "llm-normal";
const seriesIds = requestedSeries === "all"
  ? [...sloSeriesIdSchema.options]
  : requestedSeries.split(",").map((value) => sloSeriesIdSchema.parse(value.trim()));
if (new Set(seriesIds).size !== seriesIds.length) throw new Error("LARM_BENCHMARK_SERIES contains duplicates");

const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
const authHeaders = process.env.LARM_API_TOKEN
  ? { authorization: `Bearer ${process.env.LARM_API_TOKEN}` }
  : undefined;
const health = await fetchHealth();
if (health.releaseCommit !== commit) {
  throw new Error(`deployed release commit ${health.releaseCommit} does not match benchmark commit ${commit}`);
}
const client = new LarmClient({ baseUrl, apiToken: process.env.LARM_API_TOKEN });
let realtimeAgentProfile: string | undefined;
let explicitRealtimeAgentProfile = false;
if (seriesIds.includes("llm-realtime")) {
  const profiles = await client.listAgentProfiles();
  realtimeAgentProfile = process.env.LARM_BENCHMARK_AGENT_PROFILE ?? profiles.defaultAgentProfile;
  const selected = profiles.profiles.find((profile) => profile.id === realtimeAgentProfile);
  if (!selected) throw new Error(`realtime Agent Profile ${realtimeAgentProfile} is not advertised`);
  if (!process.env.LARM_BENCHMARK_AGENT_PROFILE && selected.selectionPolicy !== "default") {
    throw new Error("default realtime Agent Profile is not marked as default");
  }
  if (!selected.providers.some((provider) => provider.streamingProtocol === "saaa.llm-stream.v1")) {
    throw new Error(`realtime Agent Profile ${realtimeAgentProfile} does not advertise saaa.llm-stream.v1`);
  }
  explicitRealtimeAgentProfile = selected.selectionPolicy === "explicit-only";
}
const rawSeries: Array<{ id: SeriesId; samples: RawSample[]; errors: Array<{ iteration: number; code: string }> }> = [];
const summaries: SloBenchmarkSummary["series"] = [];
let rawPublicationAttempted = false;

try {
  for (const id of seriesIds) {
    for (let warmup = 0; warmup < warmups; warmup += 1) await runSample(id, 0);
    const samples: RawSample[] = [];
    const errors: Array<{ iteration: number; code: string }> = [];
    const memory = { system: Number.POSITIVE_INFINITY, accelerator: Number.POSITIVE_INFINITY };
    let maxQueueDepth = 0;
    const beforeMetrics = await readMetrics();
    updateTelemetry(beforeMetrics, memory, (queue) => { maxQueueDepth = Math.max(maxQueueDepth, queue); });
    const before429 = metricSum(beforeMetrics, /^larm_gateway_request_total(?:\{[^}]*status="429"[^}]*\})? /);
    let monitorActive = true;
    let monitorError: unknown;
    const monitor = (async () => {
      while (monitorActive) {
        try {
          updateTelemetry(await readMetrics(), memory, (queue) => { maxQueueDepth = Math.max(maxQueueDepth, queue); });
        } catch (cause) {
          monitorError = cause;
          return;
        }
        if (monitorActive) await Bun.sleep(100);
      }
    })();
    try {
      for (let iteration = 1; iteration <= iterations; iteration += 1) {
        try {
          samples.push(await runSample(id, iteration));
        } catch (cause) {
          errors.push({ iteration, code: errorCode(cause) });
        }
      }
    } finally {
      monitorActive = false;
      await monitor;
    }
    rawSeries.push({ id, samples, errors });
    if (monitorError) throw new Error(`${id} telemetry monitor failed`, { cause: monitorError });
    const afterMetrics = await readMetrics();
    updateTelemetry(afterMetrics, memory, (queue) => { maxQueueDepth = Math.max(maxQueueDepth, queue); });
    const provider429Count = Math.max(0,
      metricSum(afterMetrics, /^larm_gateway_request_total(?:\{[^}]*status="429"[^}]*\})? /) - before429);
    if (samples.length === 0) throw new Error(`${id} produced no successful samples`);
    if (!Number.isFinite(memory.system) || !Number.isFinite(memory.accelerator)) {
      throw new Error(`${id} memory telemetry is missing`);
    }
    const definition = seriesDefinition(id);
    summaries.push({
      id,
      promptClass: definition.promptClass,
      maxTokens: definition.maxTokens,
      concurrency: 1,
      iterations,
      successes: samples.length,
      errors: errors.length,
      errorRate: errors.length / iterations,
      fallbackCount: samples.filter((sample) => sample.fallback).length,
      provider429Count,
      maxQueueDepth,
      bootEpochs: unique(samples.map((sample) => sample.bootEpoch)),
      routes: unique(samples.map((sample) => sample.route)),
      runtimes: unique(samples.map((sample) => sample.runtime)),
      releases: unique(samples.map((sample) => sample.release)),
      latencyMs: {
        ttfbP95: percentile(samples.map((sample) => sample.ttfbMs), 0.95),
        totalP95: percentile(samples.map((sample) => sample.totalMs), 0.95),
        startupP95: percentile(samples.map((sample) => sample.startupMs), 0.95),
      },
      memoryHeadroomMinBytes: memory,
    });
  }

  const healthAfter = await fetchHealth();
  if (healthAfter.bootEpoch !== health.bootEpoch) throw new Error("daemon boot epoch changed during benchmark");
  if (healthAfter.configRevision !== health.configRevision) throw new Error("config revision changed during benchmark");
  if (healthAfter.releaseCommit !== health.releaseCommit) throw new Error("release commit changed during benchmark");
  const summary = sloBenchmarkSummarySchema.parse({
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    commit,
    configRevision: health.configRevision,
    series: summaries,
  });
  await publishRaw("completed", summary.recordedAt);
  if (summaryOutput) await writeExclusive(summaryOutput, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (cause) {
  if (!rawPublicationAttempted) {
    await publishRaw("failed", new Date().toISOString(), errorCode(cause));
  }
  throw cause;
}

async function publishRaw(status: "completed" | "failed", recordedAt: string, error?: string): Promise<void> {
  rawPublicationAttempted = true;
  await writeExclusive(rawOutput, JSON.stringify({
    schemaVersion: 1,
    status,
    recordedAt,
    commit,
    configRevision: health.configRevision,
    warmups,
    series: rawSeries,
    ...(error ? { error } : {}),
  }, null, 2));
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

async function fetchHealth() {
  const response = await fetch(`${baseUrl}/health`, { headers: authHeaders, signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`LARM health returned HTTP ${response.status}`);
  return daemonHealthSchema.parse(await response.json());
}

function seriesDefinition(id: SeriesId) {
  switch (id) {
    case "llm-normal": return { capability: "llm.general", route: "llm-default", promptClass: "llm-normal-fixed-control", maxTokens: 32 };
    case "llm-realtime": return { capability: "llm.general", route: "llm-default", promptClass: "llm-realtime-fixed-control", maxTokens: 8 };
    case "stt": return { capability: "speech.stt", route: "stt-default", promptClass: "stt-fixed-nonsensitive-audio", maxTokens: 0 };
    case "tts-normal": return { capability: "speech.tts", route: "tts-default", promptClass: "tts-normal-fixed-control", maxTokens: 0 };
  }
}

async function runSample(id: SeriesId, iteration: number): Promise<RawSample> {
  const definition = seriesDefinition(id);
  const allocationStarted = performance.now();
  if (id === "llm-realtime") {
    return await client.withAgentConnection({
      agentProfile: realtimeAgentProfile!,
      ...(explicitRealtimeAgentProfile ? { explicitAgentProfile: true } : {}),
      audience: process.env.LARM_BENCHMARK_AGENT_AUDIENCE ?? "same-host",
      ttlSeconds: 120,
      allowFallback: false,
      deploymentPolicy: "existing-only",
    }, async (_connection, claim, larm) => {
      const provider = claim.providers.find((candidate) => candidate.streaming);
      if (!provider?.streaming) throw new Error("saaa_streaming_not_advertised");
      const allocation = await larm.getAllocation(claim.allocationId);
      const binding = allocation.bindings.find((candidate) => candidate.capability.startsWith("llm."));
      if (!binding) throw new Error("binding_missing");
      const startupMs = performance.now() - allocationStarted;
      const measured = await runSaaaWebSocketSmoke({
        url: provider.streaming.url,
        token: provider.credential.token,
        allocationId: claim.allocationId,
        model: provider.model,
        timeoutMs: 120_000,
        prompt: "Reply with OK.",
        maxOutputTokens: definition.maxTokens,
      });
      return {
        iteration,
        bootEpoch: allocation.bootEpoch,
        route: binding.route,
        runtime: binding.runtime,
        release: binding.release ?? "unmanaged",
        fallback: binding.fallback,
        ttfbMs: measured.firstDeltaMs,
        totalMs: measured.durationMs,
        startupMs,
        status: 101,
      };
    });
  }
  return await client.withAllocation({
    requirements: [{ capability: definition.capability, route: definition.route }],
    allowFallback: false,
    deploymentPolicy: "existing-only",
    ttlSeconds: 120,
  }, async (allocation, larm) => {
    const startupMs = performance.now() - allocationStarted;
    const binding = allocation.bindings[0];
    if (!binding) throw new Error("binding_missing");
    const requestStarted = performance.now();
    let response: Response;
    if (id === "llm-normal") {
      response = await larm.chat(allocation.id, {
        model: "larm",
        stream: false,
        max_tokens: definition.maxTokens,
        messages: [{ role: "user", content: "Reply with OK." }],
      });
    } else if (id === "stt") {
      const audioPath = process.env.LARM_BENCHMARK_AUDIO_FILE;
      if (!audioPath || !isAbsolute(audioPath)) throw new Error("audio_fixture_missing");
      const metadata = await lstat(audioPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("audio_fixture_invalid");
      const form = new FormData();
      form.append("file", Bun.file(audioPath), "sample.wav");
      response = await larm.transcribe(allocation.id, form);
    } else {
      response = await larm.speech(allocation.id, {
        model: "voicevox-core",
        input: "疎通確認です。",
        voice: "Kasukabe_Tsumugi",
        response_format: "wav",
      });
    }
    const status = response.status;
    const responseKind = id === "llm-normal" ? "llm" : id === "stt" ? "stt" : "tts";
    const { firstByteAt } = await consumeBenchmarkResponse(responseKind, response);
    const completedAt = performance.now();
    return {
      iteration,
      bootEpoch: allocation.bootEpoch,
      route: binding.route,
      runtime: binding.runtime,
      release: binding.release ?? "unmanaged",
      fallback: binding.fallback,
      ttfbMs: firstByteAt - requestStarted,
      totalMs: completedAt - requestStarted,
      startupMs,
      status,
    };
  });
}

async function readMetrics(): Promise<string> {
  const response = await fetch(`${baseUrl}/metrics`, { headers: authHeaders, signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`LARM metrics returned HTTP ${response.status}`);
  return await response.text();
}

function metricSum(metrics: string, pattern: RegExp): number {
  return metrics.split("\n").filter((line) => pattern.test(line))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1) ?? 0), 0);
}

function updateTelemetry(metrics: string, memory: { system: number; accelerator: number }, queue: (value: number) => void): void {
  const value = (name: string) => {
    const match = metrics.match(new RegExp(`^${name} ([0-9]+(?:\\.[0-9]+)?)$`, "m"));
    return match?.[1] === undefined ? undefined : Number(match[1]);
  };
  const system = value("larm_system_memory_available_bytes");
  const accelerator = value("larm_accelerator_memory_available_bytes");
  if (system !== undefined) memory.system = Math.min(memory.system, system);
  if (accelerator !== undefined) memory.accelerator = Math.min(memory.accelerator, accelerator);
  queue(metricSum(metrics, /^larm_execution_queued(?:\{[^}]*\})? /));
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function unique(values: string[]): [string, ...string[]] {
  const result = [...new Set(values)];
  if (result.length === 0) throw new Error("benchmark identity set is empty");
  return result as [string, ...string[]];
}

function errorCode(cause: unknown): string {
  if (cause instanceof Error && /^[a-z0-9_]+$/.test(cause.message)) return cause.message;
  if (cause instanceof Error && /^http_[0-9]{3}$/.test(cause.message)) return cause.message;
  return "benchmark_request_failed";
}
