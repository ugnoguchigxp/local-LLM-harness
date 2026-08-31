import { lstat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { LarmApiError, LarmClient } from "../../../packages/client/src/index";
import type { PublicAllocation } from "../../../packages/core/src/index";
import { absoluteOutput, prepareExternalOutput, writeExclusive } from "./benchmark-helpers";
import {
  consumeAsrPerformanceResponse,
  consumeLlmPerformanceResponse,
  consumeTtsPerformanceResponse,
  degradationPercent,
  summarize,
  wavDurationSeconds,
  type MetricSummary,
} from "./performance-helpers";

type WorkloadId = "llm" | "asr" | "tts";
type ScenarioId = WorkloadId | "mixed";
type Identity = { route: string; runtime: string; release: string; fallback: boolean };
type CommonSample = Identity & {
  workload: WorkloadId;
  iteration: number;
  status: number;
  firstByteMs: number;
  totalMs: number;
  responseBytes: number;
};
type LlmSample = CommonSample & {
  workload: "llm";
  firstTokenMs: number;
  completionTokens: number;
  completionTokenSource: "usage" | "content-events";
  outputTokensPerSecond: number;
};
type AudioSample = CommonSample & {
  audioSeconds: number;
  realtimeFactor: number;
  audioSecondsPerSecond: number;
};
type AsrSample = AudioSample & { workload: "asr" };
type TtsSample = AudioSample & { workload: "tts" };
type WorkloadSample = LlmSample | AsrSample | TtsSample;
type IterationResult = {
  iteration: number;
  allocationMs: number;
  wallTimeMs: number;
  launchSkewMs: number;
  samples: WorkloadSample[];
  errors: Array<{ workload: WorkloadId; code: string }>;
};
type AudioFixture = {
  source: "file" | "generated-by-tts";
  filename: string;
  blob: Blob;
  audioSeconds: number;
  bytes: number;
};
type Telemetry = {
  samples: number;
  systemMemoryAvailableMinBytes: number | null;
  acceleratorMemoryAvailableMinBytes: number | null;
  maxExecutionActive: number;
  maxQueueDepth: number;
  provider429Count: number;
  errors: string[];
};

const allScenarios = ["llm", "asr", "tts", "mixed"] as const;
const scenarioWorkloads: Record<ScenarioId, WorkloadId[]> = {
  llm: ["llm"],
  asr: ["asr"],
  tts: ["tts"],
  mixed: ["llm", "asr", "tts"],
};
const requirement = {
  llm: { capability: "llm.general", route: "llm-default" },
  asr: { capability: "speech.stt", route: "stt-default" },
  tts: { capability: "speech.tts", route: "tts-default" },
} as const;
const repoRoot = resolve(import.meta.dir, "../../..");
const iterations = boundedInteger("LARM_PERF_ITERATIONS", 5, 1, 100);
const warmups = boundedInteger("LARM_PERF_WARMUPS", 1, 0, 10);
const llmMaxTokens = boundedInteger("LARM_PERF_LLM_MAX_TOKENS", 64, 8, 512);
const timeoutMs = boundedInteger("LARM_PERF_TIMEOUT_MS", 300_000, 1_000, 900_000);
const scenarios = selectedScenarios(process.env.LARM_PERF_SCENARIOS ?? "all");
const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
const asrOverride = optionalAsrOverride();
const output = process.env.LARM_PERF_OUTPUT
  ? await prepareExternalOutput(absoluteOutput("LARM_PERF_OUTPUT", process.env.LARM_PERF_OUTPUT), repoRoot)
  : undefined;
const ttsText = process.env.LARM_PERF_TTS_TEXT
  ?? "音声認識と音声合成の性能を確認するためのテスト音声です。";
if (ttsText.length < 1 || ttsText.length > 2_000) {
  throw new Error("LARM_PERF_TTS_TEXT must contain between 1 and 2000 characters");
}

const client = new LarmClient({
  baseUrl,
  apiToken: process.env.LARM_API_TOKEN,
  timeoutMs,
});
const healthBefore = await client.getHealth();
const needsAudio = scenarios.includes("asr") || scenarios.includes("mixed");
const fixture = needsAudio ? await prepareAudioFixture() : undefined;
const scenarioReports: Array<ReturnType<typeof aggregateScenario>> = [];

for (const scenario of scenarios) {
  const workloads = scenarioWorkloads[scenario];
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    const result = await runIteration(scenario, 0);
    if (result.errors.length > 0) {
      throw new Error(`${scenario}_warmup_failed_${result.errors.map((item) => item.code).join("_")}`);
    }
  }
  const monitor = await startTelemetryMonitor();
  const results: IterationResult[] = [];
  try {
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      results.push(await runIteration(scenario, iteration));
    }
  } finally {
    await monitor.stop();
  }
  scenarioReports.push(aggregateScenario(scenario, workloads, results, monitor.telemetry));
}

