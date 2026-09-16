import { randomUUID } from "node:crypto";
import { LarmClient } from "../../../packages/client/src/index";

type CaseResult = {
  name: string;
  ok: boolean;
  elapsedMs: number;
  finishReason?: string;
  detail: string;
};

type Completion = {
  model?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: Record<string, unknown>;
  }>;
};

const baseUrl = process.env.LARM_BASE_URL?.trim() || "http://127.0.0.1:9810";
const profile = process.env.LARM_KV_MEM_PROFILE?.trim() || "saaa-qwen38-kv-mem";
const audience = process.env.LARM_AGENT_AUDIENCE?.trim() || "same-host";
const timeoutMs = Number(process.env.LARM_KV_MEM_TIMEOUT_MS ?? 330_000);
const ttlSeconds = Number(process.env.LARM_KV_MEM_TTL_SECONDS ?? 1_800);

if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
  throw new Error("LARM_KV_MEM_TIMEOUT_MS must be an integer from 1 through 3600000");
}
if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86_400) {
  throw new Error("LARM_KV_MEM_TTL_SECONDS must be an integer from 60 through 86400");
}

function visibleContent(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  return [message.content, message.refusal]
    .filter((value): value is string => typeof value === "string")
    .join("")
    .trim();
}

function completionChoice(value: unknown, model: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("response is not an object");
  }
  const completion = value as Completion;
  if (typeof completion.model !== "string" || completion.model.length === 0) {
    throw new Error("completion model is missing");
  }
  if (!Array.isArray(completion.choices) || completion.choices.length !== 1) {
    throw new Error("completion envelope is invalid");
  }
  const choice = completion.choices[0]!;
  if (typeof choice.finish_reason !== "string" || !choice.message) {
    throw new Error("completion choice is incomplete");
  }
  return {
    choice,
    completion: value as Record<string, unknown>,
    responseModel: completion.model,
    modelNormalized: completion.model === model,
  };
}

