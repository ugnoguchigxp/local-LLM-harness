import { expect, test } from "bun:test";
import { Hono } from "hono";
import { gzipSync, gunzipSync } from "node:zlib";
import { readJson } from "./app-http";
import { RequestBodyError, readBodyLimited } from "./http-body";
import { compressMediaResponse, mediaCompression } from "./http-compression";
import type { Registry } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { createApp } from "./app";
import { Observer } from "./observer";
import { ControlPlane } from "./controller";
import { LarmClient } from "../../../packages/client/src/index";

const text = "日本語の生成テキスト。".repeat(300);
const url = "http://larm.test/v1/chat/completions";
const request = (encoding = "gzip", path = url) => new Request(path, { headers: { "accept-encoding": encoding } });
const decode = async (response: Response) => new TextDecoder().decode(gunzipSync(await response.bytes()));

function app(limit = 16384) {
  const app = new Hono();
  app.onError((error, c) => error instanceof RequestBodyError
    ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: "unexpected" }, 500));
  app.use("*", mediaCompression({ gatewayMaxBodyBytes: limit, speechMaxBodyBytes: limit }));
  return app;
}

test("negotiated gzip preserves JSON, Vary, and validator semantics", async () => {
  const response = await compressMediaResponse(request(), new Response(JSON.stringify({ text }), {
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify({ text }))), etag: '"value"', vary: "Origin" },
  }));
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(response.headers.get("content-length")).toBeNull();
  expect(response.headers.get("vary")).toBe("Origin, Accept-Encoding");
  expect(response.headers.get("etag")).toBe('W/"value"');
  expect(JSON.parse(await decode(response))).toEqual({ text });
});

test("gzip honors negotiation including wildcard exclusions and small responses", async () => {
  for (const accept of ["identity", "br", "gzip;q=0", "*;q=1, gzip;q=0", "gzip;q=invalid"]) {
    const response = await compressMediaResponse(request(accept), Response.json({ text }));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(await response.json()).toEqual({ text });
  }
  for (const accept of ["GZIP", "gzip;q=0.5", "*;q=1"]) {
    const response = await compressMediaResponse(request(accept), Response.json({ text }));
    expect(JSON.parse(await decode(response))).toEqual({ text });
  }
  const small = await compressMediaResponse(request(), Response.json({ ok: true }));
  expect(small.headers.get("content-encoding")).toBeNull();
  expect(await small.json()).toEqual({ ok: true });
});

test("encoding negotiation honors identity exclusions and explicit preferences", async () => {
  for (const accept of ["gzip, identity;q=0", "gzip, *;q=0"]) {
    const response = await compressMediaResponse(request(accept), Response.json({ ok: true }));
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(await decode(response))).toEqual({ ok: true });
  }
  const preferred = await compressMediaResponse(request("gzip;q=0.2, identity;q=1"), Response.json({ text }));
  expect(preferred.headers.get("content-encoding")).toBeNull();
  expect(await preferred.json()).toEqual({ text });
  for (const accept of ["gzip;q=0, identity;q=0", "br, *;q=0"]) {
    let cancelled = false;
    const response = await compressMediaResponse(request(accept), new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } }));
    expect(response.status).toBe(406);
    expect(response.body).toBeNull();
    expect(cancelled).toBe(true);
  }
});

test("a stalled finite response prefix is cancelled when the request aborts", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode("{")); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } });
  const pending = compressMediaResponse(new Request(url, { headers: { "accept-encoding": "gzip" }, signal: abort.signal }), response);
  abort.abort(new Error("client left during prefix"));
  await expect(pending).rejects.toThrow("client left during prefix");
  expect(cancelled).toBe(true);
}, 1000);

