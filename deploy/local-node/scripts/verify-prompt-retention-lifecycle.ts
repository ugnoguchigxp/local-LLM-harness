import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { LarmClient, LarmApiError } from "../../../packages/client/src/index";
import { agentProfileSelectorIdSchema, type AgentConnectionClaim } from "../../../packages/core/src/agent-connection";
import { consumeRetentionStream } from "./verify-prompt-cache-retention";
import { cacheSample } from "./verify-prompt-cache";

type Provider = Extract<AgentConnectionClaim["providers"][number], { apiStyle: "openai" }>;
const emit = (value: Record<string, unknown>) => console.log(JSON.stringify(value));
const check = (ok: boolean, reason: string) => { if (!ok) throw new Error(`retention_${reason}`); };
let stage = "setup";

/** Explicit isolated HTTP E2E. All completion/audio content is inspected in memory only. */
async function main() {
  const phase = z.enum(["mixed", "budget", "lifecycle", "keys", "audio", "exchange", "restore"]).parse(process.env.LARM_RETENTION_PHASE);
  const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:19810";
  check(baseUrl === "http://127.0.0.1:19810", "isolated_endpoint_required");
  const secret = JSON.parse(await readFile(z.string().parse(process.env.LARM_TEST_SECRETS), "utf8"));
  const privateEnv = JSON.parse(await readFile(z.string().parse(process.env.LARM_TEST_ENV), "utf8"));
  const baseline = process.env.LARM_CACHE_BASELINE !== "false";
  const fixture = z.uuid().parse(process.env.LARM_CACHE_FIXTURE_ID);
  const clients = [secret.apiToken, secret.peerToken].map(apiToken => new LarmClient({ baseUrl, apiToken, timeoutMs: 120_000 }));
  const catalog = await clients[0]!.listAgentProfilesV3();
  const profile = agentProfileSelectorIdSchema.parse(catalog.defaultAgentProfile);
  const owned = new Map<string, LarmClient>();
  const stats = async () => {
    const r = await fetch("http://127.0.0.1:58109/larm/cache/invalidate", { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", "x-larm-cache-key": privateEnv.LARM_PROMPT_CACHE_KEY },
      body: JSON.stringify({ action: "inspect" }), signal: AbortSignal.timeout(5000) });
    if (baseline) { await r.body?.cancel(); return undefined; }
    check(r.ok, "inspection_failed");
    return z.object({ entries: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), metadataBytes: z.number().int().nonnegative(),
      saves: z.number().int().nonnegative(), loads: z.number().int().nonnegative(), evictions: z.number().int().nonnegative(),
      bypasses: z.number().int().nonnegative(), failures: z.number().int().nonnegative() }).parse(await r.json());
  };
  const create = async (owner: number, ttlSeconds = 900) => {
    const client = clients[owner]!;
    const c = await client.createAgentConnection({ profile, providers: ["llm"], client: `retention-${phase}-${crypto.randomUUID()}`,
      audience: "same-host", ttlSeconds, allowFallback: false, deploymentPolicy: "existing-only", expectedCatalogRevision: catalog.catalogRevision },
    { idempotencyKey: crypto.randomUUID(), waitSeconds: 1 });
    owned.set(c.id, client);
    await client.waitForAgentConnection(c, { timeoutMs: 30_000 });
    const claim = await client.claimAgentConnection(c.id);
    const provider = claim.providers.find((p): p is Provider => p.name === "llm" && p.apiStyle === "openai");
    check(!!provider, "provider_missing");
    return { id: c.id, provider: provider! };
  };
  const release = async (id: string) => { await owned.get(id)!.releaseAgentConnection(id); owned.delete(id); };
  const system = (branch: string, lines = 160) => `Synthetic ${phase} ${branch} ${fixture}. Follow the user instruction.\n`
    + `The independent ${branch} triangle is on the empty test shelf.\n`.repeat(lines);
  const request = async (p: Provider, label: string, prefix: string, maxTokens = 16, user = "Reply only OK.", cacheKey?: string, onFirstToken?: () => void) => {
    const start = performance.now();
    const r = await fetch(`${p.baseUrl}/chat/completions`, { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${p.credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: p.model, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens,
        ...(cacheKey !== undefined ? { prompt_cache_key: cacheKey } : {}),
        temperature: 0, chat_template_kwargs: { enable_thinking: false },
        messages: [{ role: "system", content: prefix }, { role: "user", content: user }] }), signal: AbortSignal.timeout(120_000) });
    const sample = await consumeRetentionStream(r, start, onFirstToken);
    emit({ label, ...sample }); return sample;
  };
  const slots = async () => {
    const r = await fetch("http://127.0.0.1:58109/slots", { signal: AbortSignal.timeout(3000) });
    check(r.ok, "slots_failed");
    return z.array(z.object({ id: z.number().int(), is_processing: z.boolean() })).parse(await r.json());
  };
  let failure: unknown;
  try {
    if (phase === "restore") {
      const c = await create(0), prefix = system("main", 1100), key = `restore-${fixture}`;
      const first = await request(c.provider, "restore-main-first", prefix, 16, "Reply only OK.", key);
      // More namespaces than execution slots force the main state out of its
      // original KV stream. The working set still fits the owner's RAM budget.
      for (let i = 0; i < 6; i++) await request(c.provider, `restore-branch-${i}`, system(`branch${i}`, 160), 16, "Reply only OK.", `${key}-${i}`);
      const before = await stats();
      const after = await request(c.provider, "restore-main-from-ram", prefix, 16, "Reply only OK.", key);
      const restored = await stats();
      if (!baseline) {
        check(after.cache_n >= first.prompt_tokens - 32, "ram_restore_reuse_failed");
        check(!!before && !!restored && restored.loads > before.loads, "ram_restore_not_observed");
      }
      emit({ label: "restore-result", before, after: restored, retained: after.cache_n >= first.prompt_tokens - 32 });
    } else if (phase === "exchange") {
      const c = await create(0), prefix = system("exchange", 160), key = `exchange-${fixture}`;
      const before = await request(c.provider, "exchange-before", prefix, 16, "Reply only OK.", key);
      const healthResponse = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      check(healthResponse.ok, "exchange_health_failed");
      const health = z.object({ bootEpoch: z.string().min(1) }).parse(await healthResponse.json());
      const flag = resolve(dirname(process.env.LARM_TEST_ENV!), `exchange-${baseline ? "baseline" : "after"}-ready.json`);
      check(!flag.startsWith(resolve(import.meta.dir, "../../..") + "/"), "exchange_flag_must_be_private");
      await writeFile(flag, JSON.stringify({ ready: true, oldBootEpoch: health.bootEpoch }), { flag: "wx", mode: 0o600 });
      let exchanged = false;
      for (let i = 0; i < 900; i++) {
        try {
          const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
          if (r.ok) { const h = await r.json() as { bootEpoch?: string; ready?: boolean };
            if (h.ready && h.bootEpoch && h.bootEpoch !== health.bootEpoch) { exchanged = true; break; }
          } else await r.body?.cancel();
        } catch { /* The explicitly authorized test process replacement can be temporarily unavailable. */ }
        await Bun.sleep(200);
      }
      check(exchanged, "exchange_not_observed");
      const revoked = await fetch(`${c.provider.baseUrl}/chat/completions`, { method: "POST",
        headers: { authorization: `Bearer ${c.provider.credential.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: c.provider.model, messages: [{ role: "user", content: "Synthetic obsolete binding." }] }) });
      await revoked.body?.cancel(); check(revoked.status === 401, "exchange_old_credential_accepted");
      owned.delete(c.id); // Its owning daemon is gone; never send its ID to the replacement daemon.
      clients[0] = new LarmClient({ baseUrl, apiToken: secret.apiToken, timeoutMs: 120_000 });
      const next = await create(0);
      const cold = await request(next.provider, "exchange-after-cold", prefix, 16, "Reply only OK.", key);
      const warm = await request(next.provider, "exchange-after-repeat", prefix, 16, "Reply only OK.", key);
      check(cold.cache_n === 0 && warm.cache_n >= before.prompt_tokens - 32, "exchange_cache_generation_failed");
      emit({ label: "exchange-result", oldCredentialStatus: revoked.status, oldCacheDropped: cold.cache_n === 0, newGenerationReusable: true });
    } else if (phase === "audio") {
      stage = "audio-token";
      const audioToken = z.string().min(1).parse(process.env.LARM_AUDIO_API_TOKEN);
      const managementToken = process.env.LARM_AUDIO_MANAGEMENT_TOKEN;
      const audioClient = new LarmClient({ baseUrl: "http://127.0.0.1:9810", apiToken: audioToken, managementToken, timeoutMs: 120_000 });
      stage = "audio-catalog";
      const audioCatalog = await audioClient.listAgentProfilesV3();
      const audioProfile = agentProfileSelectorIdSchema.parse(audioCatalog.defaultAgentProfile);
      stage = "audio-create";
      const connection = await audioClient.createAgentConnection({ profile: audioProfile, providers: ["asr", "tts"],
        client: `retention-audio-${crypto.randomUUID()}`, audience: "same-host", ttlSeconds: 900, allowFallback: false,
        deploymentPolicy: "existing-only", expectedCatalogRevision: audioCatalog.catalogRevision }, { idempotencyKey: crypto.randomUUID(), waitSeconds: 1 });
      owned.set(connection.id, audioClient);
      stage = "audio-ready";
      await audioClient.waitForAgentConnection(connection, { timeoutMs: 120_000 });
      stage = "audio-claim";
      const audioClaim = await audioClient.claimAgentConnection(connection.id);
      const asr = audioClaim.providers.find((p): p is Provider => p.apiStyle === "openai" && p.protocol === "openai.audio-transcriptions.v1");
      const tts = audioClaim.providers.find((p): p is Provider => p.apiStyle === "openai" && p.protocol === "openai.audio-speech.v1");
      check(!!asr && !!tts, "audio_provider_missing");
      const speech = async (label: string) => {
        const start = performance.now();
        const r = await fetch(`${tts!.baseUrl}/audio/speech`, { method: "POST", redirect: "error",
          headers: { authorization: `Bearer ${tts!.credential.token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: tts!.model, input: "三角形は青色です。", voice: "1", response_format: "wav" }), signal: AbortSignal.timeout(30_000) });
        const bytes = new Uint8Array(await r.arrayBuffer());
        check(r.ok && bytes.length > 44 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF", "tts_invalid_audio");
        const total_ms = performance.now() - start; emit({ label, total_ms, audio_bytes: bytes.length });
        return { bytes, total_ms };
      };
      stage = "audio-fixture";
      const fixtureAudio = (await speech("tts-fixture")).bytes;
      const transcribe = async (label: string) => {
        const start = performance.now(), form = new FormData(); form.set("model", asr!.model); form.set("response_format", "json");
        form.set("file", new Blob([fixtureAudio], { type: "audio/wav" }), "synthetic.wav");
        const r = await fetch(`${asr!.baseUrl}/audio/transcriptions`, { method: "POST", redirect: "error", body: form,
          headers: { authorization: `Bearer ${asr!.credential.token}` }, signal: AbortSignal.timeout(30_000) });
        check(r.ok, "asr_http_failure"); const body = await r.json() as { text?: unknown };
        check(typeof body.text === "string" && body.text.includes("三角形"), "asr_synthetic_text_mismatch");
        const total_ms = performance.now() - start; emit({ label, total_ms, synthetic_text_valid: true }); return total_ms;
      };
      await transcribe("asr-fixture");
      const connections = [await create(0), await create(0), await create(1), await create(1)];
      // Warm all four lanes with exactly the same inputs used in the timed rounds.
      for (let lane = 0; lane < 4; lane++) await request(connections[lane]!.provider, `audio-warm-${lane}`, system(`lane${lane}`));
      const audioTts: number[] = [], audioAsr: number[] = [], ttft: number[] = [], wall: number[] = [];
      for (let round = 0; round < 20; round++) await Promise.all([
        ...connections.map(async (c, lane) => { const s = await request(c.provider, `audio-llm-${round}-${lane}`, system(`lane${lane}`)); ttft.push(s.first_token_ms); wall.push(s.total_ms); }),
        speech(`audio-tts-${round}`).then(s => { audioTts.push(s.total_ms); }),
        transcribe(`audio-asr-${round}`).then(ms => { audioAsr.push(ms); }),
      ]);
      const q = (x: number[], percentile: number) => [...x].sort((a, b) => a - b)[Math.ceil(x.length * percentile) - 1]!;
      emit({ label: "audio-concurrent-latency", llm_samples: ttft.length, audio_samples: audioTts.length,
        ttft_p50_ms: q(ttft, .5), ttft_p95_ms: q(ttft, .95), llm_total_p50_ms: q(wall, .5), llm_total_p95_ms: q(wall, .95),
        tts_p50_ms: q(audioTts, .5), tts_p95_ms: q(audioTts, .95), asr_p50_ms: q(audioAsr, .5), asr_p95_ms: q(audioAsr, .95) });
      let firstTokens = 0, releaseAudio!: () => void;
      const allGenerating = new Promise<void>(resolve => { releaseAudio = resolve; });
      const generating = Promise.all(connections.map((c, lane) => request(c.provider, `audio-four-generating-${lane}`, system(`lane${lane}`), 128,
        "Write at least one hundred numbered synthetic geometric descriptions. Continue until the output limit.", undefined,
        () => { if (++firstTokens === 4) releaseAudio(); })));
      await Promise.all([generating, (async () => {
        await allGenerating;
        const active = (await slots()).filter(s => s.is_processing).length;
        check(active === 4, "audio_four_generating_not_observed");
        await Promise.all([speech("tts-during-four-generating"), transcribe("asr-during-four-generating")]);
        const stillActive = (await slots()).filter(s => s.is_processing).length;
        check(stillActive === 4, "audio_did_not_finish_during_four_generating");
        emit({ label: "audio-four-generating-overlap", firstTokenLanes: firstTokens, activeBeforeAudio: active, activeAfterAudio: stillActive });
      })()]);
    } else if (phase === "mixed") {
      const connections = [await create(0), await create(0), await create(1), await create(1)];
      const main = connections[0]!.provider;
      const a = await request(main, "mixed-main-first", system("main", 950));
      // Same bytes on a different authenticated consumer must not inherit its cache scope.
      const other = await request(connections[2]!.provider, "other-owner-identical-first", system("main", 950));
      if (!baseline) check(other.cache_n === 0, "cross_owner_cache_scope");
      for (let i = 0; i < 6; i++) await request(connections[(i % 3) + 1]!.provider, `mixed-interleave-${i}`, system(`aux${i}`));
      const b = await request(main, "mixed-main-restored", system("main", 950));
      if (!baseline) check(b.cache_n >= a.prompt_tokens - 32, "mixed_retention_failed");
      // Require all four native slots to generate concurrently, rather than just starting four HTTP calls.
      let peakActive = 0; let sampling = true; let slotSamplesMissed = 0;
      const monitor = (async () => { while (sampling) {
        // /slots also uses the native queue. A busy queue can delay observations;
        // count missed samples without creating an unhandled rejection.
        try { peakActive = Math.max(peakActive, (await slots()).filter(s => s.is_processing).length); }
        catch { slotSamplesMissed++; }
        await Bun.sleep(25);
      } })();
      try {
        await Promise.all(connections.map((c, i) => request(c.provider, `four-active-${i}`, system(`parallel${i}`), 128,
          "Write a numbered list of at least one hundred synthetic geometric objects. Continue until the output limit.")));
      } finally { sampling = false; await monitor; }
      check(peakActive === 4, "four_slots_not_observed");
      emit({ label: "four-slot-concurrency", peakActive, slotSamplesMissed });
      // Twenty steady-state samples per lane allow comparable p50/p95, without claiming population estimates.
      const ttft: number[][] = [[], [], [], []], wall: number[][] = [[], [], [], []];
      for (let round = 0; round < 20; round++) await Promise.all(connections.map(async (c, lane) => {
        const sample = await request(c.provider, `steady-${round}-${lane}`, system(`steady${lane}`));
        ttft[lane]!.push(sample.first_token_ms); wall[lane]!.push(sample.total_ms);
      }));
      const q = (x: number[], percentile: number) => [...x].sort((a, b) => a - b)[Math.ceil(x.length * percentile) - 1]!;
      emit({ label: "steady-latency", samplesPerLane: 20, lanes: ttft.map((x, lane) => ({ lane,
        ttft_p50_ms: q(x, .5), ttft_p95_ms: q(x, .95), total_p50_ms: q(wall[lane]!, .5), total_p95_ms: q(wall[lane]!, .95) })) });
    } else if (phase === "budget") {
      const c = await create(0), peer = await create(1);
      const main = await request(c.provider, "budget-oldest", system("oldest", 950));
      const peerMain = await request(peer.provider, "budget-peer", system("peer", 950));
      const before = await stats();
      // Exceed one owner's configured 16-entry/4GiB bound. Entries share neither full prompt nor prefix.
      for (let i = 0; i < 22; i++) {
        await request(c.provider, `budget-fill-${i}`, system(`budget${i}`, 160));
        const s = await stats();
        if (s) {
          check(s.bytes <= 8 * 1024 ** 3 && s.metadataBytes <= 64 * 1024 ** 2 && s.entries <= 64, "global_budget_exceeded");
          emit({ label: `budget-stats-${i}`, ...s });
        }
      }
      const recent = await request(c.provider, "budget-recent-replay", system("budget21", 160));
      const oldest = await request(c.provider, "budget-oldest-replay", system("oldest", 950));
      const peerAfter = await request(peer.provider, "budget-peer-replay", system("peer", 950));
      const after = await stats();
      if (!baseline) {
        check(recent.cache_n >= recent.prompt_tokens - 32, "recent_cache_not_retained");
        check(oldest.cache_n < main.prompt_tokens - 32, "over_budget_oldest_not_evicted");
        check(peerAfter.cache_n >= peerMain.prompt_tokens - 32, "peer_fairness_failed");
        check(!!before && !!after && after.evictions > before.evictions, "budget_eviction_not_observed");
      }
      emit({ label: "budget-result", before, after, coldAfterQuota: oldest.cache_n < main.prompt_tokens - 32 });
    } else if (phase === "keys") {
      if (!baseline) {
        const wrongKey = (privateEnv.LARM_PROMPT_CACHE_KEY[0] === "0" ? "1" : "0") + privateEnv.LARM_PROMPT_CACHE_KEY.slice(1);
        for (const [kind, key, expected] of [["correct", privateEnv.LARM_PROMPT_CACHE_KEY, true],
          ["incorrect", wrongKey, false], ["absent", undefined, false]] as const) {
          const response = await fetch("http://127.0.0.1:58109/props", {
            headers: key ? { "x-larm-cache-key": key } : {}, signal: AbortSignal.timeout(3000) });
          check(response.ok, "capability_auth_http_failed");
          const props = await response.json() as { larm_prompt_cache?: { authenticated?: boolean } };
          check(props.larm_prompt_cache?.authenticated === expected, "capability_auth_incorrect");
          emit({ label: "capability-auth", kind, matchedExpectation: true });
        }
      }
      const a = await create(0), b = await create(0), peer = await create(1);
      const key = `synthetic-${fixture}`, prefix = system("keyed", 1100);
      const first = await request(a.provider, "key-first-sse", prefix, 16, "Reply only OK.", key);
      const second = await request(b.provider, "key-other-connection-sse", prefix, 16, "Reply only OK.", key);
      const start = performance.now();
      const r = await fetch(`${b.provider.baseUrl}/chat/completions`, { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${b.provider.credential.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: b.provider.model, prompt_cache_key: key, stream: false, max_tokens: 16, temperature: 0,
          chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "system", content: prefix }, { role: "user", content: "Reply only OK." }] }),
        signal: AbortSignal.timeout(120_000) });
      check(r.ok, "key_json_failed"); const json = cacheSample(await r.json());
      emit({ label: "key-json", ...json, first_token_ms: null, total_ms: performance.now() - start });
      const changed = await request(b.provider, "key-changed-cold", prefix, 16, "Reply only OK.", key + "-changed");
      const resumed = await request(b.provider, "key-original-restored", prefix, 16, "Reply only OK.", key);
      const isolated = await request(peer.provider, "key-other-owner-cold", prefix, 16, "Reply only OK.", key);
      // The grammar permits both markers, so it cannot hide a wrong restored
      // model state. Validate semantic output in memory, never in evidence logs.
      for (const [provider, marker] of [[a.provider, "A"], [peer.provider, "B"], [a.provider, "A"]] as const) {
        const started = performance.now();
        const response = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", redirect: "error",
          headers: { authorization: `Bearer ${provider.credential.token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: provider.model, prompt_cache_key: key + "-semantic", max_tokens: 96, temperature: 0,
            chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: { name: "synthetic",
              strict: true, schema: { type: "object", properties: { marker: { type: "string", enum: ["A", "B"] },
                total: { type: "integer", enum: [18] } }, required: ["marker", "total"], additionalProperties: false } } },
            messages: [{ role: "system", content: `The required marker is ${marker}.\n${system("semantic", 160)}` },
              { role: "user", content: "Return the required marker and the sum of 7 and 11 as JSON." }] }), signal: AbortSignal.timeout(120_000) });
        check(response.ok, "semantic_http_failed");
        const body = await response.json() as { choices: { message: { content: string } }[] };
        const result = JSON.parse(body.choices[0]!.message.content);
        check(result.marker === marker && result.total === 18, "restored_output_incorrect");
        emit({ label: "semantic-restoration", output_valid: true, ...cacheSample(body), first_token_ms: null, total_ms: performance.now() - started });
      }
      await release(a.id); await release(b.id);
      const replacement = await create(0);
      const replaced = await request(replacement.provider, "key-after-connection-replacement", prefix, 16, "Reply only OK.", key);
      if (!baseline) {
        for (const sample of [second, json, resumed, replaced]) check(sample.cache_n >= first.prompt_tokens - 32, "key_reuse_failed");
        check(changed.cache_n === 0 && isolated.cache_n === 0, "key_isolation_failed");
      }
      emit({ label: "key-result", reusedAcrossConnections: second.cache_n >= first.prompt_tokens - 32,
        reusedAfterReplacement: replaced.cache_n >= first.prompt_tokens - 32, changedKeyCold: changed.cache_n === 0, otherOwnerCold: isolated.cache_n === 0 });
    } else {
      const main = await create(0), cancelling = await create(1);
      const completed = await request(main.provider, "cancel-protected-main", system("protected", 950));
      const abort = new AbortController();
      const r = await fetch(`${cancelling.provider.baseUrl}/chat/completions`, { method: "POST", redirect: "error",
        headers: { authorization: `Bearer ${cancelling.provider.credential.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: cancelling.provider.model, stream: true, max_tokens: 1024,
          chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: `Synthetic cancel ${fixture}. List one thousand geometric objects with descriptions.` }] }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
      check(r.ok && !!r.body, "cancel_request_failed");
      const reader = r.body!.getReader();
      try { check(!(await reader.read()).done, "cancel_stream_empty"); abort.abort(); }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      for (let i = 0; i < 100 && (await slots()).some(s => s.is_processing); i++) await Bun.sleep(50);
      check(!(await slots()).some(s => s.is_processing), "cancel_did_not_release_slot");
      const after = await request(main.provider, "cancel-main-replay", system("protected", 950));
      if (!baseline) check(after.cache_n >= completed.prompt_tokens - 32, "cancel_destroyed_other_scope");
      await release(cancelling.id);
      const beforeRelease = await stats();
      await release(main.id); await Bun.sleep(250);
      const afterRelease = await stats();
      const revoked = await fetch(`${main.provider.baseUrl}/chat/completions`, { method: "POST",
        headers: { authorization: `Bearer ${main.provider.credential.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: main.provider.model, messages: [{ role: "user", content: "Synthetic revoked request." }] }) });
      await revoked.body?.cancel(); check(revoked.status === 401, "released_credential_accepted");
      // Short Connection lease tests actual expiry hooks without waiting for the cache's 300-second idle TTL.
      const expiring = await create(0, 5);
      await request(expiring.provider, "expiring-first", system("expiry", 50));
      await Bun.sleep(6000);
      const expired = await fetch(`${expiring.provider.baseUrl}/chat/completions`, { method: "POST",
        headers: { authorization: `Bearer ${expiring.provider.credential.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: expiring.provider.model, messages: [{ role: "user", content: "Synthetic expired request." }] }) });
      await expired.body?.cancel(); check(expired.status === 401, "expired_credential_accepted");
      emit({ label: "lifecycle-result", releasedStatus: revoked.status, expiredStatus: expired.status, beforeRelease, afterRelease, afterExpiry: await stats() });
    }
    emit({ label: "phase-complete", phase, baseline, stats: await stats() });
  } catch (error) { failure = error; }
  const results = await Promise.allSettled([...owned].map(([id, client]) => client.releaseAgentConnection(id)));
  emit({ label: "cleanup", testConnections: owned.size, failed: results.filter(r => r.status === "rejected").length });
  if (failure) throw failure;
  check(results.every(r => r.status === "fulfilled"), "cleanup_failed");
}

if (import.meta.main) await main().catch((error: unknown) => {
  emit({ label: "failure", stage, errorClass: error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : "suppressed",
    reason: error instanceof Error && /^retention_[a-z_]+$/.test(error.message) ? error.message : "retention_unclassified_failure",
    ...(error instanceof LarmApiError ? { apiStatus: error.status, apiCode: /^[a-z_]{1,64}$/.test(error.code) ? error.code : "suppressed" } : {}) });
  process.exitCode = 1;
});
