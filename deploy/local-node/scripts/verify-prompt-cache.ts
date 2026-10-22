import { z } from "zod";
import { LarmClient, LarmApiError } from "../../../packages/client/src/index";
import type { AgentConnectionClaim } from "../../../packages/core/src/agent-connection";
import { agentProfileSelectorIdSchema, type AgentProfileSelectorId } from "../../../packages/core/src/agent-connection";
import { chatInputTokenCountSchema } from "../../../packages/core/src/chat-input";

type Provider = Extract<AgentConnectionClaim["providers"][number], { apiStyle: "openai" }>;
export type CacheSample = { prompt_n: number; cache_n: number; prompt_ms: number; prompt_tokens: number; cached_tokens: number };
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const completion = z.object({
  timings: z.object({ prompt_n: tokenCount.positive(), cache_n: tokenCount, prompt_ms: z.number().nonnegative().finite() }),
  usage: z.object({ prompt_tokens: tokenCount.positive(), prompt_tokens_details: z.object({ cached_tokens: tokenCount }) }),
  choices: z.array(z.object({ finish_reason: z.enum(["stop", "length", "tool_calls"]) })).length(1),
});

/** Whitelist numeric evidence; never retain generated text, requests or credentials. */
export function cacheSample(body: unknown): CacheSample {
  const parsed = completion.safeParse(body);
  if (!parsed.success) throw new Error("missing complete numeric cache evidence");
  const { timings, usage } = parsed.data;
  const sample = { ...timings, prompt_tokens: usage.prompt_tokens, cached_tokens: usage.prompt_tokens_details.cached_tokens };
  if (sample.cache_n !== sample.cached_tokens || sample.prompt_n + sample.cache_n !== sample.prompt_tokens) throw new Error("inconsistent cache counters");
  return sample;
}

export function assertReuse(sample: CacheSample, expectedPrefix: number, tolerance: number): void {
  if (![expectedPrefix, tolerance].every(v => Number.isSafeInteger(v) && v >= 0) || expectedPrefix <= tolerance) throw new Error("invalid reuse threshold");
  // prompt_n is processed tokens; the full input is usage.prompt_tokens.
  if (sample.cache_n < expectedPrefix - tolerance) throw new Error("prefix reuse acceptance failed");
}