const healthAfter = await client.getHealth();
const identityStable = healthBefore.bootEpoch === healthAfter.bootEpoch
  && healthBefore.configRevision === healthAfter.configRevision
  && healthBefore.releaseCommit === healthAfter.releaseCommit;
const comparisons = buildComparisons(scenarioReports);
const passed = identityStable
  && scenarioReports.every((scenario) => scenario.errors === 0 && scenario.telemetry.errors.length === 0);
const report = {
  schemaVersion: 1,
  kind: "larm-performance-diagnostic",
  recordedAt: new Date().toISOString(),
  passed,
  target: {
    baseUrl: redactBaseUrl(baseUrl),
    releaseCommit: healthBefore.releaseCommit,
    configRevision: healthBefore.configRevision,
    bootEpoch: healthBefore.bootEpoch,
    identityStable,
  },
  configuration: {
    scenarios,
    iterations,
    warmups,
    llmMaxTokens,
    mixedConcurrency: { llm: 1, asr: 1, tts: 1 },
    timeoutMs,
    asrProvider: asrOverride
      ? {
        mode: "external-shadow",
        baseUrl: redactBaseUrl(asrOverride.url),
        ...asrOverride.identity,
      }
      : { mode: "larm-binding" },
  },
  ...(fixture ? {
    audioFixture: {
      source: fixture.source,
      audioSeconds: round(fixture.audioSeconds),
      bytes: fixture.bytes,
    },
  } : {}),
  scenarios: scenarioReports,
  comparisons,
};
const serialized = JSON.stringify(report, null, 2);
if (output) await writeExclusive(output, serialized);
console.log(serialized);
if (!passed) process.exitCode = 1;

async function prepareAudioFixture(): Promise<AudioFixture> {
  const path = process.env.LARM_PERF_AUDIO_FILE;
  if (path) {
    if (!isAbsolute(path)) throw new Error("LARM_PERF_AUDIO_FILE must be absolute");
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("audio_fixture_invalid");
    if (metadata.size <= 0 || metadata.size > 256 * 1024 * 1024) throw new Error("audio_fixture_invalid");
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const override = optionalPositiveNumber("LARM_PERF_AUDIO_SECONDS");
    let duration: number;
    try {
      duration = wavDurationSeconds(bytes);
    } catch (cause) {
      if (override === undefined) throw cause;
      duration = override;
    }
    const suffix = extname(path).toLowerCase();
    const safeSuffix = /^\.[a-z0-9]{1,8}$/.test(suffix) ? suffix : ".wav";
    return {
      source: "file",
      filename: `fixture${safeSuffix}`,
      blob: new Blob([bytes]),
      audioSeconds: duration,
      bytes: bytes.byteLength,
    };
  }

  const generated = await client.withAllocation({
    requirements: [requirement.tts],
    allowFallback: false,
    deploymentPolicy: "existing-only",
    ttlSeconds: Math.ceil(timeoutMs / 1_000) + 30,
  }, async (allocation, larm) => {
    const started = performance.now();
    const response = await larm.speech(allocation.id, ttsRequest());
    return await consumeTtsPerformanceResponse(response, started);
  });
  return {
    source: "generated-by-tts",
    filename: "generated-fixture.wav",
    blob: new Blob([generated.audio], { type: "audio/wav" }),
    audioSeconds: generated.audioSeconds,
    bytes: generated.audio.byteLength,
  };
}

