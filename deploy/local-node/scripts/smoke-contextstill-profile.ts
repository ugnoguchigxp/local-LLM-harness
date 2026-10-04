import {
  agentProviderHealthSchema,
  inspectOpenAiChatCompletionJson,
} from "../../../packages/core/src/index";
import { LarmClient } from "../../../packages/client/src/index";
import { runAgentHttpSmoke, type AgentHttpSmokeFetch } from "./smoke-agent-http";

export async function runContextStillSmoke(options: {
  baseUrl: string;
  apiToken: string;
  expectedReleaseCommit: string;
  fetch?: AgentHttpSmokeFetch;
}) {
  if (!/^[a-f0-9]{40}$/.test(options.expectedReleaseCommit)) {
    throw new Error("expectedReleaseCommit must be a full lowercase Git commit");
  }
  const client = new LarmClient({ ...options, timeoutMs: 300_000 });
  const fetchImpl = options.fetch ?? fetch;
  const health = await client.getHealth();
  if (!health.ready || health.releaseCommit !== options.expectedReleaseCommit) {
    throw new Error("release identity/readiness mismatch");
  }
  if ((await client.getServiceActivity()).state !== "idle") {
    throw new Error("LARM must be idle before the ContextStill canary");
  }
  const catalog = await client.listAgentProfilesV3("contextStill");
  const profile = catalog.profiles.find((profile) => profile.id === "contextstill-background");
  const names = profile?.providers.map((provider) => `${provider.name}:${provider.protocol}`).sort();
  const expected = [
    "embedding:larm.embedding.v1", "llm:openai.chat-completions.v1", "system-one:larm.system-one.v1",
  ];
  if (!profile || JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("ContextStill Provider catalog drift");
  const created = await client.createAgentConnection({
    profile: "contextStill", expectedCatalogRevision: catalog.catalogRevision,
    audience: "same-host", client: "contextstill-live-smoke", providers: ["llm", "system-one", "embedding"],
    ttlSeconds: 900, allowFallback: false, deploymentPolicy: "existing-only",
  });
  let released = false;
  let maxActiveRequests = 0;
  try {
    const ready = await client.waitForAgentConnection(created, { timeoutMs: 300_000 });
    const claim = await client.claimAgentConnection(ready.id);
    const llm = claim.providers.find((provider) => provider.name === "llm" && provider.apiStyle === "openai");
    const laya = claim.providers.find((provider) => provider.name === "system-one" && provider.apiStyle === "larm-system-one");
    const embedding = claim.providers.find((provider) => provider.name === "embedding" && provider.apiStyle === "larm-embedding");
    if (claim.providers.length !== 3 || !llm || llm.apiStyle !== "openai"
      || !laya || laya.apiStyle !== "larm-system-one"
      || !embedding || embedding.apiStyle !== "larm-embedding") throw new Error("claim omitted a Provider");
    for (const provider of claim.providers) {
      const advertised = profile.providers.find((candidate) => candidate.name === provider.name);
      if (provider.model !== advertised?.model || provider.protocol !== advertised.protocol) {
        throw new Error("claimed Provider does not match discovery");
      }
    }
    if (llm.model !== "ornith-contextstill") throw new Error("unexpected ContextStill LLM model");
    const providerHealth = async (provider: typeof claim.providers[number], signal?: AbortSignal, requireAccepting = true) => {
      const response = await fetchImpl(provider.health.url, {
        headers: { authorization: `Bearer ${provider.credential.token}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Provider health returned HTTP ${response.status}`);
      }
      const value = agentProviderHealthSchema.parse(await response.json());
      if (value.name !== provider.name || value.capability !== provider.capability
        || !value.ready || (requireAccepting && !value.acceptingRequests) || !value.probe?.validated
        || value.probe.protocol !== provider.protocol) throw new Error(`Provider ${provider.name} is not ready`);
      return value;
    };
    for (const provider of claim.providers) {
      const value = await providerHealth(provider);
      if (provider.name === "llm" && value.capacity?.maxConcurrentRequests !== 4) {
        throw new Error("ContextStill LLM does not advertise four execution slots");
      }
    }
    const decision = await client.systemOne(laya, {
      model: laya.model, state: "返品して返金をお願いします",
      questions: { intent: { type: "choice", instructions: "問い合わせの意図を分類してください",
        criteria: { refund: "返品または返金", other: "その他" } } },
    });
    if (decision.answers.intent?.choice !== "refund") throw new Error("Laya intent classification failed");
    for (const type of ["query", "passage"] as const) {
      const value = await client.embed(embedding, { texts: ["返品と返金についての案内"], type, normalize: true, priority: "normal" });
      const norm = Math.hypot(...value.embeddings[0]!);
      if (value.dimension !== 384 || value.count !== 1 || Math.abs(norm - 1) > 0.001) {
        throw new Error("Embedding dimensions or normalization mismatch");
      }
    }
    const sampling = new AbortController();
    let samplingError: unknown;
    const sampler = (async () => {
      // Once four slots are observed, further semantic probes cannot add
      // evidence and may expire while all slots are occupied by generation.
      while (!sampling.signal.aborted && maxActiveRequests < 4) {
        const value = await providerHealth(llm, sampling.signal, false);
        maxActiveRequests = Math.max(maxActiveRequests, value.capacity?.activeRequests ?? 0);
        await Bun.sleep(100);
      }
    })().catch((error) => { if (!sampling.signal.aborted) samplingError = error; });
    try {
      const results = await Promise.allSettled(Array.from({ length: 4 }, async (_, i) => {
        const response = await fetchImpl(`${llm.baseUrl}/chat/completions`, {
          method: "POST", headers: { authorization: `Bearer ${llm.credential.token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: llm.model,
            messages: [{ role: "user", content: `図書館の利用方法を日本語で5項目で説明してください。試験番号${i + 1}。` }],
            max_tokens: 192, temperature: 0, chat_template_kwargs: { enable_thinking: false } }),
          signal: AbortSignal.timeout(300_000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`LLM generation returned HTTP ${response.status}`);
        }
        const inspected = inspectOpenAiChatCompletionJson(await response.json());
        if (!inspected.ok || inspected.model !== llm.model || inspected.textChoices < 1) {
          throw new Error("LLM returned an invalid completion");
        }
      }));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    } finally {
      sampling.abort();
      await sampler;
    }
    if (samplingError) throw samplingError;
    if (maxActiveRequests !== 4) throw new Error(`expected four simultaneous requests; observed ${maxActiveRequests}`);
    await client.releaseAgentConnection(ready.id);
    released = true;
    const revoked = await fetchImpl(laya.endpoint, {
      method: "POST", headers: { authorization: `Bearer ${laya.credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: laya.model, state: "x", questions: { q: { type: "noul", instructions: "test" } } }),
      signal: AbortSignal.timeout(5_000),
    });
    await revoked.body?.cancel();
    if (revoked.status !== 401) throw new Error("released Provider credential was not revoked");
  } catch (error) {
    if (!released) {
      try {
        await client.releaseAgentConnection(created.id);
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], "ContextStill smoke failed and its Connection could not be released");
      }
    }
    throw error;
  }
  const subset = await runAgentHttpSmoke({
    ...options, agentProfile: "contextstill-background", profile: "contextStill", audience: "same-host",
    client: "contextstill-subset-live-smoke", providers: ["llm"], expectedModel: "ornith-contextstill", timeoutMs: 300_000,
    // Another consumer may connect after the initial idle snapshot. The
    // subset check verifies its own release and credential revocation.
    requireIdleBeforeCreate: false, requireIdleAfterRelease: false,
  });
  return { ok: true, releaseCommit: health.releaseCommit, configRevision: health.configRevision,
    providers: names, maxActiveRequests, layaValidated: true, embeddingValidated: true,
    released: true, credentialRevoked: true, subset };
}

if (import.meta.main) {
  const apiToken = process.env.LARM_API_TOKEN;
  const expectedReleaseCommit = process.env.LARM_EXPECTED_RELEASE_COMMIT;
  if (!apiToken || !expectedReleaseCommit) throw new Error("LARM_API_TOKEN and LARM_EXPECTED_RELEASE_COMMIT are required");
  console.log(JSON.stringify(await runContextStillSmoke({
    baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810", apiToken, expectedReleaseCommit,
  }), null, 2));
}
