import { expect, test } from "bun:test";
import {
  parseAgentConnectionCatalog,
  saaaServiceHarnessSchema,
  type Registry,
} from "@larm/core";
import type { RuntimeBackend, RuntimeHealth } from "@larm/backends";
import { createApp, type AppDeps } from "./app";
import { ControlPlane } from "./controller";
import { Observer } from "./observer";

const runtime = (
  id: string,
  capability: string,
  protocol: Registry["runtimes"][number]["protocol"],
  port: number,
) => ({
  id,
  capability: [capability],
  protocol,
  backend: "systemd" as const,
  node: "local-node",
  policy: { class: "resident" as const },
  resources: {
    estimatedMemoryGB: 1,
    maxConcurrentRequests: 1,
    maxQueuedRequests: 0,
    queueTimeoutMs: 100,
  },
  deployment: {
    service: `${id}.service`,
    healthPort: port,
    endpoint: `http://127.0.0.1:${port}`,
  },
});

const registry: Registry = {
  nodes: [{
    id: "local-node",
    endpoint: "http://127.0.0.1",
    resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
  }],
  runtimes: [
    runtime("qwen-general", "llm.general", "openai.chat-completions.v1", 8080),
    runtime("qwen-asr", "speech.stt", "openai.audio-transcriptions.v1", 8081),
    runtime("voicevox", "speech.tts", "openai.audio-speech.v1", 8084),
    runtime("qwen-tts", "speech.tts.expressive", "openai.audio-speech.v1", 8082),
  ],
  profiles: [],
  routes: [
    { id: "llm-default", capabilities: ["llm.general"], explicitOnly: false, candidates: [{ runtime: "qwen-general", purpose: "primary" }] },
    { id: "stt-default", capabilities: ["speech.stt"], explicitOnly: false, candidates: [{ runtime: "qwen-asr", purpose: "primary" }] },
    { id: "stt-qwen", capabilities: ["speech.stt"], explicitOnly: true, candidates: [{ runtime: "qwen-asr", purpose: "primary" }] },
    { id: "tts-default", capabilities: ["speech.tts"], explicitOnly: false, candidates: [{ runtime: "voicevox", purpose: "primary" }] },
    { id: "tts-expressive", capabilities: ["speech.tts.expressive"], explicitOnly: false, candidates: [{ runtime: "qwen-tts", purpose: "primary" }] },
  ],
};

const speechAgentCatalog = parseAgentConnectionCatalog({
  version: 1,
  defaultAgentProfile: "voice",
  audiences: {
    loopback: { network: "loopback", baseUrl: "http://127.0.0.1:9810/v1" },
  },
  agentProfiles: {
    voice: {
      description: "Default speech provider",
      providers: [{
        name: "tts",
        capability: "speech.tts",
        route: "tts-default",
        publicModel: "voicevox-core",
        readiness: "tts-speech",
      }],
    },
    asr: {
      description: "Explicit ASR provider",
      providers: [{
        name: "asr",
        capability: "speech.stt",
        route: "stt-qwen",
        publicModel: "qwen3-asr-1.7b",
        readiness: "stt-transcription",
      }],
    },
  },
}, registry);

async function makeSpeechApp(options: Partial<AppDeps>) {
  const health = (id: string): RuntimeHealth => ({
    runtimeId: id,
    service: "Running",
    listening: true,
    healthOk: true,
    busy: false,
    httpStatus: 200,
  });
  const backend: RuntimeBackend = {
    list: async () => registry.runtimes.map((candidate) => health(candidate.id)),
    health: async (id) => health(id),
    ensure: async (candidate) => health(candidate.id),
    stop: async () => undefined,
  };
  const observer = new Observer(registry, backend);
  await observer.tick();
  const control = new ControlPlane(registry, backend, observer, {
    bootEpoch: "epoch-speech",
    random: () => crypto.randomUUID(),
  });
  return createApp({
    registry,
    getState: () => observer.getState(),
    control,
    identity: {
      version: "test",
      releaseCommit: "development",
      configRevision: "test",
      bootEpoch: "epoch-speech",
    },
    agentConnectionCatalog: speechAgentCatalog,
    ...options,
  });
}

