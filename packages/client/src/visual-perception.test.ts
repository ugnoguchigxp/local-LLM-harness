import { expect, test } from "bun:test";
import { visualPerceptionProbe, type VisualPerceptionResponse } from "@larm/core";
import { LarmClient, type VisualPerceptionAgentProvider } from "./index";

const provider: VisualPerceptionAgentProvider = {
  name: "vision", capability: "vision.perception", apiStyle: "larm-visual-perception", protocol: "larm.visual-perception.v1",
  scheme: "http", host: "127.0.0.1", port: 9810, baseUrl: "http://127.0.0.1:9810/v1", endpoint: "http://127.0.0.1:9810/v1/vision/perceive",
  model: "wevisone-vl-4b", health: { url: "http://127.0.0.1:9810/v1/agent-connections/test/providers/vision/health", kind: "semantic-inference", maxAgeMs: 10_000 },
  credential: { type: "bearer", token: "scoped-token", expiresAt: "2026-10-25T00:00:00.000Z" },
  configuration: { kind: "larm-visual-perception-provider-v1", fields: { daemonURL: "http://127.0.0.1:9810/v1", model: "wevisone-vl-4b" }, secretFields: { accessToken: "credential.token" } },
};
const input = visualPerceptionProbe(provider.model);
function result(): VisualPerceptionResponse {
  return { contractVersion: "larm.visual-perception.v1", model: provider.model, modelRevision: "a".repeat(40), task: input.task,
    image: { width: 128, height: 128, orientation: "exif-normalized" }, response: "circle", detections: [], masks: [], truncated: false,
    timings: { imageDecodeMs: 1, preprocessMs: 1, generationMs: 1, maskMs: 0, postprocessMs: 1, totalMs: 4 },
    execution: { device: "cuda:0", backend: "transformers", dtype: "bfloat16", decoderDtype: "float32", outputTokens: 12, visualTokens: 16 } };
}
test("perceive uses the scoped credential, native body, redirect refusal and bounded request deadline", async () => {
  const client = new LarmClient({ baseUrl: "http://control.invalid", apiToken: "must-not-leak", fetch: async (url, init) => {
    expect(String(url)).toBe(provider.endpoint);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer scoped-token");
    expect(JSON.parse(String(init?.body))).toEqual(input);
    expect(init?.redirect).toBe("manual"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(result());
  } });
  expect(await client.perceive(provider, input)).toEqual(result());
  await expect(client.perceive(provider, { ...input, model: "other" })).rejects.toMatchObject({ code: "model_mismatch" });
  await expect(client.perceive(provider, { ...input, image: "http://bad" })).rejects.toThrow();
});
test("perceive rejects protocol, media, malformed JSON, redirects and bounded HTTP failures", async () => {
  for (const [response, code] of [
    [new Response(null, { status: 302, headers: { location: "http://untrusted.invalid" } }), "provider_redirect_forbidden"],
    [new Response("{bad"), "visual_perception_response_invalid"],
    [Response.json({ ...result(), model: "other" }), "visual_perception_response_invalid"],
    [new Response(JSON.stringify(result()), { headers: { "content-type": "text/plain" } }), "visual_perception_response_invalid"],
    [Response.json({ error: { code: "provider_busy", message: "busy" } }, { status: 429 }), "provider_busy"],
    [Response.json({}, { status: 503 }), "visual_perception_http_error"],
    [new Response("x", { headers: { "content-length": "8388609" } }), "visual_perception_response_too_large"],
    [new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); c.close(); } })), "visual_perception_response_too_large"],
  ] as const) {
    const client = new LarmClient({ baseUrl: "http://control.invalid", fetch: async () => response });
    await expect(client.perceive(provider, input)).rejects.toMatchObject({ code });
  }
});
test("perceive propagates cancellation to the Provider request", async () => {
  const abort = new AbortController(); abort.abort(new Error("cancelled"));
  const client = new LarmClient({ baseUrl: "http://control.invalid", fetch: async (_url, init) => {
    expect(init?.signal?.aborted).toBe(true); init?.signal?.throwIfAborted(); return Response.json({});
  } });
  await expect(client.perceive(provider, input, abort.signal)).rejects.toThrow("cancelled");
});
