import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { compressClientRequest } from "./client-compression";
import { LarmClient } from "./index";

const text = "長い入力テキスト。".repeat(1000);

test("SDK compresses large media JSON and leaves small, control and decision bodies alone", async () => {
  const init = { method: "POST", headers: { "content-type": "application/json", "content-length": "99999" }, body: JSON.stringify({ text }) };
  for (const path of ["/v1/chat/completions", "/v1/audio/speech", "/v1/music/generations", "/v1/images/generations"]) {
    const prepared = await compressClientRequest(path, init);
    expect(new Headers(prepared.headers).get("content-encoding")).toBe("gzip");
    expect(new Headers(prepared.headers).get("content-length")).toBeNull();
    expect(gunzipSync(prepared.body as ArrayBuffer).toString()).toBe(init.body);
  }
  const small = { body: "{}" };
  expect(await compressClientRequest("/v1/chat/completions", small)).toBe(small);
  for (const path of ["/v1/systemone", "/v1/embed", "/v1/allocations"]) expect(await compressClientRequest(path, init)).toBe(init);
  const encoded = { ...init, headers: { "content-encoding": "gzip" } };
  expect(await compressClientRequest("/v1/chat/completions", encoded)).toBe(encoded);
});

test("SDK gzips WAV multipart uploads with the actual serialized boundary", async () => {
  const form = new FormData();
  form.set("model", "whisper");
  form.set("file", new Blob([text], { type: "audio/wav" }), "input.wav");
  const prepared = await compressClientRequest("/v1/audio/transcriptions", { method: "POST", body: form });
  expect(new Headers(prepared.headers).get("content-encoding")).toBe("gzip");
  const decoded = new Response(gunzipSync(prepared.body as ArrayBuffer), { headers: { "content-type": new Headers(prepared.headers).get("content-type")! } });
  const parsed = await decoded.formData();
  expect(parsed.get("model")).toBe("whisper");
  expect(await (parsed.get("file") as File).text()).toBe(text);
  form.set("file", new Blob([text], { type: "audio/ogg" }), "input.ogg");
  const init = { method: "POST", body: form };
  expect(await compressClientRequest("/v1/audio/transcriptions", init)).toBe(init);
});

test("SDK transport enables request gzip by default and allows explicit opt-out", async () => {
  for (const requestCompression of [undefined, false] as const) {
    let body: string | undefined;
    const client = new LarmClient({ baseUrl: "http://larm.test", requestCompression, fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("content-encoding")).toBe(requestCompression === false ? null : "gzip");
      body = headers.get("content-encoding") ? gunzipSync(init?.body as ArrayBuffer).toString() : String(init?.body);
      return new Response("{}", { headers: { "x-larm-boot-epoch": "test" } });
    } });
    const response = await client.createChatCompletion({ model: "test", messages: [{ role: "user", content: text }] });
    await response.text();
    expect(JSON.parse(body!).messages[0].content).toBe(text);
  }
});

test("SDK request compression honors an already-aborted call", async () => {
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await expect(compressClientRequest("/v1/chat/completions", { body: text, signal: abort.signal })).rejects.toThrow("cancelled");
});