async function runIteration(scenario: ScenarioId, iteration: number): Promise<IterationResult> {
  const workloads = scenarioWorkloads[scenario];
  const managedWorkloads = workloads.filter((workload) => workload !== "asr" || !asrOverride);
  const allocationStarted = performance.now();
  try {
    const measure = async (allocation: PublicAllocation | undefined, larm: LarmClient) => {
      const allocationMs = performance.now() - allocationStarted;
      const batchStarted = performance.now();
      const launches: number[] = [];
      const outcomes = await Promise.all(workloads.map(async (workload) => {
        try {
          return { ok: true as const, sample: await execute(workload, iteration, allocation, larm, launches) };
        } catch (cause) {
          return { ok: false as const, workload, code: errorCode(cause) };
        }
      }));
      const samples = outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.sample);
      const errors = outcomes.filter((outcome) => !outcome.ok)
        .map((outcome) => ({ workload: outcome.workload, code: outcome.code }));
      return {
        iteration,
        allocationMs: round(allocationMs),
        wallTimeMs: round(performance.now() - batchStarted),
        launchSkewMs: launches.length < 2 ? 0 : round(Math.max(...launches) - Math.min(...launches)),
        samples,
        errors,
      };
    };
    if (managedWorkloads.length === 0) return await measure(undefined, client);
    return await client.withAllocation({
      requirements: managedWorkloads.map((workload) => requirement[workload]),
      allowFallback: false,
      deploymentPolicy: "existing-only",
      ttlSeconds: Math.ceil(timeoutMs / 1_000) + 30,
    }, measure);
  } catch (cause) {
    return {
      iteration,
      allocationMs: round(performance.now() - allocationStarted),
      wallTimeMs: 0,
      launchSkewMs: 0,
      samples: [],
      errors: workloads.map((workload) => ({ workload, code: errorCode(cause) })),
    };
  }
}

async function execute(
  workload: WorkloadId,
  iteration: number,
  allocation: PublicAllocation | undefined,
  larm: LarmClient,
  launches: number[],
): Promise<WorkloadSample> {
  const identity = workload === "asr" && asrOverride
    ? asrOverride.identity
    : bindingIdentity(requiredAllocation(allocation), workload);
  if (workload === "llm") {
    const started = performance.now();
    launches.push(started);
    const response = await larm.chat(requiredAllocation(allocation).id, {
      model: "larm",
      stream: false,
      max_tokens: llmMaxTokens,
      messages: [{
        role: "user",
        content: "Output the integers from 1 through 40 in order, separated by single spaces, with no other text.",
      }],
    });
    const measured = await consumeLlmPerformanceResponse(response, started);
    return { workload, iteration, status: response.status, ...identity, ...measured };
  }
  if (workload === "asr") {
    if (!fixture) throw new Error("audio_fixture_missing");
    const form = new FormData();
    form.append("file", fixture.blob, fixture.filename);
    const started = performance.now();
    launches.push(started);
    const response = asrOverride
      ? await fetch(asrOverride.url, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      })
      : await larm.transcribe(requiredAllocation(allocation).id, form);
    const measured = await consumeAsrPerformanceResponse(response, started, fixture.audioSeconds);
    return { workload, iteration, status: response.status, ...identity, ...measured };
  }
  const started = performance.now();
  launches.push(started);
  const response = await larm.speech(requiredAllocation(allocation).id, ttsRequest());
  const measured = await consumeTtsPerformanceResponse(response, started);
  const { audio: _audio, ...metrics } = measured;
  return { workload, iteration, status: response.status, ...identity, ...metrics };
}

function aggregateScenario(
  id: ScenarioId,
  workloads: WorkloadId[],
  results: IterationResult[],
  telemetry: Telemetry,
) {
  const samples = results.flatMap((result) => result.samples);
  const errors = results.flatMap((result) => result.errors);
  return {
    id,
    concurrency: Object.fromEntries(workloads.map((workload) => [workload, 1])),
    attempts: iterations * workloads.length,
    successes: samples.length,
    errors: errors.length,
    errorRate: round(errors.length / (iterations * workloads.length)),
    allocationMs: summarize(results.map((result) => result.allocationMs)),
    wallTimeMs: summarize(results.map((result) => result.wallTimeMs)),
    launchSkewMs: summarize(results.map((result) => result.launchSkewMs)),
    workloads: Object.fromEntries(workloads.map((workload) => [
      workload,
      aggregateWorkload(workload, samples.filter((sample) => sample.workload === workload), errors),
    ])),
    telemetry,
    iterations: results,
  };
}