type VerificationClient = Pick<LarmClient, "listAgentProfilesV3" | "createAgentConnection" | "waitForAgentConnection" | "claimAgentConnection" | "releaseAgentConnection">;
type VerificationOptions = { baseUrl: string; apiToken: string; profile: AgentProfileSelectorId; auxiliaryProfile?: AgentProfileSelectorId; audience?: string; auxiliaries?: number; baseline?: boolean };
type VerificationDependencies = {
  client?: VerificationClient;
  fetch?: typeof fetch;
  emit?: (value: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<unknown>;
};

export async function verifyPromptCache(options: VerificationOptions, dependencies: VerificationDependencies = {}) {
  const client = dependencies.client ?? new LarmClient({ baseUrl: options.baseUrl, apiToken: options.apiToken, timeoutMs: 90_000 });
  const fetchImpl = dependencies.fetch ?? fetch;
  const emit = dependencies.emit ?? (value => console.log(JSON.stringify(value)));
  const owned = new Set<string>();
  const samples: Record<string, CacheSample> = {};
  const auxiliaries = options.auxiliaries ?? 1;
  if (![1, 2, 3].includes(auxiliaries)) throw new Error("auxiliaries must be 1..3");
  const run = crypto.randomUUID();
  const catalog = await client.listAgentProfilesV3(options.profile);
  const create = async (index: number): Promise<Provider> => {
    const request = { profile: index > 0 ? options.auxiliaryProfile ?? options.profile : options.profile, providers: ["llm"],
      client: `prefix-acceptance-${run}-${index}`, audience: options.audience ?? "same-host",
      expectedCatalogRevision: catalog.catalogRevision, ttlSeconds: 900,
      allowFallback: false, deploymentPolicy: "existing-only" as const };
    // Reuse the key on an ambiguous create failure to recover the test-owned ID.
    const idempotencyKey = crypto.randomUUID();
    let created;
    try { created = await client.createAgentConnection(request, { waitSeconds: 1, idempotencyKey }); }
    catch (error) {
      if (error instanceof LarmApiError && error.status < 500) throw error;
      created = await client.createAgentConnection(request, { waitSeconds: 1, idempotencyKey });
    }
    owned.add(created.id);
    await client.waitForAgentConnection(created, { timeoutMs: 30_000 });
    const claim = await client.claimAgentConnection(created.id);
    if (claim.id !== created.id) throw new Error("claim connection mismatch");
    const provider = claim.providers.find((p): p is Provider => p.name === "llm" && p.apiStyle === "openai" && p.protocol === "openai.chat-completions.v1");
    if (!provider) throw new Error("LLM provider is missing");
    return provider;
  };
  const requestBody = (provider: Provider, system: string, user: string) => ({ model: provider.model, stream: false, max_tokens: 16,
    messages: [{ role: "system", content: system }, { role: "user", content: user }] });
  const post = async (provider: Provider, suffix: string, system: string, user: string) => {
    const response = await fetchImpl(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${provider.credential.token}` },
      body: JSON.stringify(requestBody(provider, system, user)), redirect: "error", signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`inference HTTP ${response.status}`); }
    return response.json();
  };
  let identity: string | undefined;
  const count = async (provider: Provider, system: string, user: string) => {
    const parsed = chatInputTokenCountSchema.safeParse(await post(provider, "/input-tokens", system, user));
    if (!parsed.success) throw new Error("token-count contract is unavailable");
    const result = parsed.data;
    if (result.model !== provider.model || !result.fits || result.imageCount !== 0) throw new Error("unexpected token-count result");
    const current = JSON.stringify([result.runtime, result.runtimeRelease, result.engineBuild, result.configRevision, result.bootEpoch]);
    if (identity !== undefined && identity !== current) throw new Error("resolved runtime or generation changed during verification");
    identity = current;
    return result;
  };
  const chat = async (provider: Provider, label: string, system: string, user: string) => {
    const expected = await count(provider, system, user);
    const sample = cacheSample(await post(provider, "", system, user));
    if (sample.prompt_tokens !== expected.promptTokens) throw new Error("generated prompt differs from measured input");
    // A count-only check cannot evict KV; it detects catalog/engine/daemon changes.
    await count(provider, system, user);
    samples[label] = sample;
    emit({ label, ...sample });
    return sample;
  };
  let result;
  let failure: unknown;
  try {
    const main = await create(0);
    const peers: Provider[] = [];
    for (let i = 1; i <= auxiliaries; i++) {
      const peer = await create(i);
      if (peer.model !== main.model) throw new Error("connections must resolve to the same public model");
      peers.push(peer);
    }
    const system = `Synthetic cache acceptance ${run}. Reply only OK.\n` + "The synthetic blue triangle is on the empty test shelf.\n".repeat(280);
    const withSystem = await count(main, system, "");
    const empty = await count(main, "", "");
    // Difference of identical templates estimates system content tokens, without
    // mistaking all of the user turn for the shared prefix. Boundary BPE can
    // differ slightly; retain a separate 32-token template allowance.
    const systemPrefixTokensEstimate = withSystem.promptTokens - empty.promptTokens;
    if (systemPrefixTokensEstimate < 2048) throw new Error("synthetic prefix is too short for acceptance");
    const first = await chat(main, "identical-first", system, "Reply OK for alpha.");
    await (dependencies.sleep ?? Bun.sleep)(300);
    const identical = await chat(main, "identical-second", system, "Reply OK for alpha.");
    const changed = await chat(main, "different-user", system, "Count the synthetic circles and reply OK for beta.");
    const interleavingSystem = `Independent interleaving scenario ${run}.\n${system}`;
    const beforeInterleaving = await chat(main, "before-other-connections", interleavingSystem, "Reply OK for gamma.");
    for (let i = 0; i < peers.length; i++) await chat(peers[i]!, `other-connection-${i + 1}`, `Independent synthetic peer ${i} ${run}. Reply OK.`, "Synthetic green square.");
    const interleaved = await chat(main, "after-other-connections", interleavingSystem, "Reply OK for gamma.");
    if (!options.baseline) {
      if (identical.prompt_tokens !== first.prompt_tokens || interleaved.prompt_tokens !== beforeInterleaving.prompt_tokens) throw new Error("identical requests produced different token totals");
      assertReuse(identical, first.prompt_tokens, 32);
      assertReuse(changed, systemPrefixTokensEstimate, 512 + 32);
      assertReuse(interleaved, beforeInterleaving.prompt_tokens, 32);
    }
    result = { baseline: options.baseline ?? false, auxiliaries, systemPrefixTokensEstimate, runtime: withSystem.runtime, samples };
  } catch (error) { failure = error; }
  const released = await Promise.allSettled([...owned].map(id => client.releaseAgentConnection(id)));
  if (released.some(r => r.status === "rejected")) {
    emit({ cleanupIncomplete: true, remainingTestConnections: released.filter(r => r.status === "rejected").length });
    // Preserve the primary failure; raw backend error objects never reach logs.
    if (failure === undefined) failure = new Error("test-owned connection cleanup incomplete");
  }
  if (failure !== undefined) throw failure;
  return result!;
}

if (import.meta.main) {
  try {
    const token = process.env.LARM_API_TOKEN;
    if (!token) throw new Error("LARM_API_TOKEN is required");
    const result = await verifyPromptCache({ baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810", apiToken: token,
      profile: agentProfileSelectorIdSchema.parse(process.env.LARM_CACHE_PROFILE ?? "ornith1.5Strix"), auxiliaries: Number(process.env.LARM_CACHE_AUXILIARIES ?? 1),
      ...(process.env.LARM_CACHE_AUXILIARY_PROFILE ? { auxiliaryProfile: agentProfileSelectorIdSchema.parse(process.env.LARM_CACHE_AUXILIARY_PROFILE) } : {}),
      baseline: process.env.LARM_CACHE_BASELINE === "true" });
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    if (error instanceof LarmApiError) console.error(JSON.stringify({ httpStatus: error.status,
      code: /^[a-z_]+$/.test(error.code) ? error.code : "unreported" }));
    console.error("prompt-cache verification failed; only numeric evidence above is safe to retain");
    process.exitCode = 1;
  }
}
