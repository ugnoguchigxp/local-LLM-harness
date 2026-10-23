import { readFile } from "node:fs/promises";
import { z } from "zod";
import { LarmClient, LarmApiError } from "../../../packages/client/src/index";
import { agentProfileSelectorIdSchema, type AgentConnectionClaim } from "../../../packages/core/src/agent-connection";
import { chatInputTokenCountSchema } from "../../../packages/core/src/chat-input";
import { OpenAiChatCompletionSseInspector } from "../../../packages/core/src/openai-sse";
import { cacheSample, assertReuse } from "./verify-prompt-cache";

type Provider = Extract<AgentConnectionClaim["providers"][number], { apiStyle: "openai" }>;
const timingSchema = z.object({ prompt_n: z.number().int().nonnegative(), cache_n: z.number().int().nonnegative(), prompt_ms: z.number().finite().nonnegative() });
const usageSchema = z.object({ prompt_tokens: z.number().int().positive(), prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative() }) });

/** Numeric evidence only. Requests, generated text and bearer credentials never reach output. */
export async function consumeRetentionStream(response: Response, started: number, onFirstToken?: () => void) {
  if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
    await response.body?.cancel();
    throw new Error("retention_stream_http_failure");
  }
  let timings: z.infer<typeof timingSchema> | undefined;
  let usage: z.infer<typeof usageSchema> | undefined;
  let finishReason: string | undefined;
  let firstTokenMs: number | undefined;
  let deltas = 0;
  let bytes = 0;
  const inspector = new OpenAiChatCompletionSseInspector(chunk => {
    const t = timingSchema.safeParse(chunk.timings);
    const u = usageSchema.safeParse(chunk.usage);
    if (t.success) timings = t.data;
    if (u.success) usage = u.data;
    for (const choice of chunk.choices) if (choice.finish_reason !== null) finishReason = choice.finish_reason;
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("retention_stream_missing_body");
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if ((bytes += part.value.byteLength) > 4 * 1024 * 1024) throw new Error("retention_stream_too_large");
      const progress = inspector.push(part.value);
      if (!progress.ok) throw new Error("retention_stream_invalid");
      if (progress.deltas > deltas && firstTokenMs === undefined) {
        firstTokenMs = performance.now() - started;
        onFirstToken?.();
      }
      deltas = progress.deltas;
    }
    if (!inspector.finish().ok || firstTokenMs === undefined) throw new Error("retention_stream_incomplete");
    return { ...cacheSample({ timings, usage, choices: [{ finish_reason: finishReason }] }),
      first_token_ms: firstTokenMs, total_ms: performance.now() - started };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function main() {
  const apiToken = process.env.LARM_API_TOKEN;
  if (!apiToken) throw new Error("retention_auth_missing");
  const pid = z.coerce.number().int().positive().parse(process.env.LARM_CACHE_ENGINE_PID);
  const slotUrl = new URL(process.env.LARM_CACHE_SLOTS_URL ?? "http://127.0.0.1:58009/slots");
  if (slotUrl.hostname !== "127.0.0.1" || slotUrl.pathname !== "/slots") throw new Error("retention_slots_must_be_local");
  const client = new LarmClient({ baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810", apiToken, timeoutMs: 120_000 });
  const catalog = await client.listAgentProfilesV3();
  // This is the LARM catalog default, not a reconstruction of Eumenes' saved intent.
  const profile = agentProfileSelectorIdSchema.parse(process.env.LARM_CACHE_PROFILE ?? catalog.defaultAgentProfile);
  const baseline = process.env.LARM_CACHE_BASELINE !== "false";
  const streaming = process.env.LARM_CACHE_STREAM !== "false";
  const run = crypto.randomUUID();
  const fixture = z.uuid().parse(process.env.LARM_CACHE_FIXTURE_ID ?? run);
  const owned = new Set<string>();
  const emit = (value: Record<string, unknown>) => console.log(JSON.stringify(value));
  const diagnostics = async () => {
    const [status, meminfo, response] = await Promise.all([
      readFile(`/proc/${pid}/status`, "utf8"), readFile("/proc/meminfo", "utf8"),
      fetch(slotUrl, { signal: AbortSignal.timeout(5000), redirect: "error" }),
    ]);
    if (!response.ok) { await response.body?.cancel(); throw new Error("retention_slots_unavailable"); }
    // Task IDs are absent with safe, non-debug slot reporting.
    const slots = z.array(z.object({ id: z.number().int(), id_task: z.number().int().optional(), is_processing: z.boolean(), n_ctx: z.number().int() })).parse(await response.json());
    const kb = (text: string, key: string) => z.number().finite().nonnegative().parse(
      Number(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text)?.[1] ?? NaN));
    return { rss_kib: kb(status, "VmRSS"), swap_kib: kb(status, "VmSwap"), mem_available_kib: kb(meminfo, "MemAvailable"), slots };
  };
  const create = async (index: number): Promise<Provider> => {
    const key = crypto.randomUUID();
    const request = { profile, providers: ["llm"], client: `retention-e2e-${run}-${index}`, audience: "same-host",
      expectedCatalogRevision: catalog.catalogRevision, ttlSeconds: 900, allowFallback: false, deploymentPolicy: "existing-only" as const };
    // Retry an ambiguous create using the same key, so cleanup can recover our own ID.
    let connection;
    try { connection = await client.createAgentConnection(request, { idempotencyKey: key, waitSeconds: 1 }); }
    catch (error) {
      if (error instanceof LarmApiError && error.status < 500) throw error;
      connection = await client.createAgentConnection(request, { idempotencyKey: key, waitSeconds: 1 });
    }
    owned.add(connection.id);
    await client.waitForAgentConnection(connection, { timeoutMs: 30_000 });
    const claim = await client.claimAgentConnection(connection.id);
    if (claim.id !== connection.id) throw new Error("retention_claim_mismatch");
    const provider = claim.providers.find((p): p is Provider => p.name === "llm" && p.apiStyle === "openai" && p.protocol === "openai.chat-completions.v1");
    if (!provider) throw new Error("retention_provider_missing");
    return provider;
  };
  let identity: string | undefined;
  let reportedIdentity = false;
  const payload = (p: Provider, system: string, user: string) => ({ model: p.model, max_tokens: 16,
    messages: [{ role: "system", content: system }, { role: "user", content: user }] });
  const count = async (p: Provider, system: string, user: string) => {
    const response = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions/input-tokens`, {
      method: "POST", headers: { authorization: `Bearer ${p.credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload(p, system, user)), redirect: "error", signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error("retention_count_http_failure"); }
    const result = chatInputTokenCountSchema.parse(await response.json());
    if (!result.fits || result.model !== p.model) throw new Error("retention_input_invalid");
    const next = JSON.stringify([result.runtime, result.runtimeRelease, result.engineBuild, result.configRevision, result.bootEpoch]);
    if (identity !== undefined && identity !== next) throw new Error("retention_runtime_changed");
    identity = next;
    if (!reportedIdentity) {
      reportedIdentity = true;
      emit({ label: "resolved-identity", fixture, streaming, profile, runtime: result.runtime, runtimeRelease: result.runtimeRelease,
        engineBuild: result.engineBuild, configRevision: result.configRevision, bootEpoch: result.bootEpoch });
    }
    return result.promptTokens;
  };
  const chat = async (p: Provider, label: string, system: string, user: string) => {
    const expected = await count(p, system, user);
    const before = await diagnostics();
    const started = performance.now();
    const response = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${p.credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...payload(p, system, user), stream: streaming, ...(streaming ? { stream_options: { include_usage: true } } : {}) }),
      redirect: "error", signal: AbortSignal.timeout(120_000),
    });
    let result;
    if (streaming) result = await consumeRetentionStream(response, started);
    else {
      if (!response.ok) { await response.body?.cancel(); throw new Error("retention_json_http_failure"); }
      result = { ...cacheSample(await response.json()), first_token_ms: null, total_ms: performance.now() - started };
    }
    const after = await diagnostics();
    if (result.prompt_tokens !== expected || await count(p, system, user) !== expected) throw new Error("retention_token_count_changed");
    emit({ label, ...result, before, after });
    return result;
  };
  let failure: unknown;
  try {
    const mainProvider = await create(0);
    const auxiliary = await create(1);
    let repeats = 1100;
    let system = "";
    // Use the engine's tokenizer, not a character/token conversion assumption.
    for (let attempt = 0; attempt < 5; attempt++) {
      system = `Main synthetic acceptance ${fixture}. Reply only OK.\n` + "The synthetic blue triangle is on the empty test shelf.\n".repeat(repeats);
      const n = await count(mainProvider, system, "Reply OK for alpha.");
      if (n >= 13_500 && n <= 15_000) break;
      repeats = Math.max(1, Math.round(repeats * 14_000 / n));
    }
    const total = await count(mainProvider, system, "Reply OK for alpha.");
    if (total < 13_500 || total > 15_000) throw new Error("retention_long_input_not_calibrated");
    const systemEstimate = await count(mainProvider, system, "") - await count(mainProvider, "", "");
    const first = await chat(mainProvider, "identical-first", system, "Reply OK for alpha.");
    await Bun.sleep(300);
    const identical = await chat(mainProvider, "identical-second", system, "Reply OK for alpha.");
    const changed = await chat(mainProvider, "different-user", system, "Reply OK for the synthetic beta circle.");
    const before = await chat(mainProvider, "before-four-auxiliaries", system, "Reply OK for alpha.");
    // Four different prefixes; sequential calls reuse one auxiliary Connection.
    // No fixed id_slot, cache_prompt override, server restart, or other Connection release.
    for (let i = 0; i < 4; i++) await chat(auxiliary, `auxiliary-${i + 1}`,
      `Auxiliary synthetic branch ${i} ${fixture}. Reply only OK.\n` + `Independent branch ${i} has a green square and an orange circle.\n`.repeat(160), "Reply OK.");
    const after = await chat(mainProvider, "after-four-auxiliaries", system, "Reply OK for alpha.");
    const checks = { identical: identical.cache_n >= first.prompt_tokens - 32,
      changed_user_conservative: changed.cache_n >= systemEstimate - 544, retained: after.cache_n >= before.prompt_tokens - 32 };
    emit({ label: "summary", baseline, streaming, system_tokens_estimate: systemEstimate, checks,
      limitations: ["single_trial", "same_authenticated_consumer", "two_test_connections", "memory_before_after_not_peak", "slots_before_after_not_authoritative_request_mapping"] });
    if (!baseline) {
      assertReuse(identical, first.prompt_tokens, 32);
      assertReuse(changed, systemEstimate, 544);
      assertReuse(after, before.prompt_tokens, 32);
    }
  } catch (error) { failure = error; }
  const cleanup = await Promise.allSettled([...owned].map(id => client.releaseAgentConnection(id)));
  emit({ label: "cleanup", test_connections: owned.size, failed: cleanup.filter(x => x.status === "rejected").length });
  if (cleanup.some(x => x.status === "rejected") && failure === undefined) failure = new Error("retention_cleanup_incomplete");
  if (failure !== undefined) throw failure;
}

if (import.meta.main) await main().catch((error: unknown) => {
  // Only our fixed diagnostic identifiers are safe; API messages may contain bodies.
  const reason = error instanceof Error && /^retention_[a-z_]+$/.test(error.message)
    ? error.message : "retention_unclassified_failure";
  console.error(JSON.stringify({ label: "failure", reason }));
  process.exitCode = 1;
});
