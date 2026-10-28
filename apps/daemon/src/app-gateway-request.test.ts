import { expect, test } from "bun:test";
import { prepareGatewayRequestBody } from "./app-gateway-request";

function request(body: string): Request {
  return new Request("http://larm.test/gateway", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const defaults = {
  bodyMode: "buffered" as const,
  maxBodyBytes: 1024 * 1024,
};

test("gateway body preparation normalizes chat and serializes the exact forwarded request", async () => {
  const result = await prepareGatewayRequestBody({
    ...defaults,
    protocol: "openai.chat-completions.v1",
    request: request(JSON.stringify({
      model: "qwen3.8",
      messages: [{ role: "user", content: "Reply with just ready." }],
      stream: true,
    })),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.body.chatRequest).toMatchObject({
    model: "qwen3.8",
    stream: true,
    chat_template_kwargs: { enable_thinking: false },
    grammar: 'root ::= "ready"',
  });
  expect(result.body.chatResponseFormat).toBe("sse");
  expect(new TextDecoder().decode(result.body.chatRequestBytes)).toBe(JSON.stringify(result.body.chatRequest));
});

test("gateway body preparation validates provider-specific JSON protocols", async () => {
  const embedding = await prepareGatewayRequestBody({
    ...defaults,
    protocol: "larm.embedding.v1",
    request: request(JSON.stringify({
      texts: ["source"],
      type: "passage",
      normalize: true,
      priority: "normal",
    })),
  });
  const systemOne = await prepareGatewayRequestBody({
    ...defaults,
    protocol: "larm.system-one.v1",
    request: request(JSON.stringify({
      model: "system-one-v1",
      state: "state",
      questions: { ready: { type: "choice", instructions: "Choose", criteria: ["ready"] } },
    })),
  });

  expect(embedding.ok).toBe(true);
  if (embedding.ok) {
    expect(embedding.body.embeddingRequest?.type).toBe("passage");
    expect(new TextDecoder().decode(embedding.body.embeddingRequestBytes)).toContain('"normalize":true');
  }
  expect(systemOne.ok).toBe(true);
  if (systemOne.ok) {
    expect(systemOne.body.systemOneRequest?.model).toBe("system-one-v1");
    expect(new TextDecoder().decode(systemOne.body.systemOneRequestBytes)).toContain('"questions"');
  }
});

test("gateway body preparation preserves protocol-specific validation errors", async () => {
  const embedding = await prepareGatewayRequestBody({
    ...defaults,
    protocol: "larm.embedding.v1",
    request: request("{}"),
  });
  const speech = await prepareGatewayRequestBody({
    ...defaults,
    protocol: "openai.audio-speech.v1",
    request: request(JSON.stringify({ model: "voicevox-core", input: "hello", voice: "1", speed: 3 })),
  });

  expect(embedding).toMatchObject({
    ok: false,
    error: { status: 400, code: "invalid_embedding_request", format: "larm" },
  });
  expect(speech).toMatchObject({
    ok: false,
    error: { status: 400, code: "invalid_request", param: "speed", format: "openai" },
  });
});

test("speech without a body does not attempt JSON parsing", async () => {
  const result = await prepareGatewayRequestBody({
    ...defaults,
    bodyMode: "none",
    protocol: "openai.audio-speech.v1",
    request: new Request("http://larm.test/gateway", { method: "POST" }),
  });
  expect(result).toEqual({ ok: true, body: {} });
});

test("reasoning effort is forwarded and selects the corresponding thinking mode", async () => {
  for (const [effort, enabled] of [["none", false], ["low", true], ["medium", true], ["high", true]] as const) {
    const result = await prepareGatewayRequestBody({ ...defaults, protocol: "openai.chat-completions.v1",
      request: request(JSON.stringify({ model: "ornith-1.5-strix-lean", messages: [], reasoning_effort: effort,
        chat_template_kwargs: { custom: "preserved" } })) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(new TextDecoder().decode(result.body.chatRequestBytes!))).toMatchObject({
      reasoning_effort: effort, chat_template_kwargs: { enable_thinking: enabled, custom: "preserved" },
    });
  }
});

test("reasoning effort rejects invalid or contradictory controls", async () => {
  for (const fields of [
    { reasoning_effort: "extreme" },
    { reasoning_effort: "high", chat_template_kwargs: { enable_thinking: false } },
    { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: true } },
  ]) {
    const result = await prepareGatewayRequestBody({ ...defaults, protocol: "openai.chat-completions.v1",
      request: request(JSON.stringify({ model: "test", messages: [], ...fields })) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ status: 400, format: "openai" });
  }
});

test("chat JSON and body limit errors retain the OpenAI error contract", async () => {
  for (const [body, maxBodyBytes, status] of [["{", 1024, 400], ["[]", 1024, 400], ["{}", 1, 413]] as const) {
    const result = await prepareGatewayRequestBody({ ...defaults, maxBodyBytes,
      protocol: "openai.chat-completions.v1", request: request(body) });
    expect(result).toMatchObject({ ok: false, error: { status, format: "openai" } });
  }
});

test("null effort uses Qwen's omitted-effort default and preserves explicit template controls", async () => {
  for (const enabled of [undefined, true, false]) {
    const result = await prepareGatewayRequestBody({ ...defaults, protocol: "openai.chat-completions.v1",
      request: request(JSON.stringify({ model: "qwen3.8", messages: [{ role: "user", content: "Reply with just OK." }],
        reasoning_effort: null, ...(enabled === undefined ? {} : { chat_template_kwargs: { enable_thinking: enabled } }) })) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body.chatRequest).toMatchObject({ chat_template_kwargs: { enable_thinking: enabled ?? false } });
      expect(Object.hasOwn(result.body.chatRequest as object, "grammar")).toBe(enabled !== true);
    }
  }
});

test("explicit thinking is not suppressed by Qwen literal-response grammar", async () => {
  const result = await prepareGatewayRequestBody({ ...defaults, protocol: "openai.chat-completions.v1",
    request: request(JSON.stringify({ model: "qwen3.8", messages: [{ role: "user", content: "Reply with just OK." }],
      reasoning_effort: "high" })) });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.body.chatRequest).not.toHaveProperty("grammar");
    expect(result.body.chatRequest).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
  }
});
