import { lstat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { LarmApiError, LarmClient } from "../../../packages/client/src/index";
import type { AgentConnectionClaim, PublicAllocation } from "../../../packages/core/src/index";
import { absoluteOutput, prepareExternalOutput, writeExclusive } from "./benchmark-helpers";
import {
  consumeAsrPerformanceResponse,
  consumeLlmPerformanceResponse,
  consumeLlmSsePerformanceResponse,
  consumeTtsPerformanceResponse,
  degradationPercent,
  summarize,
  wavDurationSeconds,
  type MetricSummary,
} from "./performance-helpers";
import { runSaaaWebSocketSmoke } from "./smoke-saaa-websocket";

type WorkloadId = "llm" | "llm-sse" | "llm-ws" | "asr" | "tts";
type ManagedWorkloadId = Exclude<WorkloadId, "llm-ws">;
type ScenarioId = WorkloadId | "mixed" | "mixed-sse" | "mixed-ws";
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
  workload: "llm" | "llm-sse" | "llm-ws";
  transport: "http-json" | "http-sse" | "saaa-websocket";
  firstTokenMs: number;
  completionTokens: number;
  completionTokenSource: "usage" | "content-events";
  outputTokensPerSecond: number;
  deltaEvents: number | null;
};
type AudioSample = CommonSample & {
  audioSeconds: number;
  realtimeFactor: number;
  audioSecondsPerSecond: number;
};
type AsrSample = AudioSample & { workload: "asr" };
type TtsSample = AudioSample & { workload: "tts"; firstPlayableAudioMs: number };
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
type WebSocketExecution = {
  claim: AgentConnectionClaim;
  allocation: PublicAllocation;
};