test("gzip requests are not read before authorization and stalled uploads obey abort", async () => {
  let pulls = 0;
  let deniedUploadCancelled = false;
  const unauthorized = app();
  unauthorized.post("/v1/chat/completions", (c) => c.json({ error: "unauthorized" }, 401));
  const denied = await unauthorized.request("/v1/chat/completions", { method: "POST", headers: { "content-encoding": "gzip" },
    body: new ReadableStream({
      pull(c) { pulls++; c.enqueue(gzipSync("{}")); c.close(); },
      cancel() { deniedUploadCancelled = true; },
    }, { highWaterMark: 0 }),
    duplex: "half",
  });
  expect(denied.status).toBe(401);
  expect(pulls).toBe(0);
  expect(deniedUploadCancelled).toBe(true);
  const abort = new AbortController();
  let cancelled = false;
  const api = app();
  api.post("/v1/chat/completions", async (c) => {
    await readBodyLimited(c.req.raw, 16384);
    return c.json({ ok: true });
  });
  const pending = api.request("/v1/chat/completions", { method: "POST", headers: { "content-encoding": "gzip" }, signal: abort.signal,
    body: new ReadableStream({ cancel() { cancelled = true; } }), duplex: "half",
  });
  await Bun.sleep(1);
  abort.abort(new Error("upload cancelled"));
  await pending;
  expect(cancelled).toBe(true);
}, 1000);

test("compressed media, range responses, no-transform and decision APIs remain untouched", async () => {
  for (const type of ["image/png", "image/jpeg", "image/webp", "audio/ogg", "audio/mpeg", "audio/flac"]) {
    const original = new Response(text, { headers: { "content-type": type } });
    expect(await compressMediaResponse(request(), original)).toBe(original);
  }
  for (const headers of [{ "content-encoding": "gzip" }, { "cache-control": "no-transform" }, { "content-range": "bytes 0-9/100" }]) {
    const original = new Response(text, { headers: { "content-type": "application/json", ...headers } });
    expect(await compressMediaResponse(request(), original)).toBe(original);
  }
  const partial = new Response(text, { status: 206, headers: { "content-type": "audio/wav" } });
  expect(await compressMediaResponse(request(), partial)).toBe(partial);
  const range = new Request(url, { headers: { "accept-encoding": "gzip", range: "bytes=0-10" } });
  const response = Response.json({ text });
  expect(await compressMediaResponse(range, response)).toBe(response);
  for (const path of ["/v1/systemone", "/v1/embed", "/v1/allocations"]) {
    expect(await compressMediaResponse(request("gzip", `http://larm.test${path}`), response)).toBe(response);
  }
});

test("SSE and PCM arrive before upstream EOF and cancellation reaches the producer", async () => {
  for (const type of ["text/event-stream", "audio/pcm;rate=24000;channels=1;format=s16le", "audio/wav"]) {
    let cancelled = false;
    const plain = new TextEncoder().encode(type.startsWith("text/") ? "data: first\n\n" : "first audio frame");
    const source = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(plain); },
      cancel() { cancelled = true; },
    });
    const response = await compressMediaResponse(request(), new Response(source, { headers: { "content-type": type } }));
    expect(response.headers.get("content-encoding")).toBe("gzip");
    const decoded = response.body!.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
    const reader = decoded.getReader();
    // No timer pushes further input or closes the producer: delivery requires
    // the gzip flush, not completion or a size threshold.
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toEqual(plain);
    await reader.cancel();
    for (let i = 0; i < 50 && !cancelled; i++) await Bun.sleep(1);
    expect(cancelled).toBe(true);
  }
}, 3000);

test("request abortion and source failure propagate through response compression", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const response = await compressMediaResponse(new Request(url, { headers: { "accept-encoding": "gzip" }, signal: abort.signal }),
    new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }));
  const read = response.body!.getReader().read();
  abort.abort(new Error("client left"));
  await expect(read).rejects.toThrow();
  for (let i = 0; i < 50 && !cancelled; i++) await Bun.sleep(1);
  expect(cancelled).toBe(true);
  const failed = await compressMediaResponse(request(), new Response(new ReadableStream({ start(c) { c.error(new Error("upstream failed")); } }), {
    headers: { "content-type": "text/event-stream" },
  }));
  await expect(failed.bytes()).rejects.toThrow("upstream failed");
});

