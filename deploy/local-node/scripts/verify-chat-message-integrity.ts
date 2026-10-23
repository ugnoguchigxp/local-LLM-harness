import { LarmClient } from "../../../packages/client/src/index";
import { agentProfileSelectorIdSchema, type AgentConnectionClaim } from "../../../packages/core/src/agent-connection";
import { chatInputTokenCountSchema } from "../../../packages/core/src/chat-input";
import { OpenAiChatCompletionSseInspector } from "../../../packages/core/src/openai-sse";
import { instructionPlacements } from "./chat-integrity-fixtures";
import { cacheSample } from "./verify-prompt-cache";

type Provider = Extract<AgentConnectionClaim["providers"][number], { apiStyle: "openai" }>;
/** Run only against a synthetic environment without payload retention. Output is strictly
 * identifiers, fixed labels, counters, booleans and timings, never raw replies. */
export async function verifyChatMessageIntegrity() {
  const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:19811";
  const apiToken = process.env.LARM_API_TOKEN;
  if (!apiToken) throw new Error("integrity_auth_missing");
  const client = new LarmClient({ baseUrl, apiToken, timeoutMs: 120_000 });
  const profile = agentProfileSelectorIdSchema.parse(process.env.LARM_CHAT_PROFILE ?? "ornith1.5Strix");
  const catalog = await client.listAgentProfilesV3(profile);
  const owned = new Set<string>();
  const emit = (v: Record<string, unknown>) => console.log(JSON.stringify(v));
  const before = await (await fetch(`${baseUrl}/health`)).json() as Record<string, unknown>;
  emit({ label: "health-before", releaseCommit: before.releaseCommit, bootEpoch: before.bootEpoch, configRevision: before.configRevision });
  let identity: string | undefined;
  let failed = 0;
  const samples: Record<string, ReturnType<typeof cacheSample>> = {};
  const create = async (role: string) => {
    const started = performance.now();
    const connection = await client.createAgentConnection({ profile, providers: ["llm"], client: `integrity-${role}-${crypto.randomUUID()}`,
      audience: process.env.LARM_CHAT_AUDIENCE ?? "local", expectedCatalogRevision: catalog.catalogRevision, ttlSeconds: 900,
      allowFallback: false, deploymentPolicy: "existing-only" }, { idempotencyKey: crypto.randomUUID(), waitSeconds: 1 });
    owned.add(connection.id);
    await client.waitForAgentConnection(connection, { timeoutMs: 60_000 });
    const claim = await client.claimAgentConnection(connection.id);
    const provider = claim.providers.find((p): p is Provider => p.name === "llm" && p.apiStyle === "openai");
    if (!provider) throw new Error("integrity_provider_missing");
    if (!provider.chatInput || !["off", "metadata"].includes(provider.chatInput.retention.inferenceAudit) || provider.chatInput.retention.requestPayloadStored) {
      throw new Error("integrity_fixture_payload_retention_forbidden");
    }
    emit({ label: "connection", role, connectionId: connection.id, allocation_ms: performance.now() - started });
    return { id: connection.id, provider };
  };
  const release = async (id: string) => { await client.releaseAgentConnection(id); owned.delete(id); };
  const post = (p: Provider, body: Record<string, unknown>, suffix = "") => fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions${suffix}`, {
    method: "POST", headers: { authorization: `Bearer ${p.credential.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: p.model, ...body }), redirect: "error", signal: AbortSignal.timeout(120_000),
  });
  const measure = async (p: Provider, label: string, body: Record<string, unknown>, expectedValue?: string) => {
    const countStart = performance.now();
    const countResponse = await post(p, body, "/input-tokens");
    const countMs = performance.now() - countStart;
    if (!countResponse.ok) {
      const error = await countResponse.json() as { error?: { code?: string } };
      // Enumerated codes only; no backend message is retained.
      const code = error.error?.code === "chat_instruction_template_unsupported" ? error.error.code : "other_error";
      failed++;
      emit({ label, status: countResponse.status, code, success: false, count_ms: countMs });
      return;
    }
    const count = chatInputTokenCountSchema.parse(await countResponse.json());
    if (!count.fits) throw new Error("integrity_context_does_not_fit");
    const current = JSON.stringify([count.runtime, count.runtimeRelease, count.engineBuild, count.bootEpoch, count.configRevision]);
    if (count.bootEpoch !== before.bootEpoch || count.configRevision !== before.configRevision) throw new Error("integrity_count_health_mismatch");
    if (identity !== undefined && identity !== current) throw new Error("integrity_generation_changed");
    if (identity === undefined) emit({ label: "resolved", runtime: count.runtime, runtimeRelease: count.runtimeRelease, engineBuild: count.engineBuild, bootEpoch: count.bootEpoch, configRevision: count.configRevision });
    identity = current;
    const start = performance.now();
    const response = await post(p, body);
    let firstTokenMs: number | undefined, done = false, finishReason: string | null = null;
    let valueRead = false, sample: ReturnType<typeof cacheSample> | undefined, completionTokens: number | undefined;
    if (!response.ok) { await response.body?.cancel(); throw new Error("integrity_generation_http_failure"); }
    if (body.stream) {
      let timings: unknown, usage: unknown;
      const inspector = new OpenAiChatCompletionSseInspector(chunk => {
        timings = chunk.timings ?? timings; usage = chunk.usage ?? usage;
        completionTokens = chunk.usage?.completion_tokens ?? completionTokens;
        for (const c of chunk.choices) {
          if (c.finish_reason) finishReason = c.finish_reason;
          if (typeof c.delta.content === "string" && c.delta.content.length) firstTokenMs ??= performance.now() - start;
        }
      });
      const reader = response.body!.getReader();
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          const progress = inspector.push(part.value);
          if (!progress.ok) throw new Error(`integrity_sse_${progress.reason}`);
        }
        const result = inspector.finish();
        if (!result.ok) {
          if (process.env.LARM_CHAT_BASELINE === "true") {
            failed++; emit({ label, success: false, reason: result.reason, total_ms: performance.now() - start }); return;
          }
          throw new Error(`integrity_sse_${result.reason}`);
        }
        done = true;
        sample = cacheSample({ timings, usage, choices: [{ finish_reason: finishReason }] });
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } else {
      const value = await response.json() as { choices: { message: { content?: string }; finish_reason: string }[]; usage: { completion_tokens: number } };
      sample = cacheSample(value);
      finishReason = value.choices[0]?.finish_reason ?? null;
      completionTokens = value.usage.completion_tokens;
      valueRead = expectedValue !== undefined && value.choices[0]?.message.content?.trim() === expectedValue;
      done = true;
    }
    samples[label] = sample;
    if (sample.prompt_tokens !== count.promptTokens) throw new Error("integrity_count_generation_mismatch");
    if (expectedValue !== undefined && !valueRead) failed++;
    const phases = Object.fromEntries([...(response.headers.get("server-timing") ?? "").matchAll(/([a-z_]+);dur=([0-9.]+)/g)].map(m => [m[1], Number(m[2])]));
    emit({ label, promptTokens: count.promptTokens, ...sample, count_ms: countMs, total_ms: performance.now() - start,
      phases_ms: phases, first_token_ms: firstTokenMs, finishReason, completionTokens, terminal: done,
      ...(expectedValue !== undefined ? { valueRead, success: valueRead } : { success: done }) });
    return sample;
  };
  try {
    const main = await create("main");
    const fixtures = instructionPlacements();
    for (const [label, messages] of Object.entries(fixtures.cases)) await measure(main.provider, label, { messages, stream: false, max_tokens: 128, temperature: 0 }, fixtures.value);
    // Fixed long prefix; suffix edits and prefix edits are separate experiments.
    const prefix = "Synthetic cache matrix. Reply OK only.\n" + "The blue triangle is on the empty test shelf.\n".repeat(260);
    const body = (variant = "same", changedPrefix = false, key?: string) => ({ messages: [
      { role: "system", content: `${changedPrefix ? "Independent changed prefix.\n" : ""}${prefix}` },
      { role: "user", content: variant === "same" ? "Reply OK." : "Reply OK for the changed suffix." }],
      stream: false, max_tokens: 16, temperature: 0, ...(key ? { prompt_cache_key: key } : {}) });
    await measure(main.provider, "cache-same-connection-cold", body());
    await measure(main.provider, "cache-same-connection-same-prefix", body());
    await measure(main.provider, "cache-same-connection-changed-suffix", body("suffix"));
    await measure(main.provider, "cache-same-connection-changed-prefix", body("same", true));
    const longBody = (json: boolean) => ({ messages: [
      { role: "system", content: "Synthetic long reference. Reply with OK only, or a JSON object containing result OK if JSON is requested.\n" + "The blue triangle is on the empty test shelf.\n".repeat(1260) },
      { role: "user", content: json ? "Reply as a JSON object." : "Reply OK only." }],
      stream: false, max_tokens: 512, temperature: 0, ...(json ? { response_format: { type: "json_object" } } : {}) });
    for (const json of [false, true]) {
      await measure(main.provider, `long-${json ? "json" : "text"}-first`, longBody(json));
      await measure(main.provider, `long-${json ? "json" : "text"}-repeat`, longBody(json));
    }
    for (let i = 0; i < 2; i++) {
      const aux = await create("auxiliary");
      await measure(aux.provider, `cache-new-connection-${i}-changed-prefix`, body("same", true));
      await measure(aux.provider, `cache-new-connection-${i}-same-prefix`, body());
      await measure(aux.provider, `cache-new-connection-${i}-repeat`, body());
      await release(aux.id);
    }
    const key = `synthetic-aux-${crypto.randomUUID()}`;
    for (let i = 0; i < 2; i++) {
      const aux = await create("keyed-auxiliary");
      await measure(aux.provider, `cache-new-keyed-connection-${i}-same-prefix`, body("same", false, key));
      await measure(aux.provider, `cache-new-keyed-connection-${i}-changed-suffix`, body("suffix", false, key));
      if (i === 1) await measure(aux.provider, "cache-new-keyed-connection-1-changed-prefix", body("same", true, key));
      await release(aux.id);
    }
    await measure(main.provider, "cache-main-after-auxiliaries", body());
    for (const json of [false, true]) await measure(main.provider, `long-${json ? "json" : "text"}-after-four-auxiliaries`, longBody(json));
    for (const max_tokens of [1, 128, 512]) for (let i = 0; i < 3; i++) {
      await measure(main.provider, `stream-cap-${max_tokens}-${i}`, { messages: [{ role: "user", content: "Count from one to one thousand in words, writing one number per line. Continue until one thousand." }], stream: true,
        stream_options: { include_usage: true }, max_tokens, temperature: 0 });
    }
    await measure(main.provider, "stream-natural-stop", { messages: [{ role: "user", content: "Reply OK only." }], stream: true, stream_options: { include_usage: true }, max_tokens: 128, temperature: 0 });
    await measure(main.provider, "stream-empty-stop", { messages: [{ role: "user", content: "Reply OK only." }], stream: true,
      stream_options: { include_usage: true }, max_tokens: 128, temperature: 0, stop: ["OK"] });
    const after = await (await fetch(`${baseUrl}/health`)).json() as Record<string, unknown>;
    if (["releaseCommit", "bootEpoch", "configRevision"].some(k => before[k] !== after[k])) throw new Error("integrity_health_changed");
    emit({ label: "health-after", releaseCommit: after.releaseCommit, bootEpoch: after.bootEpoch, configRevision: after.configRevision });
    for (const label of ["cache-same-connection-same-prefix", "cache-same-connection-changed-suffix", "cache-new-keyed-connection-1-same-prefix", "cache-main-after-auxiliaries"]) {
      if (!samples[label] || samples[label]!.cache_n < 1024) throw new Error("integrity_cache_reuse_failed");
    }
    for (const label of ["cache-same-connection-changed-prefix", "cache-new-connection-0-same-prefix", "cache-new-connection-1-same-prefix", "cache-new-connection-0-changed-prefix", "cache-new-connection-1-changed-prefix", "cache-new-keyed-connection-1-changed-prefix"]) {
      if (samples[label]?.cache_n !== 0) throw new Error("integrity_cache_isolation_failed");
    }
    for (const kind of ["text", "json"]) {
      const sample = samples[`long-${kind}-after-four-auxiliaries`];
      if (!sample || sample.prompt_tokens < 12000 || sample.cache_n < sample.prompt_tokens - 1024) throw new Error("integrity_long_cache_retention_failed");
    }
    if (failed > 0 && process.env.LARM_CHAT_BASELINE !== "true") throw new Error("integrity_acceptance_failed");
  } finally {
    const results = await Promise.allSettled([...owned].map(release));
    if (results.some(r => r.status === "rejected")) throw new Error("integrity_cleanup_failed");
  }
}
if (import.meta.main) await verifyChatMessageIntegrity();
