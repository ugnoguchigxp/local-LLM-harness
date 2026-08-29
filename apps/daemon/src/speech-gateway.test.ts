import { expect, test } from "bun:test";
import type { Registry } from "@larm/core";
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
    { id: "tts-default", capabilities: ["speech.tts"], explicitOnly: false, candidates: [{ runtime: "voicevox", purpose: "primary" }] },
    { id: "tts-expressive", capabilities: ["speech.tts.expressive"], explicitOnly: false, candidates: [{ runtime: "qwen-tts", purpose: "primary" }] },
  ],
};

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