const allScenarios = ["llm", "llm-sse", "llm-ws", "asr", "tts", "mixed", "mixed-sse", "mixed-ws"] as const;
const scenarioWorkloads: Record<ScenarioId, WorkloadId[]> = {
  llm: ["llm"],
  "llm-sse": ["llm-sse"],
  "llm-ws": ["llm-ws"],
  asr: ["asr"],
  tts: ["tts"],
  mixed: ["llm", "asr", "tts"],
  "mixed-sse": ["llm-sse", "asr", "tts"],
  "mixed-ws": ["llm-ws", "asr", "tts"],
};
const requirement = {
  llm: { capability: "llm.general", route: "llm-default" },
  "llm-sse": { capability: "llm.general", route: "llm-default" },
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
const wsAgentProfileOverride = process.env.LARM_PERF_WS_AGENT_PROFILE
  ? safeIdentity("LARM_PERF_WS_AGENT_PROFILE", process.env.LARM_PERF_WS_AGENT_PROFILE)
  : undefined;
const wsAudience = safeIdentity("LARM_PERF_WS_AUDIENCE", "same-host");
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
const needsWebSocket = scenarios.some((scenario) => scenarioWorkloads[scenario].includes("llm-ws"));
let wsAgentProfile: string | undefined;
let explicitWsAgentProfile = false;
if (needsWebSocket) {
  const agentProfiles = await client.listAgentProfiles();
  wsAgentProfile = wsAgentProfileOverride ?? agentProfiles.defaultAgentProfile;
  const wsProfile = agentProfiles.profiles.find((profile) => profile.id === wsAgentProfile);
  if (!wsProfile) throw new Error(`WebSocket Agent Profile ${wsAgentProfile} is not advertised`);
  if (!wsAgentProfileOverride && wsProfile.selectionPolicy !== "default") {
    throw new Error("default Agent Profile is not marked as default");
  }
  if (!wsProfile.providers.some((provider) => provider.streamingProtocol === "saaa.llm-stream.v1")) {
    throw new Error(`WebSocket Agent Profile ${wsAgentProfile} does not advertise saaa.llm-stream.v1`);
  }
  explicitWsAgentProfile = wsProfile.selectionPolicy === "explicit-only";
}
const needsAudio = scenarios.some((scenario) => scenarioWorkloads[scenario].includes("asr"));
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
  schemaVersion: 3,
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
    websocket: {
      agentProfile: wsAgentProfile ?? null,
      audience: wsAudience,
      runPerConnection: 1,
      latencyIncludesHandshake: true,
    },
    mixedConcurrency: {
      mixed: { llm: 1, asr: 1, tts: 1 },
      "mixed-sse": { "llm-sse": 1, asr: 1, tts: 1 },
      "mixed-ws": { "llm-ws": 1, asr: 1, tts: 1 },
    },
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
  const needsWebSocket = workloads.includes("llm-ws");
  const managedWorkloads = workloads.filter(isManagedWorkload)
    .filter((workload) => workload !== "asr" || !asrOverride);
  const allocationStarted = performance.now();
  try {
    const measure = async (
      allocation: PublicAllocation | undefined,
      larm: LarmClient,
      websocket: WebSocketExecution | undefined,
    ) => {
      const allocationMs = performance.now() - allocationStarted;
      const batchStarted = performance.now();
      const launches: number[] = [];
      const outcomes = await Promise.all(workloads.map(async (workload) => {
        try {
          return {
            ok: true as const,
            sample: await execute(workload, iteration, allocation, websocket, larm, launches),
          };
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
    const withManagedAllocation = async (larm: LarmClient, websocket?: WebSocketExecution) => {
      if (managedWorkloads.length === 0) return await measure(undefined, larm, websocket);
      return await larm.withAllocation({
        requirements: managedWorkloads.map((workload) => requirement[workload]),
        allowFallback: false,
        deploymentPolicy: "existing-only",
        ttlSeconds: Math.ceil(timeoutMs / 1_000) + 30,
      }, async (allocation, allocationClient) => await measure(allocation, allocationClient, websocket));
    };
    if (!needsWebSocket) return await withManagedAllocation(client);
    return await client.withAgentConnection({
      agentProfile: wsAgentProfile!,
      ...(explicitWsAgentProfile ? { explicitAgentProfile: true } : {}),
      audience: wsAudience,
      client: "larm-performance",
      ttlSeconds: Math.ceil(timeoutMs / 1_000) + 30,
      allowFallback: false,
      deploymentPolicy: "existing-only",
    }, async (_connection, claim, larm) => {
      const allocation = await larm.getAllocation(claim.allocationId);
      return await withManagedAllocation(larm, { claim, allocation });
    });
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
  websocket: WebSocketExecution | undefined,
  larm: LarmClient,
  launches: number[],
): Promise<WorkloadSample> {
  const identity = workload === "llm-ws"
    ? bindingIdentity(requiredWebSocket(websocket).allocation, workload)
    : workload === "asr" && asrOverride
    ? asrOverride.identity
    : bindingIdentity(requiredAllocation(allocation), workload);
  if (workload === "llm" || workload === "llm-sse") {
    const started = performance.now();
    launches.push(started);
    const streaming = workload === "llm-sse";
    const response = await larm.chat(requiredAllocation(allocation).id, {
      model: "larm",
      stream: streaming,
      ...(streaming ? { stream_options: { include_usage: true } } : {}),
      max_tokens: llmMaxTokens,
      messages: [{
        role: "user",
        content: "Output the integers from 1 through 40 in order, separated by single spaces, with no other text.",
      }],
    });
    const measured = streaming
      ? await consumeLlmSsePerformanceResponse(response, started)
      : await consumeLlmPerformanceResponse(response, started);
    const deltaEvents = "deltaEvents" in measured && typeof measured.deltaEvents === "number"
      ? measured.deltaEvents
      : null;
    return {
      workload,
      iteration,
      status: response.status,
      transport: streaming ? "http-sse" : "http-json",
      deltaEvents,
      ...identity,
      ...measured,
    };
  }
  if (workload === "llm-ws") {
    const execution = requiredWebSocket(websocket);
    const provider = execution.claim.providers.find((candidate) =>
      candidate.capability.startsWith("llm.") && candidate.streaming
    );
    if (!provider?.streaming) throw new Error("saaa_streaming_not_advertised");
    const started = performance.now();
    launches.push(started);
    const measured = await runSaaaWebSocketSmoke({
      url: provider.streaming.url,
      token: provider.credential.token,
      allocationId: execution.claim.allocationId,
      model: provider.model,
      timeoutMs,
      prompt: "Output the integers from 1 through 40 in order, separated by single spaces, with no other text.",
      maxOutputTokens: llmMaxTokens,
    });
    const reportedCompletionTokens = measured.usage?.completionTokens;
    const hasCompletionUsage = reportedCompletionTokens !== null
      && reportedCompletionTokens !== undefined
      && reportedCompletionTokens > 0;
    const completionTokens = hasCompletionUsage
      ? reportedCompletionTokens
      : measured.deltas;
    return {
      workload,
      iteration,
      status: 101,
      transport: "saaa-websocket",
      firstByteMs: measured.firstDeltaMs,
      firstTokenMs: measured.firstDeltaMs,
      totalMs: measured.durationMs,
      responseBytes: measured.contentBytes,
      completionTokens,
      completionTokenSource: hasCompletionUsage ? "usage" : "content-events",
      outputTokensPerSecond: round(completionTokens / Math.max(measured.durationMs / 1_000, 0.001)),
      deltaEvents: measured.deltas,
      ...identity,
    };
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
  if (workload === "llm" || workload === "llm-sse" || workload === "llm-ws") {
    const llm = samples.filter((sample): sample is LlmSample =>
      sample.workload === "llm" || sample.workload === "llm-sse" || sample.workload === "llm-ws"
    );
    return {
      ...common,
      transports: countValues(llm.map((sample) => sample.transport)),
      latencyMs: { ...common.latencyMs, firstToken: summarize(llm.map((sample) => sample.firstTokenMs)) },
      completionTokens: summarize(llm.map((sample) => sample.completionTokens)),
      completionTokenSources: countValues(llm.map((sample) => sample.completionTokenSource)),
      outputTokensPerSecond: summarize(llm.map((sample) => sample.outputTokensPerSecond)),
      deltaEvents: summarize(llm.flatMap((sample) => sample.deltaEvents === null ? [] : [sample.deltaEvents])),
    };
  }
  const audio = samples.filter((sample): sample is AsrSample | TtsSample => sample.workload === workload);
  const audioLatency = workload === "tts"
    ? {
      ...common.latencyMs,
      firstPlayableAudio: summarize(
        audio.filter((sample): sample is TtsSample => sample.workload === "tts")
          .map((sample) => sample.firstPlayableAudioMs),
      ),
    }
    : common.latencyMs;
  return {
    ...common,
    latencyMs: audioLatency,
    audioSeconds: summarize(audio.map((sample) => sample.audioSeconds)),
    realtimeFactor: summarize(audio.map((sample) => sample.realtimeFactor)),
    audioSecondsPerSecond: summarize(audio.map((sample) => sample.audioSecondsPerSecond)),
  };
}

function buildComparisons(scenarioReports: Array<ReturnType<typeof aggregateScenario>>) {
  const mixedVsStandalone = ([
    { scenario: "mixed", workloads: ["llm", "asr", "tts"] },
    { scenario: "mixed-sse", workloads: ["llm-sse", "asr", "tts"] },
    { scenario: "mixed-ws", workloads: ["llm-ws", "asr", "tts"] },
  ] as const).flatMap(({ scenario, workloads }) => {
    const mixed = scenarioReports.find((candidate) => candidate.id === scenario);
    if (!mixed) return [];
    return workloads.flatMap((workload) => {
      const standalone = scenarioReports.find((candidate) => candidate.id === workload);
      if (!standalone) return [];
      const standaloneWorkload = standalone.workloads[workload] as ReturnType<typeof aggregateWorkload>;
      const mixedWorkload = mixed.workloads[workload] as ReturnType<typeof aggregateWorkload>;
      const standaloneSpeed = workload === "llm" || workload === "llm-sse" || workload === "llm-ws"
        ? p50("outputTokensPerSecond" in standaloneWorkload ? standaloneWorkload.outputTokensPerSecond : null)
        : p50("audioSecondsPerSecond" in standaloneWorkload ? standaloneWorkload.audioSecondsPerSecond : null);
      const mixedSpeed = workload === "llm" || workload === "llm-sse" || workload === "llm-ws"
        ? p50("outputTokensPerSecond" in mixedWorkload ? mixedWorkload.outputTokensPerSecond : null)
        : p50("audioSecondsPerSecond" in mixedWorkload ? mixedWorkload.audioSecondsPerSecond : null);
      return [{
        scenario,
        workload,
        totalLatencyP95DegradationPercent: degradationPercent(
          p95(standaloneWorkload.latencyMs.total),
          p95(mixedWorkload.latencyMs.total),
          true,
        ),
        processingSpeedP50DegradationPercent: degradationPercent(standaloneSpeed, mixedSpeed, false),
        errorRateDeltaPercentagePoints: round((mixedWorkload.errorRate - standaloneWorkload.errorRate) * 100),
      }];
    });
  });
  const http = scenarioReports.find((scenario) => scenario.id === "llm-sse")?.workloads["llm-sse"];
  const websocket = scenarioReports.find((scenario) => scenario.id === "llm-ws")?.workloads["llm-ws"];
  const llmTransport = http && websocket && "outputTokensPerSecond" in http && "outputTokensPerSecond" in websocket
    ? {
      baseline: "llm-sse",
      candidate: "llm-ws",
      firstTokenP50DegradationPercent: degradationPercent(
        p50("firstToken" in http.latencyMs ? http.latencyMs.firstToken : null),
        p50("firstToken" in websocket.latencyMs ? websocket.latencyMs.firstToken : null),
        true,
      ),
      totalLatencyP95DegradationPercent: degradationPercent(
        p95(http.latencyMs.total),
        p95(websocket.latencyMs.total),
        true,
      ),
      processingSpeedP50DegradationPercent: degradationPercent(
        p50(http.outputTokensPerSecond),
        p50(websocket.outputTokensPerSecond),
        false,
      ),
      completionTokensP50: {
        httpSse: p50("completionTokens" in http ? http.completionTokens : null) ?? null,
        websocket: p50("completionTokens" in websocket ? websocket.completionTokens : null) ?? null,
      },
    }
    : null;
  return { mixedVsStandalone, llmTransport };
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
  const binding = allocation.bindings.find((candidate) => workload === "llm-ws"
    ? candidate.capability.startsWith("llm.")
    : candidate.capability === requirement[workload].capability
  );
  if (!binding) throw new Error("binding_missing");
  return {
    route: binding.route,
    runtime: binding.runtime,
    release: binding.release ?? "unmanaged",
    fallback: binding.fallback,
  };
}

function isManagedWorkload(workload: WorkloadId): workload is ManagedWorkloadId {
  return workload !== "llm-ws";
}

function requiredWebSocket(websocket: WebSocketExecution | undefined): WebSocketExecution {
  if (!websocket) throw new Error("saaa_connection_missing");
  return websocket;
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
    throw new Error(
      "LARM_PERF_SCENARIOS must be all or a comma-separated subset of llm,llm-sse,llm-ws,asr,tts,mixed,mixed-sse,mixed-ws",
    );
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