function aggregateWorkload(
  workload: WorkloadId,
  samples: WorkloadSample[],
  scenarioErrors: Array<{ workload: WorkloadId; code: string }>,
) {
  const errors = scenarioErrors.filter((error) => error.workload === workload);
  const common = {
    attempts: samples.length + errors.length,
    successes: samples.length,
    errors: errors.length,
    errorRate: round(errors.length / (samples.length + errors.length)),
    errorCodes: countValues(errors.map((error) => error.code)),
    identities: {
      routes: unique(samples.map((sample) => sample.route)),
      runtimes: unique(samples.map((sample) => sample.runtime)),
      releases: unique(samples.map((sample) => sample.release)),
      fallbackCount: samples.filter((sample) => sample.fallback).length,
    },
    latencyMs: {
      firstByte: summarize(samples.map((sample) => sample.firstByteMs)),
      total: summarize(samples.map((sample) => sample.totalMs)),
    },
    responseBytes: summarize(samples.map((sample) => sample.responseBytes)),
  };
  if (workload === "llm") {
    const llm = samples.filter((sample): sample is LlmSample => sample.workload === "llm");
    return {
      ...common,
      latencyMs: { ...common.latencyMs, firstToken: summarize(llm.map((sample) => sample.firstTokenMs)) },
      completionTokens: summarize(llm.map((sample) => sample.completionTokens)),
      completionTokenSources: countValues(llm.map((sample) => sample.completionTokenSource)),
      outputTokensPerSecond: summarize(llm.map((sample) => sample.outputTokensPerSecond)),
    };
  }
  const audio = samples.filter((sample): sample is AsrSample | TtsSample => sample.workload === workload);
  return {
    ...common,
    audioSeconds: summarize(audio.map((sample) => sample.audioSeconds)),
    realtimeFactor: summarize(audio.map((sample) => sample.realtimeFactor)),
    audioSecondsPerSecond: summarize(audio.map((sample) => sample.audioSecondsPerSecond)),
  };
}

function buildComparisons(scenarioReports: Array<ReturnType<typeof aggregateScenario>>) {
  const mixed = scenarioReports.find((scenario) => scenario.id === "mixed");
  if (!mixed) return [];
  return (["llm", "asr", "tts"] as const).flatMap((workload) => {
    const standalone = scenarioReports.find((scenario) => scenario.id === workload);
    if (!standalone) return [];
    const standaloneWorkload = standalone.workloads[workload] as ReturnType<typeof aggregateWorkload>;
    const mixedWorkload = mixed.workloads[workload] as ReturnType<typeof aggregateWorkload>;
    const standaloneTotal = p95(standaloneWorkload.latencyMs.total);
    const mixedTotal = p95(mixedWorkload.latencyMs.total);
    const standaloneSpeed = workload === "llm"
      ? p50("outputTokensPerSecond" in standaloneWorkload ? standaloneWorkload.outputTokensPerSecond : null)
      : p50("audioSecondsPerSecond" in standaloneWorkload ? standaloneWorkload.audioSecondsPerSecond : null);
    const mixedSpeed = workload === "llm"
      ? p50("outputTokensPerSecond" in mixedWorkload ? mixedWorkload.outputTokensPerSecond : null)
      : p50("audioSecondsPerSecond" in mixedWorkload ? mixedWorkload.audioSecondsPerSecond : null);
    return [{
      workload,
      mixedVsStandalone: {
        totalLatencyP95DegradationPercent: degradationPercent(standaloneTotal, mixedTotal, true),
        processingSpeedP50DegradationPercent: degradationPercent(standaloneSpeed, mixedSpeed, false),
        errorRateDeltaPercentagePoints: round((mixedWorkload.errorRate - standaloneWorkload.errorRate) * 100),
      },
    }];
  });
}