async function main() {
  const client = new LarmClient({
    baseUrl,
    ...(process.env.LARM_API_TOKEN ? { apiToken: process.env.LARM_API_TOKEN } : {}),
    timeoutMs,
  });
  const health = await client.getHealth();
  const profiles = await client.listAgentProfiles();
  const advertised = profiles.profiles.find((candidate) => candidate.id === profile);
  if (!advertised) throw new Error(`Agent Profile is not advertised: ${profile}`);
  const advertisedProvider = advertised.providers.find((provider) => provider.name === "llm");
  if (!advertisedProvider || advertisedProvider.model !== "qwen3.8-kv-mem") {
    throw new Error("KV:mem llm Provider is not advertised with the expected model");
  }

  const created = await client.createAgentConnection({
    agentProfile: profile,
    explicitAgentProfile: true,
    audience,
    client: `kv-mem-live-${randomUUID()}`,
    ttlSeconds,
    allowFallback: false,
    deploymentPolicy: "existing-only",
  });
  let released = false;
  const results: CaseResult[] = [];
  try {
    const ready = await client.waitForAgentConnection(created, { timeoutMs, pollIntervalMs: 500 });
    const claimed = await client.claimAgentConnection(ready.id);
    const provider = claimed.providers.find((candidate) => candidate.name === "llm");
    if (!provider) throw new Error("claimed Connection omitted the KV:mem llm Provider");
    const endpoint = `${provider.baseUrl}/chat/completions`;
    const responseModels = new Set<string>();

    const complete = async (body: Record<string, unknown>): Promise<unknown> => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${provider.credential.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ model: provider.model, stream: false, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const value = await response.json().catch(() => undefined);
      if (!response.ok) {
        const code = value && typeof value === "object" && !Array.isArray(value)
          ? (value as { error?: { code?: unknown } }).error?.code
          : undefined;
        throw new Error(`HTTP ${response.status}${typeof code === "string" ? `/${code}` : ""}`);
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const responseModel = (value as { model?: unknown }).model;
        if (typeof responseModel === "string") responseModels.add(responseModel);
      }
      return value;
    };

    const run = async (name: string, operation: () => Promise<string>): Promise<void> => {
      const startedAt = Date.now();
      try {
        const detail = await operation();
        results.push({ name, ok: true, elapsedMs: Date.now() - startedAt, detail });
      } catch (error) {
        results.push({
          name,
          ok: false,
          elapsedMs: Date.now() - startedAt,
          detail: error instanceof Error ? error.message : "unknown error",
        });
      }
    };

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      await run(`short-visible-${iteration}`, async () => {
        const value = await complete({
          messages: [{ role: "user", content: "Reply with just OK." }],
          temperature: 0,
          max_tokens: 256,
        });
        const { choice } = completionChoice(value, provider.model);
        if (choice.finish_reason !== "stop" || visibleContent(choice.message) !== "OK") {
          throw new Error(`unexpected ${String(choice.finish_reason)} completion or visible body`);
        }
        return "stop with exact visible body";
      });
    }

    await run("japanese-visible", async () => {
      const value = await complete({
        messages: [{ role: "user", content: "日本語で『疎通確認済み』とだけ答えてください。" }],
        temperature: 0,
        max_tokens: 256,
      });
      const { choice } = completionChoice(value, provider.model);
      if (!visibleContent(choice.message).includes("疎通確認済み")) throw new Error("expected Japanese body is missing");
      return `visible body with ${String(choice.finish_reason)} finish`;
    });

    await run("structured-output", async () => {
      const value = await complete({
        messages: [{ role: "user", content: "Return the requested JSON status." }],
        temperature: 0,
        max_tokens: 512,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "kv_mem_status",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["status"],
              properties: { status: { type: "string", const: "ok" } },
            },
          },
        },
      });
      const { choice } = completionChoice(value, provider.model);
      const parsed = JSON.parse(visibleContent(choice.message)) as { status?: unknown };
      if (parsed.status !== "ok") throw new Error("JSON Schema result is not ok");
      return `schema-constrained body with ${String(choice.finish_reason)} finish`;
    });

    const needle = `KV-NEEDLE-${randomUUID()}`;
    await run("long-prefix-recall", async () => {
      const filler = Array.from({ length: 256 }, (_, index) => `Record ${index}: synthetic context filler.`).join("\n");
      const value = await complete({
        messages: [{
          role: "user",
          content: `${filler}\nThe exact verification code is ${needle}.\nReturn only the exact verification code.`,
        }],
        temperature: 0,
        max_tokens: 512,
      });
      const { choice } = completionChoice(value, provider.model);
      if (!visibleContent(choice.message).includes(needle)) throw new Error("long-prefix needle was not recalled");
      return `needle recalled with ${String(choice.finish_reason)} finish`;
    });

    await run("tool-round-trip", async () => {
      const tools = [{
        type: "function",
        function: {
          name: "lookup_synthetic_value",
          description: "Return the synthetic integer for a key.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["key"],
            properties: { key: { type: "string", const: "answer" } },
          },
        },
      }];
      const first = await complete({
        messages: [{ role: "user", content: "Use the tool to get the answer, then report it." }],
        tools,
        tool_choice: "required",
        temperature: 0,
        max_tokens: 1_024,
      });
      const { choice: toolChoice } = completionChoice(first, provider.model);
      const toolCalls = toolChoice.message?.tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length !== 1) throw new Error("exactly one tool call was not returned");
      const call = toolCalls[0];
      if (!call || typeof call !== "object" || Array.isArray(call)) throw new Error("tool call is invalid");
      const callRecord = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      if (
        typeof callRecord.id !== "string"
        || callRecord.function?.name !== "lookup_synthetic_value"
        || typeof callRecord.function.arguments !== "string"
      ) throw new Error("tool call fields are invalid");
      const args = JSON.parse(callRecord.function.arguments) as { key?: unknown };
      if (args.key !== "answer") throw new Error("tool arguments are invalid");

      const second = await complete({
        messages: [{ role: "user", content: "Use the tool to get the answer, then report it." }, {
          role: "assistant",
          ...toolChoice.message,
        }, {
          role: "tool",
          tool_call_id: callRecord.id,
          content: JSON.stringify({ value: 17 }),
        }],
        tools,
        tool_choice: "none",
        temperature: 0,
        max_tokens: 1_024,
      });
      const { choice: finalChoice } = completionChoice(second, provider.model);
      if (!visibleContent(finalChoice.message).includes("17")) throw new Error("final answer omitted the tool result");
      return `tool call and visible continuation completed with ${String(finalChoice.finish_reason)} finish`;
    });

    await client.releaseAgentConnection(ready.id);
    released = true;
    const revoked = await fetch(provider.health.url, {
      headers: { authorization: `Bearer ${provider.credential.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    await revoked.body?.cancel().catch(() => undefined);
    if (revoked.status !== 401) throw new Error(`released credential returned HTTP ${revoked.status}`);

    const result = {
      schemaVersion: 1,
      kind: "kv-mem-provider-live-matrix",
      releaseCommit: health.releaseCommit,
      configRevision: health.configRevision,
      profile,
      model: provider.model,
      responseModels: [...responseModels].sort(),
      responseModelNormalized: responseModels.size === 1 && responseModels.has(provider.model),
      cases: results,
      passed: results.filter((candidate) => candidate.ok).length,
      failed: results.filter((candidate) => !candidate.ok).length,
      released: true,
      credentialRevoked: true,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    if (!released) await client.releaseAgentConnection(created.id).catch(() => undefined);
  }
}

await main();