async function allocate(app: ReturnType<typeof createApp>, requirements: object[]) {
  const response = await app.request("/v1/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requirements }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

test("Service Harness advertises batch ASR on the request origin without requiring Bearer", async () => {
  const app = await makeSpeechApp({ apiToken: "control-token" });
  const response = await app.request("http://provider.test:9810/v1/services");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(saaaServiceHarnessSchema.parse(await response.json())).toEqual({
    contractVersion: "saaa-service-harness.v2",
    revision: "test",
    services: [{
      capability: "asr",
      protocol: "openai.audio-transcriptions.v1",
      baseUrl: "http://provider.test:9810/v1",
      model: "qwen3-asr-1.7b",
      language: "auto",
      healthUrl: "http://provider.test:9810/v1/services/asr/health",
    }],
  });
  const health = await app.request("http://provider.test:9810/v1/services/asr/health");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok", model: "qwen3-asr-1.7b" });
});

test("Service Harness authentication switch requires Bearer only when enabled", async () => {
  const app = await makeSpeechApp({
    apiToken: "control-token",
    serviceHarnessAuthEnabled: true,
  });
  expect((await app.request("/v1/services")).status).toBe(401);
  expect((await app.request("/v1/services", {
    headers: { authorization: "Bearer wrong" },
  })).status).toBe(401);
  expect((await app.request("/v1/services", {
    headers: { authorization: "Bearer control-token" },
  })).status).toBe(200);
  expect((await app.request("/v1/audio/transcriptions", {
    method: "POST",
    body: "audio",
  })).status).toBe(401);
});

test("Service Harness batch ASR proxies without an allocation when authentication is off", async () => {
  let target = "";
  let uploaded = "";
  const app = await makeSpeechApp({
    apiToken: "control-token",
    gatewayFetch: async (input, init) => {
      target = String(input);
      uploaded = await new Response(init?.body).text();
      return Response.json({ text: "到達しました" });
    },
  });
  const response = await app.request("/v1/audio/transcriptions", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=test" },
    body: "--test\r\ncontent\r\n--test--\r\n",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "到達しました" });
  expect(target).toBe("http://127.0.0.1:8081/v1/audio/transcriptions");
  expect(uploaded).toContain("content");
  expect((await app.request("/v1/audio/transcriptions", {
    method: "POST",
    headers: { "x-larm-allocation-id": "alloc_existing" },
    body: "audio",
  })).status).toBe(401);
  expect((await app.request("/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: "Bearer wrong" },
    body: "audio",
  })).status).toBe(401);
});

test("standard Bearer transcription resolves its model without an allocation header", async () => {
  let target = "";
  let internalHeader: string | null = "unexpected";
  let uploadedModel = "";
  const app = await makeSpeechApp({
    apiToken: "control-token",
    gatewayFetch: async (input, init) => {
      target = String(input);
      internalHeader = new Headers(init?.headers).get("x-larm-allocation-id");
      const request = new Response(init?.body, {
        headers: { "content-type": new Headers(init?.headers).get("content-type") ?? "" },
      });
      uploadedModel = String((await request.formData()).get("model"));
      return Response.json({ text: "", language: "" });
    },
  });
  const form = new FormData();
  form.append("model", "qwen3-asr-1.7b");
  form.append("file", new Blob(["audio"], { type: "audio/wav" }), "sample.wav");
  const response = await app.request("/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: "Bearer control-token" },
    body: form,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "" });
  expect(target).toBe("http://127.0.0.1:8081/v1/audio/transcriptions");
  expect(uploadedModel).toBe("qwen3-asr-1.7b");
  expect(internalHeader).toBeNull();
});

test("standard transcription rejects a successful upstream response with an invalid public contract", async () => {
  const app = await makeSpeechApp({
    apiToken: "control-token",
    gatewayFetch: async () => Response.json({ transcript: "wrong field" }),
  });
  const form = new FormData();
  form.append("model", "qwen3-asr-1.7b");
  form.append("file", new Blob(["audio"], { type: "audio/wav" }), "sample.wav");
  const response = await app.request("/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: "Bearer control-token" },
    body: form,
  });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "upstream_response_invalid", type: "server_error" }),
  });
});