async function startTelemetryMonitor(): Promise<{ telemetry: Telemetry; stop: () => Promise<void> }> {
  const telemetry: Telemetry = {
    samples: 0,
    systemMemoryAvailableMinBytes: null,
    acceleratorMemoryAvailableMinBytes: null,
    maxExecutionActive: 0,
    maxQueueDepth: 0,
    provider429Count: 0,
    errors: [],
  };
  let active = true;
  let before429: number | undefined;
  const observe = async () => {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/metrics`, {
        headers: process.env.LARM_API_TOKEN
          ? { authorization: `Bearer ${process.env.LARM_API_TOKEN}` }
          : undefined,
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`metrics_http_${response.status}`);
      const metrics = await response.text();
      telemetry.samples += 1;
      const system = metricSingle(metrics, "larm_system_memory_available_bytes");
      const accelerator = metricSingle(metrics, "larm_accelerator_memory_available_bytes");
      if (system !== undefined) telemetry.systemMemoryAvailableMinBytes = minimum(
        telemetry.systemMemoryAvailableMinBytes,
        system,
      );
      if (accelerator !== undefined) telemetry.acceleratorMemoryAvailableMinBytes = minimum(
        telemetry.acceleratorMemoryAvailableMinBytes,
        accelerator,
      );
      telemetry.maxExecutionActive = Math.max(
        telemetry.maxExecutionActive,
        metricSum(metrics, "larm_execution_active"),
      );
      telemetry.maxQueueDepth = Math.max(telemetry.maxQueueDepth, metricSum(metrics, "larm_execution_queued"));
      const count429 = metricSum(metrics, "larm_gateway_request_total", (line) => line.includes('status="429"'));
      before429 ??= count429;
      telemetry.provider429Count = Math.max(0, count429 - before429);
    } catch (cause) {
      const code = errorCode(cause);
      if (!telemetry.errors.includes(code)) telemetry.errors.push(code);
    }
  };
  await observe();
  const loop = (async () => {
    while (active) {
      await Bun.sleep(100);
      if (active) await observe();
    }
  })();
  return {
    telemetry,
    stop: async () => {
      active = false;
      await loop;
      await observe();
    },
  };
}

function bindingIdentity(allocation: PublicAllocation, workload: WorkloadId): Identity {
  const binding = allocation.bindings.find((candidate) => candidate.capability === requirement[workload].capability);
  if (!binding) throw new Error("binding_missing");
  return {
    route: binding.route,
    runtime: binding.runtime,
    release: binding.release ?? "unmanaged",
    fallback: binding.fallback,
  };
}

function requiredAllocation(allocation: PublicAllocation | undefined): PublicAllocation {
  if (!allocation) throw new Error("binding_missing");
  return allocation;
}

function ttsRequest() {
  return {
    model: "voicevox-core",
    input: ttsText,
    voice: "Kasukabe_Tsumugi",
    response_format: "wav",
  };
}

function selectedScenarios(value: string): ScenarioId[] {
  if (value === "all") return [...allScenarios];
  const result = value.split(",").map((item) => item.trim());
  if (result.length === 0 || result.some((item) => !allScenarios.includes(item as ScenarioId))) {
    throw new Error("LARM_PERF_SCENARIOS must be all or a comma-separated subset of llm,asr,tts,mixed");
  }
  if (new Set(result).size !== result.length) throw new Error("LARM_PERF_SCENARIOS contains duplicates");
  return allScenarios.filter((scenario) => result.includes(scenario));
}

function optionalAsrOverride(): { url: string; identity: Identity } | undefined {
  const value = process.env.LARM_PERF_ASR_URL;
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error("LARM_PERF_ASR_URL must be an HTTP loopback URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("LARM_PERF_ASR_URL must not contain credentials, query parameters, or a fragment");
  }
  return {
    url: url.toString(),
    identity: {
      route: safeIdentity("LARM_PERF_ASR_ROUTE", "stt-shadow"),
      runtime: safeIdentity("LARM_PERF_ASR_RUNTIME", "external-asr"),
      release: safeIdentity("LARM_PERF_ASR_RELEASE", "unmanaged"),
      fallback: false,
    },
  };
}

function safeIdentity(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value)) {
    throw new Error(`${name} must be a safe identifier`);
  }
  return value;
}

function boundedInteger(name: string, fallback: number, minimumValue: number, maximumValue: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimumValue || value > maximumValue) {
    throw new Error(`${name} must be between ${minimumValue} and ${maximumValue}`);
  }
  return value;
}

function optionalPositiveNumber(name: string): number | undefined {
  if (process.env[name] === undefined) return undefined;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function metricSingle(metrics: string, name: string): number | undefined {
  const line = metrics.split("\n").find((candidate) => candidate.startsWith(`${name} `));
  return line === undefined ? undefined : Number(line.trim().split(/\s+/).at(-1));
}

function metricSum(metrics: string, name: string, accept: (line: string) => boolean = () => true): number {
  return metrics.split("\n")
    .filter((line) => (line.startsWith(`${name}{`) || line.startsWith(`${name} `)) && accept(line))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1) ?? 0), 0);
}

function countValues(values: string[]): Record<string, number> {
  return Object.fromEntries([...new Set(values)].sort().map((value) => [
    value,
    values.filter((candidate) => candidate === value).length,
  ]));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function minimum(current: number | null, value: number): number {
  return current === null ? value : Math.min(current, value);
}

function p50(summary: MetricSummary | null): number | undefined {
  return summary?.p50;
}

function p95(summary: MetricSummary | null): number | undefined {
  return summary?.p95;
}

function errorCode(cause: unknown): string {
  if (cause instanceof LarmApiError) return safeCode(cause.code);
  if (cause instanceof Error && /^[a-z0-9_]{1,120}$/.test(cause.message)) return cause.message;
  return "performance_request_failed";
}

function safeCode(value: string): string {
  return /^[a-z0-9_]{1,120}$/.test(value) ? value : "larm_api_error";
}

function redactBaseUrl(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
