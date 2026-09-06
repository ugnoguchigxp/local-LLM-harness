import { expect, test } from "bun:test";
import type { AgentProviderProfile, Registry } from "@larm/core";
import type { ControlPlane } from "./controller";
import { ExecutionGate } from "./execution-gate";
import { SemanticReadiness } from "./semantic-readiness";

function wav(dataBytes = 2): Uint8Array {
  const result = new Uint8Array(44 + dataBytes);
  const view = new DataView(result.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) result[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return result;
}

function fixture(protocol: AgentProviderProfile["protocol"], capability: string) {
  let status: "HOT" | "BUSY" = "HOT";
  const runtime = {
    id: "provider-runtime",
    capability: [capability],
    protocol,
    backend: "systemd" as const,
    node: "node",
    policy: { class: "resident" as const },
    resources: {
      estimatedMemoryGB: 1,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 0,
      queueTimeoutMs: 10,
    },
    deployment: {
      service: "provider.service",
      healthPort: 8080,
      endpoint: "http://127.0.0.1:8080",
      backendEndpoint: "http://127.0.0.1:8080",
    },
  };
  const registry = {
    nodes: [{
      id: "node",
      displayName: "node",
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 8, reservedMemoryGB: 1 },
    }],
    runtimes: [runtime],
    profiles: [],
    routes: [],
  } satisfies Registry;
  const control = {
    getBootEpoch: () => "epoch-test",
    resolveAllocation: () => ({
      status: 200 as const,
      body: {
        capability,
        route: "provider-route",
        runtime: runtime.id,
        node: "node",
        endpoint: "http://127.0.0.1:8080",
        status,
        candidateRank: 1,
        fallback: false,
        selectionReason: "primary-live",
        release: "release-1",
      },
    }),
  } as unknown as ControlPlane;
  const provider: AgentProviderProfile = {
    name: "provider",
    capability,
    supportedCapabilities: [capability],
    route: "provider-route",
    publicModel: "public-model",
    protocol,
    readiness: protocol === "openai.chat-completions.v1"
      ? "llm-inference"
      : protocol === "openai.audio-transcriptions.v1"
      ? "stt-transcription"
      : "tts-speech",
  };
  return { registry, control, provider, setStatus: (value: "HOT" | "BUSY") => { status = value; } };
}

