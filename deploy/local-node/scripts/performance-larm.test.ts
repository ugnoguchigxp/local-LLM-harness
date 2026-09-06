import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  encodeSaaaDelta,
  SAAA_LLM_STREAM_LIMITS,
  SAAA_LLM_STREAM_PROTOCOL,
} from "../../../packages/core/src/index";

const performanceScript = resolve(import.meta.dir, "performance-larm.ts");
const releaseCommit = "a".repeat(40);
const configRevision = "b".repeat(64);

function wav(seconds = 1, sampleRate = 16_000): Uint8Array {
  const dataBytes = Math.round(seconds * sampleRate) * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}

test("performance diagnostic measures HTTP/WS standalone and synchronized mixed workloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-performance-integration-"));
  const fixture = join(root, "fixture.wav");
  const output = join(root, "report.json");
  const shadowOutput = join(root, "shadow-report.json");
  await writeFile(fixture, wav());
  let allocationSequence = 0;
  let agentSequence = 0;
  let mixedLaunches = 0;
  let shadowRequests = 0;
  let websocketRuns = 0;
  let agentProfileRequests = 0;
  const allocations = new Map<string, Array<{ capability: string; route: string }>>();
  const agentAllocations = new Map<string, string>();
  const barriers = new Map<string, {
    workloads: Set<string>;
    promise: Promise<void>;
    resolve: () => void;
  }>();
  const headers = { "x-larm-boot-epoch": "epoch-performance" };
  let serverPort = 0;
  const server = Bun.serve<{ connected: true }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/llm/stream") {
        if (
          request.headers.get("sec-websocket-protocol") !== SAAA_LLM_STREAM_PROTOCOL
          || !request.headers.get("authorization")?.startsWith("Bearer ")
        ) return new Response("invalid upgrade", { status: 400, headers });
        if (!bunServer.upgrade(request, {
          data: { connected: true },
          headers: { "Sec-WebSocket-Protocol": SAAA_LLM_STREAM_PROTOCOL },
        })) return new Response("upgrade failed", { status: 400, headers });
        return undefined;
      }
      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          version: "0.1.0",
          releaseCommit,
          configRevision,
          bootEpoch: "epoch-performance",
        }, { headers });
      }
      if (url.pathname === "/v2/agent-profiles") {
        agentProfileRequests += 1;
        return Response.json({
          contractVersion: "agent-connection.v2",
          catalogRevision: configRevision,
          defaultAgentProfile: "coding-default",
          profiles: [{
            id: "coding-default",
            canonicalProfile: "coding-default",
            description: "Resident Qwen",
            selectionPolicy: "default",
            deprecated: false,
            providers: [{
              name: "llm",
              capability: "llm.coding",
              supportedCapabilities: ["llm.coding", "llm.general", "llm.reasoning"],
              protocol: "openai.chat-completions.v1",
              model: "coding-default",
              streamingProtocol: "saaa.llm-stream.v1",
            }],
          }],
          audiences: ["same-host"],
        }, { headers });
      }
      if (url.pathname === "/metrics") {
        return new Response([
          "larm_system_memory_available_bytes 1000000",
          "larm_accelerator_memory_available_bytes 2000000",
          'larm_execution_active{runtime="qwen-general"} 0',
          'larm_execution_queued{runtime="qwen-general"} 0',
          'larm_gateway_request_total{status="429"} 0',
          "",
        ].join("\n"), { headers });
      }
      if (url.pathname === "/v1/allocations" && request.method === "POST") {
        const body = await request.json() as {
          requirements: Array<{ capability: string; route: string }>;
          allowFallback: boolean;
          deploymentPolicy: string;
        };
        const id = `allocation-${++allocationSequence}`;
        allocations.set(id, body.requirements);
        return Response.json(allocation(id, body.requirements, body.allowFallback, body.deploymentPolicy, "ready"), {
          headers,
        });
      }
      if (url.pathname.startsWith("/v1/allocations/") && request.method === "GET") {
        const id = url.pathname.split("/").at(-1)!;
        const requirements = allocations.get(id);
        if (!requirements) return new Response("not found", { status: 404, headers });
        return Response.json(allocation(id, requirements, false, "existing-only", "ready"), { headers });
      }
      if (url.pathname.startsWith("/v1/allocations/") && request.method === "DELETE") {
        const id = url.pathname.split("/").at(-1)!;
        const requirements = allocations.get(id) ?? [{ capability: "llm.general", route: "llm-default" }];
        return Response.json(allocation(id, requirements, false, "existing-only", "released"), { headers });
      }
      if (url.pathname === "/v1/agent-connections" && request.method === "POST") {
        const id = `connection-${++agentSequence}`;
        const allocationId = `agent-allocation-${agentSequence}`;
        const requirements = [{ capability: "llm.coding", route: "llm-default" }];
        allocations.set(allocationId, requirements);
        agentAllocations.set(id, allocationId);
        return Response.json(agentConnection(id, allocationId), { status: 201, headers });
      }
      if (url.pathname.endsWith("/claim") && request.method === "POST") {
        const id = url.pathname.split("/").at(-2)!;
        const allocationId = agentAllocations.get(id);
        if (!allocationId) return new Response("not found", { status: 404, headers });
        return Response.json(agentClaim(id, allocationId, serverPort), { headers });
      }
      if (url.pathname.startsWith("/v1/agent-connections/") && request.method === "DELETE") {
        const id = url.pathname.split("/").at(-1)!;
        agentAllocations.delete(id);
        return new Response(null, { status: 204, headers });
      }
      const workload = url.pathname === "/v1/chat/completions" ? "llm"
        : url.pathname === "/v1/audio/transcriptions" ? "asr"
        : url.pathname === "/v1/audio/speech" ? "tts"
        : undefined;
      if (workload && request.method === "POST") {
        const allocationId = request.headers.get("x-larm-allocation-id") ?? "";
        const requirements = allocations.get(allocationId) ?? [];
        if (requirements.length === 3) {
          let barrier = barriers.get(allocationId);
          if (!barrier) {
            let resolveBarrier: () => void = () => undefined;
            const promise = new Promise<void>((resolvePromise) => { resolveBarrier = resolvePromise; });
            barrier = { workloads: new Set(), promise, resolve: resolveBarrier };
            barriers.set(allocationId, barrier);
          }
          barrier.workloads.add(workload);
          if (barrier.workloads.size === 3) {
            mixedLaunches += 1;
            barrier.resolve();
          }
          await Promise.race([barrier.promise, Bun.sleep(1_000)]);
          if (barrier.workloads.size !== 3) return new Response("not concurrent", { status: 503, headers });
        }
        if (workload === "llm") {
          const body = await request.json() as { stream?: boolean };
          if (body.stream === true) {
            const chunk = (choices: unknown[], usage?: Record<string, number>) => `data: ${JSON.stringify({
              id: "chatcmpl-performance",
              object: "chat.completion.chunk",
              created: 1,
              model: "larm",
              choices,
              ...(usage ? { usage } : {}),
            })}\n\n`;
            return new Response([
              chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]),
              chunk([{ index: 0, delta: { content: "1 2 3" }, finish_reason: null }]),
              chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
              chunk([], { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 }),
              "data: [DONE]\n\n",
            ].join(""), { headers: { ...headers, "content-type": "text/event-stream" } });
          }
          return new Response(
            '{"choices":[{"message":{"content":"1 2 3"}}],"usage":{"completion_tokens":6}}',
            { headers: { ...headers, "content-type": "application/json" } },
          );
        }
        if (workload === "asr") {
          return Response.json({ text: "性能テスト" }, { headers });
        }
        return new Response(wav(2), {
          headers: { ...headers, "content-type": "audio/wav", "x-voicevox-credit": "VOICEVOX" },
        });
      }
      return new Response("not found", { status: 404, headers });
    },
    websocket: {
      perMessageDeflate: false,
      open(socket) {
        socket.send(JSON.stringify({
          type: "connection.ready",
          protocol: SAAA_LLM_STREAM_PROTOCOL,
          connectionId: "connection-performance",
          upstreamTransport: "native",
          limits: {
            maxConcurrentRuns: 1,
            maxConnections: 1,
            maxActiveRunsPerConnection: 1,
            maxUnackedEvents: SAAA_LLM_STREAM_LIMITS.maxUnackedEvents,
            maxUnackedBytes: SAAA_LLM_STREAM_LIMITS.maxUnackedBytes,
            resumeWindowMs: SAAA_LLM_STREAM_LIMITS.resumeWindowMs,
            heartbeatIntervalMs: SAAA_LLM_STREAM_LIMITS.heartbeatIntervalMs,
          },
        }), false);
      },
      message(socket, wire) {
        if (typeof wire !== "string") return;
        const message = JSON.parse(wire) as { type?: string; runId?: string };
        if (message.type !== "run.start" || !message.runId) return;
        websocketRuns += 1;
        const content = new TextEncoder().encode("1 2 3");
        socket.send(JSON.stringify({ type: "run.accepted", runId: message.runId, seq: 1 }), false);
        socket.send(encodeSaaaDelta(2, content), false);
        socket.send(JSON.stringify({
          type: "response.completed",
          runId: message.runId,
          seq: 3,
          contentBytes: content.byteLength,
          contentSha256: createHash("sha256").update(content).digest("hex"),
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 6, totalTokens: 16 },
        }), false);
      },
    },
  });
  serverPort = server.port!;
  const shadowServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/v1/audio/transcriptions" || request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      shadowRequests += 1;
      return Response.json({ text: "外部ASR性能テスト" });
    },
  });

  try {
    const child = Bun.spawn(["bun", "run", performanceScript], {
      env: {
        ...Bun.env,
        LARM_BASE_URL: `http://127.0.0.1:${server.port}`,
        LARM_PERF_AUDIO_FILE: fixture,
        LARM_PERF_OUTPUT: output,
        LARM_PERF_ITERATIONS: "2",
        LARM_PERF_WARMUPS: "0",
        LARM_PERF_SCENARIOS: "all",
        LARM_API_TOKEN: "performance-test-token",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`performance child failed: ${stderr}\n${stdout}`);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({
      schemaVersion: 3,
      kind: "larm-performance-diagnostic",
      passed: true,
      audioFixture: { source: "file", audioSeconds: 1 },
      target: { identityStable: true, releaseCommit },
    });
    expect(report.scenarios.map((scenario: { id: string }) => scenario.id)).toEqual([
      "llm", "llm-sse", "llm-ws", "asr", "tts", "mixed", "mixed-sse", "mixed-ws",
    ]);
    expect(report.scenarios[1].workloads["llm-sse"]).toMatchObject({
      transports: { "http-sse": 2 },
      completionTokenSources: { usage: 2 },
      deltaEvents: { p50: 1 },
    });
    expect(report.scenarios[2].workloads["llm-ws"]).toMatchObject({
      transports: { "saaa-websocket": 2 },
      completionTokenSources: { usage: 2 },
      deltaEvents: { p50: 1 },
    });
    expect(report.scenarios[5]).toMatchObject({ attempts: 6, successes: 6, errors: 0 });
    expect(report.scenarios[6]).toMatchObject({ attempts: 6, successes: 6, errors: 0 });
    expect(report.scenarios[7]).toMatchObject({ attempts: 6, successes: 6, errors: 0 });
    expect(report.comparisons.mixedVsStandalone).toHaveLength(9);
    expect(report.comparisons.llmTransport).toMatchObject({
      baseline: "llm-sse",
      candidate: "llm-ws",
      completionTokensP50: { httpSse: 6, websocket: 6 },
    });
    expect(mixedLaunches).toBe(4);
    expect(websocketRuns).toBe(4);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(report);

    const shadowChild = Bun.spawn(["bun", "run", performanceScript], {
      env: {
        ...Bun.env,
        LARM_BASE_URL: `http://127.0.0.1:${server.port}`,
        LARM_PERF_ASR_URL: `http://127.0.0.1:${shadowServer.port}/v1/audio/transcriptions`,
        LARM_PERF_ASR_RUNTIME: "reazonspeech-shadow",
        LARM_PERF_AUDIO_FILE: fixture,
        LARM_PERF_OUTPUT: shadowOutput,
        LARM_PERF_ITERATIONS: "2",
        LARM_PERF_WARMUPS: "0",
        LARM_PERF_SCENARIOS: "asr,mixed",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [shadowExitCode, shadowStdout, shadowStderr] = await Promise.all([
      shadowChild.exited,
      new Response(shadowChild.stdout).text(),
      new Response(shadowChild.stderr).text(),
    ]);
    expect(shadowStderr).toBe("");
    expect(shadowExitCode).toBe(0);
    const shadowReport = JSON.parse(shadowStdout);
    expect(shadowReport.configuration.asrProvider).toMatchObject({
      mode: "external-shadow",
      runtime: "reazonspeech-shadow",
    });
    expect(shadowReport.scenarios[0].workloads.asr.identities).toMatchObject({
      routes: ["stt-shadow"],
      runtimes: ["reazonspeech-shadow"],
    });
    expect(shadowRequests).toBe(4);
    expect(agentProfileRequests).toBe(1);
    expect(JSON.parse(await readFile(shadowOutput, "utf8"))).toEqual(shadowReport);
  } finally {
    server.stop(true);
    shadowServer.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

function allocation(
  id: string,
  requirements: Array<{ capability: string; route: string }>,
  allowFallback: boolean,
  deploymentPolicy: string,
  status: "ready" | "released",
) {
  const now = "2026-08-31T00:00:00.000Z";
  return {
    id,
    bootEpoch: "epoch-performance",
    catalogRevision: configRevision,
    status,
    requirements,
    bindings: requirements.map((requirement) => ({
      capability: requirement.capability,
      route: requirement.route,
      runtime: requirement.capability.startsWith("llm.") ? "qwen-general"
        : requirement.capability === "speech.stt" ? "qwen-asr"
        : "voicevox-tts",
      node: "local-node",
      status: "HOT",
      candidateRank: 1,
      fallback: false,
      selectionReason: "primary_ready",
      release: `${requirement.route}-current`,
    })),
    allowFallback,
    deploymentPolicy,
    createdAt: now,
    expiresAt: "2026-08-31T00:10:00.000Z",
    ...(status === "released" ? { releasedAt: now } : {}),
  };
}

function agentConnection(id: string, allocationId: string) {
  const now = "2026-08-31T00:00:00.000Z";
  return {
    id,
    allocationId,
    bootEpoch: "epoch-performance",
    catalogRevision: configRevision,
    agentProfile: "coding-default",
    profileRevision: "c".repeat(64),
    audience: "same-host",
    audienceRevision: "d".repeat(64),
    status: "ready",
    providers: [{
      name: "llm",
      capability: "llm.coding",
      route: "llm-default",
      protocol: "openai.chat-completions.v1",
      publicModel: "coding-default",
      readiness: "ready",
      claimable: true,
    }],
    createdAt: now,
    expiresAt: "2026-08-31T00:10:00.000Z",
  };
}

function agentClaim(id: string, allocationId: string, port: number) {
  const expiresAt = "2026-08-31T00:10:00.000Z";
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  return {
    id,
    allocationId,
    status: "ready",
    audience: "same-host",
    providers: [{
      name: "llm",
      capability: "llm.coding",
      apiStyle: "openai",
      protocol: "openai.chat-completions.v1",
      scheme: "http",
      host: "127.0.0.1",
      port,
      baseUrl,
      model: "coding-default",
      health: {
        url: `${baseUrl}/agent-connections/${id}/providers/llm/health`,
        kind: "semantic-inference",
        maxAgeMs: 10_000,
      },
      credential: { type: "bearer", token: "performance-provider-token", expiresAt },
      configuration: {
        kind: "openai-provider-v1",
        fields: { baseURL: baseUrl, model: "coding-default" },
        secretFields: { apiKey: "credential.token" },
      },
      streaming: {
        protocol: SAAA_LLM_STREAM_PROTOCOL,
        url: `ws://127.0.0.1:${port}/v1/llm/stream`,
        encoding: "json-control+binary-delta-v1",
        compression: "none",
        maxConcurrentRuns: 1,
        maxConnections: 1,
        resumeWindowMs: 120_000,
        upstreamTransport: "native",
      },
    }],
    expiresAt,
  };
}