test("all five media APIs accept gzip JSON requests and negotiate gzip responses", async () => {
  const paths = ["/v1/chat/completions", "/v1/audio/speech", "/v1/audio/transcriptions", "/v1/music/generations", "/v1/images/generations"];
  for (const path of paths) {
    const api = app();
    api.post(path, async (c) => {
      expect(c.req.header("content-encoding")).toBeUndefined();
      expect(c.req.header("content-length")).toBeUndefined();
      c.header("content-length", String(Buffer.byteLength(JSON.stringify({ text }))));
      return c.json(await readJson(c, 16384));
    });
    const compressed = gzipSync(JSON.stringify({ text }));
    const response = await api.request(path, { method: "POST", headers: {
      "content-encoding": "gzip", "content-type": "application/json", "accept-encoding": "gzip", "content-length": String(compressed.length),
    }, body: compressed });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBeNull();
    expect(JSON.parse(await decode(response))).toEqual({ text });
  }
});

test("ASR gzip multipart retains its boundary and exact recording bytes", async () => {
  const api = app();
  api.post("/v1/audio/transcriptions", async (c) => {
    const bytes = await readBodyLimited(c.req.raw, 16384);
    const form = await new Response(bytes, { headers: { "content-type": c.req.header("content-type")! } }).formData();
    expect(form.get("model")).toBe("whisper");
    expect(await (form.get("file") as File).text()).toBe(text);
    return c.json({ text });
  });
  const form = new FormData();
  form.set("model", "whisper");
  form.set("file", new Blob([text], { type: "audio/wav" }), "input.wav");
  const serialized = new Request(url, { method: "POST", body: form });
  const response = await api.request("/v1/audio/transcriptions", { method: "POST", headers: {
    "content-type": serialized.headers.get("content-type")!, "content-encoding": "gzip", "accept-encoding": "gzip",
  }, body: gzipSync(await serialized.bytes()) });
  expect(response.status).toBe(200);
  expect(JSON.parse(await decode(response))).toEqual({ text });
});

test("gzip rejects malformed bodies, unsupported codings and expansion past the route limit", async () => {
  const api = app(1024);
  api.post("/v1/chat/completions", async (c) => c.json(await readJson(c, 1024)));
  const corruptChecksum = Buffer.from(gzipSync("{}"));
  corruptChecksum[corruptChecksum.length - 8]! ^= 1;
  for (const body of [Buffer.from("not gzip"), gzipSync("{}").subarray(0, 10), corruptChecksum]) {
    const response = await api.request("/v1/chat/completions", { method: "POST", headers: { "content-encoding": "gzip" }, body });
    expect(response.status).toBe(400);
  }
  const oversize = await api.request("/v1/chat/completions", { method: "POST", headers: { "content-encoding": "gzip" }, body: gzipSync(JSON.stringify({ text })) });
  expect(oversize.status).toBe(413);
  const unsupported = await api.request("/v1/chat/completions", { method: "POST", headers: { "content-encoding": "br" }, body: "{}" });
  expect(unsupported.status).toBe(415);
  expect(unsupported.headers.get("accept-encoding")).toBe("gzip, identity");
});

test("middleware keeps cookies and Vary while updating compressed representation headers", async () => {
  const api = app();
  api.get("/v1/music/tracks", (c) => {
    c.header("set-cookie", "first=1; HttpOnly", { append: true });
    c.header("set-cookie", "second=2; HttpOnly", { append: true });
    c.header("vary", "Origin");
    c.header("etag", '"plain"');
    c.header("content-length", String(Buffer.byteLength(JSON.stringify({ text }))));
    return c.json({ text });
  });
  const response = await api.request("/v1/music/tracks", { headers: { "accept-encoding": "gzip" } });
  expect(response.headers.getSetCookie()).toEqual(["first=1; HttpOnly", "second=2; HttpOnly"]);
  expect(response.headers.get("vary")).toBe("Origin, Accept-Encoding");
  expect(response.headers.get("etag")).toBe('W/"plain"');
  expect(response.headers.get("content-length")).toBeNull();
  expect(JSON.parse(await decode(response))).toEqual({ text });
});

