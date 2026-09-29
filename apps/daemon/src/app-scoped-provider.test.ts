import { expect, test } from "bun:test";
import type { AudioSpeechRequest } from "@larm/core";
import { validateScopedProviderModel } from "./app-scoped-provider";

const emptyPrepared = {};

test("scoped Provider binds Chat, speech, and System One model selectors to its public model", async () => {
  expect(await validateScopedProviderModel({
    request: new Request("http://larm.test/v1/chat/completions"),
    protocol: "openai.chat-completions.v1",
    maxBodyBytes: 1024,
    publicModel: "claimed-model",
    prepared: { chatRequest: { model: "claimed-model" } },
  })).toEqual({ ok: true });
  expect(await validateScopedProviderModel({
    request: new Request("http://larm.test/v1/audio/speech"),
    protocol: "openai.audio-speech.v1",
    maxBodyBytes: 1024,
    publicModel: "claimed-model",
    prepared: {
      speechRequest: { model: "other-model", input: "hello" } as AudioSpeechRequest,
    },
  })).toMatchObject({ ok: false, status: 400, code: "model_mismatch" });
  expect(await validateScopedProviderModel({
    request: new Request("http://larm.test/v1/systemone"),
    protocol: "larm.system-one.v1",
    maxBodyBytes: 1024,
    publicModel: "claimed-model",
    prepared: emptyPrepared,
  })).toMatchObject({ ok: false, status: 400, code: "model_mismatch" });
  expect(await validateScopedProviderModel({
    request: new Request("http://larm.test/v1/embed"),
    protocol: "larm.embedding.v1",
    maxBodyBytes: 1024,
    publicModel: "claimed-model",
    prepared: emptyPrepared,
  })).toEqual({ ok: true });
});

test("scoped transcription binds exactly one multipart model and preserves bounded-body errors", async () => {
  const body = new FormData();
  body.set("model", "claimed-model");
  body.set("file", new Blob(["audio"]), "audio.wav");
  expect(await validateScopedProviderModel({
    request: new Request("http://larm.test/v1/audio/transcriptions", { method: "POST", body }),
    protocol: "openai.audio-transcriptions.v1",
    maxBodyBytes: 4096,
    publicModel: "claimed-model",
    prepared: emptyPrepared,
  })).toEqual({ ok: true });

  const duplicated = new FormData();
  duplicated.append("model", "claimed-model");
  duplicated.append("model", "claimed-model");
  duplicated.set("file", new Blob(["audio"]), "audio.wav");
  expect(await validateScopedProviderModel({
    request: new Request("http://larm.test/v1/audio/transcriptions", {
      method: "POST",
      body: duplicated,
    }),
    protocol: "openai.audio-transcriptions.v1",
    maxBodyBytes: 4096,
    publicModel: "claimed-model",
    prepared: emptyPrepared,
  })).toMatchObject({ ok: false, status: 400, code: "model_mismatch" });

  const tooLarge = new Request("http://larm.test/v1/audio/transcriptions", {
    method: "POST",
    body: "too large",
  });
  expect(await validateScopedProviderModel({
    request: tooLarge,
    protocol: "openai.audio-transcriptions.v1",
    maxBodyBytes: 1,
    publicModel: "claimed-model",
    prepared: emptyPrepared,
  })).toMatchObject({ ok: false, status: 413 });
});