function validLlmProbeResponse(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body)) as { stream?: boolean };
  if (body.stream === true) {
    return new Response([
      'data: {"id":"chatcmpl-probe","object":"chat.completion.chunk","created":1,"model":"public-model","choices":[{"index":0,"delta":{"content":"0"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-probe","object":"chat.completion.chunk","created":1,"model":"public-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  }
  return Response.json({
    id: "chatcmpl-probe",
    object: "chat.completion",
    created: 1,
    model: "public-model",
    choices: [{ index: 0, message: { role: "assistant", content: "0" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

test("STT semantic probe sends the fixed 8,044-byte silence WAV", async () => {
  const { registry, control, provider } = fixture("openai.audio-transcriptions.v1", "speech.stt");
  let calls = 0;
  const readiness = new SemanticReadiness({
    control,
    getRegistry: () => registry,
    executionGate: new ExecutionGate(),
    timeoutMs: 100,
    fetchImpl: async (_input, init) => {
      calls += 1;
      const form = init?.body as FormData;
      expect(form.getAll("model")).toEqual(["public-model"]);
      const file = form.get("file") as File;
      expect(file.type).toBe("audio/wav");
      expect((await file.arrayBuffer()).byteLength).toBe(8_044);
      return Response.json({ text: "" });
    },
  });
  expect(await readiness.check({ allocationId: "alloc", provider })).toMatchObject({
    ready: true,
    probe: { validated: true, cached: false },
  });
  expect((await readiness.check({ allocationId: "alloc", provider })).probe?.cached).toBeTrue();
  expect(calls).toBe(1);
});

test("TTS semantic probe validates audio/wav and a nonempty RIFF data chunk", async () => {
  const { registry, control, provider } = fixture("openai.audio-speech.v1", "speech.tts");
  const bodies: unknown[] = [];
  const readiness = new SemanticReadiness({
    control,
    getRegistry: () => registry,
    executionGate: new ExecutionGate(),
    timeoutMs: 100,
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(wav(), { headers: { "content-type": "audio/wav" } });
    },
  });
  expect((await readiness.check({ allocationId: "alloc", provider })).ready).toBeTrue();
  expect(bodies).toEqual([{ model: "public-model", input: "a", response_format: "wav" }]);

  const invalid = new SemanticReadiness({
    control,
    getRegistry: () => registry,
    executionGate: new ExecutionGate(),
    timeoutMs: 100,
    fetchImpl: async () => new Response(wav(0), { headers: { "content-type": "audio/wav" } }),
  });
  expect(await invalid.check({ allocationId: "alloc", provider })).toMatchObject({
    ready: false,
    reason: "invalid_response",
  });
});

test("BUSY uses only a fresh successful cache and probe deadlines cannot stall", async () => {
  const { registry, control, provider, setStatus } = fixture("openai.chat-completions.v1", "llm.general");
  let calls = 0;
  const readiness = new SemanticReadiness({
    control,
    getRegistry: () => registry,
    executionGate: new ExecutionGate(),
    timeoutMs: 100,
    fetchImpl: async (_input, init) => {
      calls += 1;
      return validLlmProbeResponse(init);
    },
  });
  expect((await readiness.check({ allocationId: "alloc", provider })).acceptingRequests).toBeTrue();
  setStatus("BUSY");
  expect(await readiness.check({ allocationId: "alloc", provider })).toMatchObject({
    ready: true,
    acceptingRequests: false,
    probe: { cached: true },
  });
  expect(calls).toBe(2);

  const coldCache = new SemanticReadiness({
    control,
    getRegistry: () => registry,
    executionGate: new ExecutionGate(),
    timeoutMs: 100,
    fetchImpl: async () => { throw new Error("must not probe BUSY"); },
  });
  expect(await coldCache.check({ allocationId: "alloc", provider })).toMatchObject({
    ready: false,
    reason: "provider_busy",
  });

  setStatus("HOT");
  const stalled = new SemanticReadiness({
    control,
    getRegistry: () => registry,
    executionGate: new ExecutionGate(),
    timeoutMs: 5,
    fetchImpl: async () => await new Promise<Response>(() => undefined),
  });
  expect(await stalled.check({ allocationId: "alloc", provider })).toMatchObject({
    ready: false,
    reason: "probe_timeout",
  });
});

test("concurrent semantic health checks share one fixed-binding probe", async () => {
  const { registry, control, provider } = fixture("openai.chat-completions.v1", "llm.general");
  let resolveFetch!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { resolveFetch = resolve; });
  let calls = 0;
  const readiness = new SemanticReadiness({
    control,
    getRegistry: () => registry,
    executionGate: new ExecutionGate(),
    timeoutMs: 100,
    fetchImpl: async (_input, init) => {
      calls += 1;
      if ((JSON.parse(String(init?.body)) as { stream?: boolean }).stream === true) {
        return validLlmProbeResponse(init);
      }
      return await response;
    },
  });
  const first = readiness.check({ allocationId: "alloc-a", provider });
  const second = readiness.check({ allocationId: "alloc-b", provider });
  expect(calls).toBe(1);
  resolveFetch(Response.json({
    id: "chatcmpl-probe",
    object: "chat.completion",
    created: 1,
    model: "public-model",
    choices: [{ index: 0, message: { role: "assistant", content: "0" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
  expect((await first).ready).toBeTrue();
  expect((await second).ready).toBeTrue();
  expect(calls).toBe(2);
});

test("LLM semantic readiness requires both one-token JSON and OpenAI SSE", async () => {
  const { registry, control, provider } = fixture("openai.chat-completions.v1", "llm.general");
  const requests: Array<{ accept: string | null; body: unknown }> = [];
  const valid = new SemanticReadiness({
    control,
    getRegistry: () => registry,
    executionGate: new ExecutionGate(),
    timeoutMs: 100,
    fetchImpl: async (_input, init) => {
      requests.push({
        accept: new Headers(init?.headers).get("accept"),
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return validLlmProbeResponse(init);
    },
  });
  expect(await valid.check({ allocationId: "alloc", provider })).toMatchObject({
    ready: true,
    probe: { validated: true },
  });
  expect(requests).toEqual([
    {
      accept: "application/json",
      body: {
        model: "public-model",
        messages: [{ role: "user", content: "0" }],
        temperature: 0,
        max_tokens: 1,
        stream: false,
      },
    },
    {
      accept: "text/event-stream",
      body: {
        model: "public-model",
        messages: [{ role: "user", content: "0" }],
        temperature: 0,
        max_tokens: 1,
        stream: true,
      },
    },
  ]);

  for (const response of [
    new Response("data: not-json\n\ndata: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    }),
    new Response('data: {"choices":[{"index":0,"delta":{"content":"0"}}]}\n\n', {
      headers: { "content-type": "text/event-stream" },
    }),
    Response.json({ unexpected: true }),
  ]) {
    let call = 0;
    const invalid = new SemanticReadiness({
      control,
      getRegistry: () => registry,
      executionGate: new ExecutionGate(),
      timeoutMs: 100,
      fetchImpl: async () => call++ === 0
        ? Response.json({
          id: "chatcmpl-probe",
          object: "chat.completion",
          created: 1,
          model: "public-model",
          choices: [{ index: 0, message: { role: "assistant", content: "0" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        : response,
    });
    expect(await invalid.check({ allocationId: "alloc", provider })).toMatchObject({
      ready: false,
      reason: "invalid_response",
    });
  }
});

test("semantic readiness rejects successful responses with mismatched media types and cancels their bodies", async () => {
  const { registry, control, provider } = fixture("openai.chat-completions.v1", "llm.general");
  let cancelled = false;
  const readiness = new SemanticReadiness({
    control,
    getRegistry: () => registry,
    executionGate: new ExecutionGate(),
    timeoutMs: 100,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          id: "chatcmpl-probe",
          object: "chat.completion",
          created: 1,
          model: "public-model",
          choices: [{ index: 0, message: { role: "assistant", content: "0" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    }), { headers: { "content-type": "text/plain" } }),
  });
  expect(await readiness.check({ allocationId: "alloc", provider })).toMatchObject({
    ready: false,
    reason: "invalid_response",
  });
  expect(cancelled).toBeTrue();
});

test("semantic readiness cancels a response rejected by its declared size", async () => {
  const { registry, control, provider } = fixture("openai.chat-completions.v1", "llm.general");
  let cancelled = false;
  const readiness = new SemanticReadiness({
    control,
    getRegistry: () => registry,
    executionGate: new ExecutionGate(),
    timeoutMs: 100,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancelled = true;
      },
    }), {
      headers: {
        "content-type": "application/json",
        "content-length": "65537",
      },
    }),
  });
  expect(await readiness.check({ allocationId: "alloc", provider })).toMatchObject({
    ready: false,
    reason: "invalid_response",
  });
  expect(cancelled).toBeTrue();
});