test("standard Bearer speech resolves its model and rejects a model for another protocol", async () => {
  const targets: string[] = [];
  const app = await makeSpeechApp({
    apiToken: "control-token",
    gatewayFetch: async (input) => {
      targets.push(String(input));
      return new Response("RIFF", { headers: { "content-type": "audio/wav" } });
    },
  });
  const response = await app.request("/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: "Bearer control-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "voicevox-core", input: "こんにちは", voice: "1" }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("RIFF");
  expect(targets).toEqual(["http://127.0.0.1:8084/v1/audio/speech"]);

  const mismatch = await app.request("/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: "Bearer control-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "qwen3-asr-1.7b", input: "wrong endpoint" }),
  });
  expect(mismatch.status).toBe(404);
  expect(await mismatch.json()).toEqual({
    error: expect.objectContaining({ code: "model_not_found", param: "model" }),
  });
  expect(targets).toHaveLength(1);
});

test("standard speech rejects an upstream media type that disagrees with response_format", async () => {
  const app = await makeSpeechApp({
    apiToken: "control-token",
    gatewayFetch: async () => Response.json({ error: "not audio" }),
  });
  const response = await app.request("/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: "Bearer control-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "voicevox-core", input: "こんにちは", response_format: "wav" }),
  });

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "upstream_response_format_mismatch", type: "server_error" }),
  });
});

test("standard Bearer voice discovery resolves the model from the query without a GET body", async () => {
  let target = "";
  let method = "";
  let body: RequestInit["body"] = "unexpected";
  const app = await makeSpeechApp({
    apiToken: "control-token",
    gatewayFetch: async (input, init) => {
      target = String(input);
      method = init?.method ?? "";
      body = init?.body;
      return Response.json({ voices: [{ name: "Kasukabe_Tsumugi" }] });
    },
  });

  const response = await app.request("/v1/audio/voices?model=voicevox-core", {
    headers: { authorization: "Bearer control-token" },
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ voices: [{ name: "Kasukabe_Tsumugi" }] });
  expect(target).toBe("http://127.0.0.1:8084/v1/audio/voices?model=voicevox-core");
  expect(method).toBe("GET");
  expect(body).toBeUndefined();
});

test("standard Bearer voice discovery requires exactly one model query parameter", async () => {
  const app = await makeSpeechApp({
    apiToken: "control-token",
    gatewayFetch: async () => Response.json({ voices: [] }),
  });
  const headers = { authorization: "Bearer control-token" };

  const missing = await app.request("/v1/audio/voices", { headers });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({
    error: expect.objectContaining({ code: "invalid_request", param: "model" }),
  });

  const duplicate = await app.request(
    "/v1/audio/voices?model=voicevox-core&model=voicevox-core",
    { headers },
  );
  expect(duplicate.status).toBe(400);

  const unexpected = await app.request(
    "/v1/audio/voices?model=voicevox-core&extra=true",
    { headers },
  );
  expect(unexpected.status).toBe(400);
});

test("standard Bearer speech accepts parameterized PCM media types", async () => {
  const app = await makeSpeechApp({
    apiToken: "control-token",
    gatewayFetch: async () => new Response(new Uint8Array([0, 1]), {
      headers: {
        "content-type": "audio/pcm;rate=24000;channels=1;format=s16le",
        "x-audio-sample-rate": "24000",
        "x-audio-sample-format": "s16le",
      },
    }),
  });
  const response = await app.request("/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: "Bearer control-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "voicevox-core",
      input: "接続を確認しました。",
      voice: "Kasukabe_Tsumugi",
      response_format: "pcm",
    }),
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("audio/pcm;rate=24000;channels=1;format=s16le");
  expect(response.headers.get("x-audio-sample-rate")).toBe("24000");
  expect(response.headers.get("x-audio-sample-format")).toBe("s16le");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1]));
});