test("native HTTP fetch negotiates and incrementally decodes gzip SSE", async () => {
  const api = app();
  let producer: ReadableStreamDefaultController<Uint8Array>;
  api.get("/v1/music/generations/job/events", () => new Response(new ReadableStream<Uint8Array>({
    start(c) { producer = c; c.enqueue(new TextEncoder().encode("data: first\n\n")); },
  }), { headers: { "content-type": "text/event-stream" } }));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: api.fetch });
  try {
    const response = await fetch(`${server.url}v1/music/generations/job/events`, { signal: AbortSignal.timeout(2000) });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    producer!.enqueue(new TextEncoder().encode("data: second\n\n"));
    producer!.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: second\n\n");
    expect((await reader.read()).done).toBe(true);
  } finally { await server.stop(true); }
});

test("SDK and full daemon preserve scoped chat semantics over gzip in both directions", async () => {
  const registry: Registry = {
    nodes: [{ id: "local-node", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 128, reservedMemoryGB: 16 } }],
    profiles: [],
    routes: [{ id: "llm", capabilities: ["llm.general"], explicitOnly: false, candidates: [{ runtime: "llm", purpose: "primary" }] }],
    runtimes: [{
      id: "llm", capability: ["llm.general"], protocol: "openai.chat-completions.v1", backend: "systemd", node: "local-node",
      policy: { class: "resident" }, resources: { estimatedMemoryGB: 1, maxConcurrentRequests: 1, maxQueuedRequests: 1, queueTimeoutMs: 100 },
      deployment: { service: "llm.service", healthPort: 8080, endpoint: "http://127.0.0.1:8080" },
    }],
  };
  const health = { runtimeId: "llm", service: "Running" as const, listening: true, healthOk: true, busy: false, httpStatus: 200 };
  const backend: RuntimeBackend = { list: async () => [health], health: async () => health, ensure: async () => health, stop: async () => undefined };
  const observer = new Observer(registry, backend);
  await observer.tick();
  const control = new ControlPlane(registry, backend, observer, { bootEpoch: "gzip-test" });
  let upstreamCalls = 0;
  const api = createApp({
    registry, control, getState: () => observer.getState(), apiToken: "consumer",
    gatewayFetch: async (_input, init) => {
      upstreamCalls++;
      const headers = new Headers(init?.headers);
      expect(headers.get("content-encoding")).toBeNull();
      expect(headers.get("accept-encoding")).toBe("identity");
      expect(headers.get("authorization")).toBeNull();
      const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
      expect(body.messages[0].content).toBe(text);
      const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({
        id: "chat-gzip", object: "chat.completion.chunk", created: 1, model: "local",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`;
      return new Response(chunk({ content: text }) + chunk({}, "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: api.fetch });
  try {
    const client = new LarmClient({ baseUrl: String(server.url), apiToken: "consumer", timeoutMs: 2000 });
    const created = await fetch(`${server.url}v1/allocations`, {
      method: "POST", headers: { authorization: "Bearer consumer", "content-type": "application/json" },
      body: JSON.stringify({ requirements: [{ capability: "llm.general", route: "llm" }] }),
    });
    expect(created.status).toBe(200);
    const allocationId = (await created.json() as { id: string }).id;
    const response = await client.chat(allocationId, { model: "local", stream: true, messages: [{ role: "user", content: text }] });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    const received = await response.text();
    expect(received).toContain(text);
    expect(received).toEndWith("data: [DONE]\n\n");
    expect(upstreamCalls).toBe(1);
    const denied = await fetch(`${server.url}v1/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer wrong", "content-encoding": "gzip", "content-type": "application/json" },
      body: gzipSync(JSON.stringify({ messages: [{ role: "user", content: text }] })),
    });
    expect(denied.status).toBe(401);
    await denied.body?.cancel();
    expect(upstreamCalls).toBe(1);
    await client.release(allocationId);
  } finally { await server.stop(true); }
});
