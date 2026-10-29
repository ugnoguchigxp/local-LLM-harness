import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { loadRegistry, loadAgentConnectionCatalogForRegistry, type ProviderInstance } from "../../../packages/core/src/index";
import type { RuntimeBackend } from "../../../packages/backends/src/types";
import { Observer } from "../../../apps/daemon/src/observer";
import { ControlPlane } from "../../../apps/daemon/src/controller";
import { createApp } from "../../../apps/daemon/src/app";
import { LarmClient } from "../../../packages/client/src/index";
import { runLfm25ReasoningSmoke } from "./smoke-lfm25-reasoning";

/** Owns one isolated engine and HTTP listener. Never controls production Providers. */
export async function verifyLfmInputCache(profileSelector: string, evidenceDir: string, requestTimeoutMs = 180_000) {
  const configDir = resolve(import.meta.dir, "../../../config/local-node");
  const registry = loadRegistry(configDir);
  const catalog = loadAgentConnectionCatalogForRegistry(configDir, registry);
  const selector = catalog.profileSelectors.find(s => s.id === profileSelector);
  const profile = catalog.profiles.find(p => p.id === selector?.agentProfile);
  const provider = profile?.providers.find(p => p.name === "llm");
  const route = registry.routes.find(r => r.id === provider?.route);
  const runtime = registry.runtimes.find(r => r.id === route?.candidates[0]?.runtime);
  if (!profile || !provider || !runtime?.promptRetention || runtime.backend !== "llama-swap") throw new Error("profile must resolve to a cache-enabled llama runtime");
  if (Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) * 1024 < (runtime.resources.estimatedMemoryGB + 17) * 1024 ** 3) {
    throw new Error("insufficient available memory for isolated verification");
  }
  mkdirSync(evidenceDir, { recursive: false, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  const apiToken = randomBytes(32).toString("hex"), peerToken = randomBytes(32).toString("hex");
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserve.port!;
  await reserve.stop(true);
  const configured = parse(readFileSync(resolve(configDir, "llama-swap.yaml"), "utf8"));
  const launch = configured.models[runtime.deployment.modelId].cmd.trim().split(/\s+/) as string[];
  // Bypass only the production credential launcher; use an independent in-memory key.
  if (launch[0] !== "/usr/bin/python3" || !launch[1]?.endsWith("/launch-prompt-retention.py")) throw new Error("unsupported production launcher");
  const command = launch.slice(3).map(arg => arg.replace("${PORT}", String(port)));
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env: { ...process.env,
    HIP_VISIBLE_DEVICES: "-1", ROCR_VISIBLE_DEVICES: "-1", LARM_PROMPT_CACHE_KEY: key,
    LARM_PROMPT_CACHE_POLICY: JSON.stringify(runtime.promptRetention) } });
  const log = Bun.file(resolve(evidenceDir, "engine.log")).writer();
  const drain = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) log.write(chunk); };
  const draining = [drain(child.stdout), drain(child.stderr)];
  const origin = `http://127.0.0.1:${port}`;
  const result: { ok: boolean; profile: string; command: string[]; cases: Record<string, unknown>[]; [key: string]: unknown } = {
    ok: false, profile: profileSelector, command, cases: [], startedAt: new Date().toISOString(),
  };
  const save = () => writeFileSync(resolve(evidenceDir, "results.json"), JSON.stringify(result, null, 2) + "\n");
  let server: ReturnType<typeof Bun.serve> | undefined, control: ControlPlane | undefined;
  let ticking: ReturnType<typeof setInterval> | undefined;
  const memoryGuard = setInterval(() => {
    if (Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) < 8 * 1024 ** 2) child.kill("SIGTERM");
  }, 1000);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 240; attempt++) {
      if (child.exitCode !== null) throw new Error(`isolated engine exited ${child.exitCode}`);
      try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) })).ok) { ready = true; break; } } catch { /* startup */ }
      await Bun.sleep(1000);
    }
    if (!ready) throw new Error("isolated engine startup timed out");
    const props = await (await fetch(`${origin}/props`, { headers: { "x-larm-cache-key": key } })).json() as Record<string, any>;
    if (props.larm_prompt_cache?.enabled !== true || props.larm_prompt_cache?.authenticated !== true) throw new Error("private cache protocol unavailable");
    result.props = { context: props.default_generation_settings?.n_ctx, slots: props.total_slots, cache: props.larm_prompt_cache };
    runtime.deployment.endpoint = runtime.deployment.backendEndpoint = origin;
    registry.runtimes = [runtime]; registry.routes = [route!];
    profile.providers = [provider]; catalog.profiles = [profile]; catalog.profileSelectors = [selector!]; catalog.defaultAgentProfile = profile.id;
    const health = () => ({ runtimeId: runtime.id, service: "Running" as const, listening: true, healthOk: true, busy: false });
    const backend: RuntimeBackend = { list: async () => [health()], health: async () => health(), ensure: async () => health(), stop: async () => {},
      ensureInstance: async revision => ({ id: "pinst_isolated_cache", runtimeId: runtime.id, revision: revision.revision, generation: 1,
        node: runtime.node, endpoint: origin, backendEndpoint: origin, status: "HOT", createdAt: new Date().toISOString() } satisfies ProviderInstance) };
    const observer = new Observer(registry, backend); await observer.tick();
    control = new ControlPlane(registry, backend, observer, { idleTtlMs: 60_000 });
    // Register the already-running test engine's generation, as the daemon's
    // reconciliation loop does. Invalidation must never target an untracked PID.
    await control.reconcileProviderInstances();
    let activeForwards = 0, peakForwards = 0, invalidationRequests = 0;
    const app = createApp({ registry, control, getState: () => observer.getState(), agentConnectionCatalog: catalog,
      identity: { version: "isolated-cache", releaseCommit: "a".repeat(40), configRevision: "b".repeat(64), bootEpoch: control.getBootEpoch() },
      getConfigRevision: () => "b".repeat(64), apiToken, protectedConsumerToken: peerToken, promptRetentionKey: key,
      connectionSigningKey: randomBytes(32), gatewayTimeoutMs: requestTimeoutMs,
      gatewayFetch: async (url, init) => {
        if (String(url).endsWith("/larm/cache/invalidate")) invalidationRequests++;
        if (!String(url).endsWith("/v1/chat/completions")) return fetch(url, init);
        activeForwards++; peakForwards = Math.max(peakForwards, activeForwards);
        try { return await fetch(url, init); } finally { activeForwards--; }
      } });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, fetch: app.fetch });
    const api = `http://127.0.0.1:${server.port}`;
    catalog.audiences.forEach(a => { a.baseUrl = `${api}/v1`; });
    ticking = setInterval(() => { void observer.tick(); }, 1000);
    const stats = async () => (await (await fetch(`${origin}/larm/cache/invalidate`, { method: "POST",
      headers: { "x-larm-cache-key": key, "content-type": "application/json" }, body: JSON.stringify({ action: "inspect" }) })).json()) as Record<string, number>;
    const speculation = async () => {
      const metrics = await (await fetch(`${origin}/metrics`)).text();
      const count = (name: string) => Number(new RegExp(`^llamacpp:spec_decode_num_${name}_total ([0-9.eE+-]+)$`, "m").exec(metrics)?.[1] ?? 0);
      return { draftedTokens: count("draft_tokens"), acceptedTokens: count("accepted_tokens"), drafts: count("drafts") };
    };
    const schema = { type: "json_schema", json_schema: { name: "cache_fixture", strict: true, schema: { type: "object",
      properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } } };
    const context = Array.from({ length: 220 }, (_, i) => `record ${i}: The stable synthetic cache fixture contains no private information.`).join("\n");
    type Message = { role: string; content: string };
    const messages = (value: number): Message[] => [{ role: "system", content: context }, { role: "user", content: `Return JSON with value equal to ${value}.` }];
    async function chat(label: string, cacheKey?: string, value = 17, token = apiToken, extra: Record<string, unknown> = {}, input = messages(value)) {
      const started = performance.now();
      const response = await fetch(`${api}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: provider!.publicModel, messages: input, max_tokens: 1536, reasoning_effort: "medium", response_format: schema,
          stream: true, stream_options: { include_usage: true }, ...(cacheKey ? { prompt_cache_key: cacheKey } : {}), ...extra }), signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!response.ok || !response.body) throw new Error(`${label}: HTTP ${response.status} ${await response.text()}`);
      let pending = "", content = "", reasoning = "", done = false, finish: string | null = null;
      let usage: any, timings: any, firstReasonMs: number | undefined, firstContentMs: number | undefined;
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        for (let at; (at = pending.indexOf("\n")) >= 0;) {
          const line = pending.slice(0, at).trim(); pending = pending.slice(at + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim(); if (data === "[DONE]") { done = true; continue; }
          const item = JSON.parse(data); if (item.error) throw new Error(`${label}: ${JSON.stringify(item.error)}`);
          const choice = item.choices?.[0], delta = choice?.delta;
          if (delta?.reasoning_content) { firstReasonMs ??= performance.now() - started; reasoning += delta.reasoning_content; }
          if (delta?.content) { if (delta.content.trim()) firstContentMs ??= performance.now() - started; content += delta.content; }
          finish = choice?.finish_reason ?? finish; usage = item.usage ?? usage; timings = item.timings ?? timings;
        }
      }
      if (!done || finish !== "stop" || !reasoning.trim() || JSON.parse(content).value !== value) throw new Error(`${label}: incomplete or incorrect reasoned JSON`);
      const row = { label, value, content, finish, firstReasonMs, firstContentMs, totalMs: performance.now() - started,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? timings?.cache_n, promptTokens: usage?.prompt_tokens, timings, usage };
      result.cases.push(row); save(); console.log(JSON.stringify(row)); return row;
    }
    const requireHit = (r: Awaited<ReturnType<typeof chat>>) => { if (!(r.cachedTokens > 0)) throw new Error(`${r.label}: cache reuse not observed`); };
    const requireCold = (r: Awaited<ReturnType<typeof chat>>) => { if (r.cachedTokens !== 0) throw new Error(`${r.label}: unexpected cross-scope reuse`); };
    requireCold(await chat("cache-disabled", "thread-A", 17, apiToken, { cache_prompt: false }));
    requireCold(await chat("cold", "thread-A"));
    requireHit(await chat("repeat", "thread-A"));
    requireHit(await chat("append", "thread-A", 29, apiToken, {}, [...messages(17), { role: "assistant", content: '{"value":17}' }, { role: "user", content: "Now return value 29." }]));
    const before = await stats();
    // Occupy every hot slot without spending the retained conversation's five
    // minute idle lifetime on unrelated large prefills on slower engines.
    const displacementInput = [{ role: "user", content: "Return JSON with value equal to 17." }];
    for (const key of ["B", "C", "D", "E", "F"]) {
      requireCold(await chat(`other-${key}`, `thread-${key}`, 17, apiToken, {}, displacementInput));
    }
    const mtpBeforeRestore = props.larm_prompt_cache.speculative ? await speculation() : undefined;
    requireHit(await chat("restore-A", "thread-A"));
    if (mtpBeforeRestore) {
      const restoredMtp = await speculation();
      result.mtpRestoration = { before: mtpBeforeRestore, after: restoredMtp };
      if (restoredMtp.acceptedTokens <= mtpBeforeRestore.acceptedTokens) throw new Error("restored conversation did not accept MTP drafts");
    }
    const after = await stats(); result.retention = { before, after };
    if (!(after.loads! > before.loads!)) throw new Error("RAM restoration not exercised");
    requireCold(await chat("other-owner-same-key", "thread-A", 17, peerToken));
    activeForwards = peakForwards = 0;
    await Promise.all([31, 32, 33, 34].map(value => chat(`parallel-${value}`, `parallel-${value}`, value)));
    result.peakConcurrentForwards = peakForwards;
    if (peakForwards < 4) throw new Error("four concurrent gateway forwards not exercised");
    const client = new LarmClient({ baseUrl: api, apiToken, timeoutMs: 60_000 });
    const publicCatalog = await client.listAgentProfilesV3(profileSelector as Parameters<typeof client.listAgentProfilesV3>[0]);
    const connection = await client.createAgentConnection({ profile: profileSelector as Parameters<typeof client.createAgentConnection>[0]["profile"], expectedCatalogRevision: publicCatalog.catalogRevision,
      audience: catalog.audiences[0]!.id, providers: ["llm"], ttlSeconds: 300, allowFallback: false, deploymentPolicy: "existing-only" });
    let scopedToken: string | undefined;
    try {
      await client.waitForAgentConnection(connection, { timeoutMs: 60_000 });
      const claimed = await client.claimAgentConnection(connection.id);
      const claim = claimed.providers.find(p => p.name === "llm" && p.apiStyle === "openai");
      if (!claim) throw new Error("missing scoped credential");
      scopedToken = claim.credential.token;
      requireCold(await chat("connection-cold", undefined, 17, claim.credential.token));
      requireHit(await chat("connection-repeat", undefined, 17, claim.credential.token));
    } finally { await client.releaseAgentConnection(connection.id); }
    for (let i = 0; i < 40 && invalidationRequests === 0; i++) await Bun.sleep(25);
    if (invalidationRequests === 0) throw new Error("connection release did not invalidate the engine cache");
    const released = await fetch(`${api}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${scopedToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: provider.publicModel, messages: messages(17), max_tokens: 16 }) });
    if (released.ok) throw new Error("released credential was accepted");
    await released.arrayBuffer();
    result.invalidation = { requests: invalidationRequests, releasedCredentialStatus: released.status };
    result.reasoning = await runLfm25ReasoningSmoke({ baseUrl: api, apiToken, model: provider.publicModel });
    result.speculation = await speculation();
    result.ok = true; save(); return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error); save(); throw error;
  } finally {
    clearInterval(memoryGuard); clearInterval(ticking);
    await server?.stop(true); control?.beginDrain(); await control?.flush();
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited; await Promise.allSettled(draining); await log.end(); save();
  }
}

if (import.meta.main) {
  const [profile, evidence] = process.argv.slice(2);
  if (!profile || !evidence) throw new Error("usage: verify-lfm-input-cache.ts PROFILE NEW_EVIDENCE_DIRECTORY");
  console.log(JSON.stringify(await verifyLfmInputCache(profile, resolve(evidence)), null, 2));
}