test("STT gateway streams multipart bytes to the allocated transcription runtime", async () => {
  let target = "";
  let uploaded = "";
  let contentType = "";
  const app = await makeSpeechApp({
    gatewayFetch: async (input, init) => {
      target = String(input);
      contentType = new Headers(init?.headers).get("content-type") ?? "";
      uploaded = await new Response(init?.body).text();
      return Response.json({ text: "こんにちは" });
    },
  });
  const allocationId = await allocate(app, [
    { capability: "speech.stt", route: "stt-default" },
  ]);
  const response = await app.request("/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=test",
      "x-larm-allocation-id": allocationId,
    },
    body: "--test\r\ncontent\r\n--test--\r\n",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "こんにちは" });
  expect(target).toBe("http://127.0.0.1:8081/v1/audio/transcriptions");
  expect(contentType).toContain("boundary=test");
  expect(uploaded).toContain("content");
});

test("STT gateway rejects a chunked body that crosses the streaming limit", async () => {
  const app = await makeSpeechApp({
    speechMaxBodyBytes: 4,
    gatewayFetch: async (_input, init) => {
      await new Response(init?.body).arrayBuffer();
      return Response.json({ text: "unexpected" });
    },
  });
  const allocationId = await allocate(app, [
    { capability: "speech.stt", route: "stt-default" },
  ]);
  const response = await app.request("/v1/audio/transcriptions", {
    method: "POST",
    headers: { "x-larm-allocation-id": allocationId },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123"));
        controller.enqueue(new TextEncoder().encode("45"));
        controller.close();
      },
    }),
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "body_too_large" }),
  });
});

test("STT gateway rejects an upstream that cancels the request upload early", async () => {
  const app = await makeSpeechApp({
    gatewayFetch: async (_input, init) => {
      await (init?.body as ReadableStream<Uint8Array>).cancel(new Error("upload rejected"));
      return Response.json({ text: "incomplete" });
    },
  });
  const allocationId = await allocate(app, [
    { capability: "speech.stt", route: "stt-default" },
  ]);
  const response = await app.request("/v1/audio/transcriptions", {
    method: "POST",
    headers: { "x-larm-allocation-id": allocationId },
    body: "audio-bytes",
  });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: expect.objectContaining({ code: "request_upload_incomplete" }),
  });
});

test("TTS gateway uses explicit capability selection and preserves provider headers", async () => {
  const targets: string[] = [];
  const app = await makeSpeechApp({
    gatewayFetch: async (input) => {
      targets.push(String(input));
      return new Response("RIFF", {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "x-voicevox-credit": "VOICEVOX%3A%E6%98%A5%E6%97%A5%E9%83%A8%E3%81%A4%E3%82%80%E3%81%8E",
        },
      });
    },
  });
  const allocationId = await allocate(app, [
    { capability: "speech.tts", route: "tts-default" },
    { capability: "speech.tts.expressive", route: "tts-expressive" },
  ]);
  const ambiguous = await app.request("/v1/audio/speech", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: JSON.stringify({ model: "request-cannot-route", input: "test" }),
  });
  expect(ambiguous.status).toBe(409);

  const normal = await app.request("/v1/audio/speech", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
      "x-larm-capability": "speech.tts",
    },
    body: JSON.stringify({ model: "qwen-tts", input: "test" }),
  });
  expect(await normal.text()).toBe("RIFF");
  expect(normal.headers.get("x-voicevox-credit")).toContain("VOICEVOX");
  expect(targets).toEqual(["http://127.0.0.1:8084/v1/audio/speech"]);
});

test("speech gateway preserves provider 429 and Retry-After", async () => {
  const app = await makeSpeechApp({
    gatewayFetch: async () => Response.json(
      { error: { code: "provider_busy" } },
      { status: 429, headers: { "retry-after": "2" } },
    ),
  });
  const allocationId = await allocate(app, [
    { capability: "speech.tts", route: "tts-default" },
  ]);
  const response = await app.request("/v1/audio/speech", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-larm-allocation-id": allocationId,
    },
    body: "{}",
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("2");
});
