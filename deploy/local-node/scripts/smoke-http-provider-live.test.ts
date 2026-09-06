import { expect, test } from "bun:test";
import { runHttpProviderLiveSmoke } from "./smoke-http-provider-live";

const releaseCommit = "a".repeat(40);
const configRevision = "b".repeat(64);

function wav(): Uint8Array {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 38, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 2, true);
  return bytes;
}

test("live HTTP Provider smoke validates allocation-free JSON, SSE, ASR, and TTS", async () => {
  const requestPaths: string[] = [];
  const result = await runHttpProviderLiveSmoke({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "secret",
    model: "coding-default",
    expectedReleaseCommit: releaseCommit,
    fetch: async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      expect(request.headers.has("x-larm-allocation-id")).toBe(false);
      const path = new URL(request.url).pathname;
      requestPaths.push(path);
      if (path !== "/health" && path !== "/ready") {
        expect(request.headers.get("authorization")).toBe("Bearer secret");
      }
      if (path === "/health") return Response.json({
        status: "ok",
        version: "1.0.0",
        releaseCommit,
        configRevision,
        bootEpoch: "epoch-live",
      }, { headers: { "x-larm-boot-epoch": "epoch-live" } });
      if (path === "/ready") return Response.json({ status: "ready" }, {
        headers: { "x-larm-boot-epoch": "epoch-live" },
      });
      if (path === "/v1/models") return Response.json({
        object: "list",
        data: ["coding-default", "qwen3-asr-1.7b", "voicevox-core"].map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "larm",
        })),
      }, { headers: { "x-larm-boot-epoch": "epoch-live" } });
      if (path === "/v1/chat/completions") {
        const body = await request.json() as { stream?: boolean; model: string };
        if (body.stream) {
          const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({
            id: "chatcmpl-smoke",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices,
            ...(usage ? { usage } : {}),
          })}\n\n`;
          return new Response([
            chunk([{ index: 0, delta: { content: "OK" }, finish_reason: null }]),
            chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
            chunk([], { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
            "data: [DONE]\n\n",
          ].join(""), { headers: { "content-type": "text/event-stream", "x-larm-boot-epoch": "epoch-live" } });
        }
        return Response.json({
          id: "chatcmpl-smoke",
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }, { headers: { "x-larm-boot-epoch": "epoch-live" } });
      }
      if (path === "/v1/audio/transcriptions") {
        expect((await request.formData()).get("model")).toBe("qwen3-asr-1.7b");
        return Response.json({ text: "" }, { headers: { "x-larm-boot-epoch": "epoch-live" } });
      }
      if (path === "/v1/audio/speech") {
        return new Response(wav(), {
          headers: { "content-type": "audio/wav", "x-larm-boot-epoch": "epoch-live" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  expect(result).toMatchObject({
    schemaVersion: 1,
    kind: "http-provider-canary",
    ok: true,
    desiredRelease: releaseCommit,
    releaseCommit,
    model: "coding-default",
    jsonValidated: true,
    sse: { chunks: 3, deltas: 1, finishReasons: 1 },
    audio: {
      asrModel: "qwen3-asr-1.7b",
      transcriptionValidated: true,
      ttsModel: "voicevox-core",
      mediaType: "audio/wav",
      bytes: 46,
    },
  });
  expect(requestPaths).toHaveLength(7);
});
