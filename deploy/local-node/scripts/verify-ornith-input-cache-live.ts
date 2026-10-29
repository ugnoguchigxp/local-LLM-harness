import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { agentProfileSelectorIdSchema } from "../../../packages/core/src/index";
import { LarmClient } from "../../../packages/client/src/index";

// Exercise the resolved, running Provider. Do not start a second model or clear
// another consumer's cache. All prompts and cache keys below are synthetic.
const [output, profileArgument = "ornith1.5Strix"] = Bun.argv.slice(2);
const profile = agentProfileSelectorIdSchema.parse(profileArgument);
if (!output || !process.env.LARM_PROMPT_RETENTION_ENV_FILE) {
  throw new Error("usage: LARM_PROMPT_RETENTION_ENV_FILE=PRIVATE_ENV bun verify-ornith-input-cache-live.ts EVIDENCE_DIR [PROFILE]");
}
const directory = resolve(output);
mkdirSync(directory, { recursive: true });
const env = Object.fromEntries(readFileSync("/etc/larm/larm.env", "utf8").split("\n")
  .filter(line => line && !line.startsWith("#") && line.includes("="))
  .map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, "")]; }));
const privateEnv = JSON.parse(readFileSync(process.env.LARM_PROMPT_RETENTION_ENV_FILE, "utf8"));
// Match the running release's client schema even when the source workspace is
// ahead of the deployed API. A test must follow the actual resolved service.
const clientModule = "/srv/ai/apps/larm-current/packages/client/src/index.ts";
const { LarmClient: LiveLarmClient } = await import(clientModule) as { LarmClient: typeof LarmClient };
const client = new LiveLarmClient({ baseUrl: "http://127.0.0.1:9810", apiToken: env.LARM_API_TOKEN, timeoutMs: 300000 });
const runKey = `ornith-cache-e2e-${Date.now()}`;
const result: any = { ok: false, profile, cases: [] };
const save = () => writeFileSync(resolve(directory, "results.json"), JSON.stringify(result, null, 2) + "\n");
const requireThat = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
let connection: Awaited<ReturnType<LarmClient["createAgentConnection"]>> | undefined;
let provider: any;
async function connect() {
  const catalog = await client.listAgentProfilesV3(profile);
  connection = await client.createAgentConnection({ profile, expectedCatalogRevision: catalog.catalogRevision,
    audience: "same-host", providers: ["llm"], ttlSeconds: 1800, allowFallback: false, deploymentPolicy: "existing-only" });
  await client.waitForAgentConnection(connection, { timeoutMs: 300000 });
  const claimed = await client.claimAgentConnection(connection.id);
  provider = claimed.providers.find(p => p.name === "llm" && p.apiStyle === "openai");
  requireThat(provider, "missing OpenAI LLM claim");
  requireThat(provider.model === "ornith1.5-strix", "requested profile does not resolve to the restored Ornith; select the configured conversation profile");
  result.model = provider.model;
  result.catalogRevision = catalog.catalogRevision;
}
async function stats() {
  const response = await fetch("http://127.0.0.1:8083/upstream/ornith15-strix-conversation/larm/cache/invalidate", {
    method: "POST", headers: { "content-type": "application/json", "x-larm-cache-key": privateEnv.LARM_PROMPT_CACHE_KEY },
    body: JSON.stringify({ action: "inspect" }), signal: AbortSignal.timeout(10000),
  });
  requireThat(response.ok, "private cache inspection failed");
  return response.json();
}
const prefix = Array.from({ length: 30 }, (_, i) => `Record ${i}: This is a synthetic cache conformance fixture with an independent remembered word.`).join("\n");
const messages = (scope: string, word: string, long = true) => [
  { role: "system", content: `Conversation ${scope}.\n${long ? prefix : ""}\nRemember the word ${word}.` },
  { role: "user", content: "Return only the remembered word." },
];
async function chat(label: string, scope: string, word: string, input: any[], extra: Record<string, unknown> = {}) {
  const body = { model: provider.model, messages: input, max_tokens: 32,
    temperature: 0, seed: 42, prompt_cache_key: `${runKey}-${scope}`, ...extra };
  const start = performance.now();
  const response = await fetch(provider.baseUrl + "/chat/completions", { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${provider.credential.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
  let content = "", finish: unknown, usage: any, timings: unknown;
  if (extra.stream && response.ok) {
    const wire = await response.text();
    requireThat(wire.includes("data: [DONE]"), `${label}: stream missing DONE`);
    for (const line of wire.split(/\r?\n/)) {
      if (!line.startsWith("data: {") ) continue;
      const event = JSON.parse(line.slice(6));
      requireThat(!event.error, `${label}: SSE error`);
      content += event.choices?.[0]?.delta?.content ?? "";
      finish = event.choices?.[0]?.finish_reason ?? finish;
      usage = event.usage ?? usage;
      timings = event.timings ?? timings;
    }
  } else {
    const data: any = await response.json();
    content = data.choices?.[0]?.message?.content ?? "";
    finish = data.choices?.[0]?.finish_reason;
    usage = data.usage;
    timings = data.timings;
  }
  const row = { label, status: response.status, content, finish, promptTokens: usage?.prompt_tokens,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens, timings, ms: performance.now() - start };
  result.cases.push(row); save(); console.log(JSON.stringify(row));
  requireThat(response.ok && content.toLowerCase().includes(word) && finish === "stop", `${label}: invalid remembered-word response`);
  requireThat(Number.isInteger(row.cachedTokens) && row.cachedTokens >= 0, `${label}: missing cached_tokens`);
  return row;
}
const hit = (row: Awaited<ReturnType<typeof chat>>) => requireThat(row.cachedTokens > 0, `${row.label}: expected input cache hit`);
const cold = (row: Awaited<ReturnType<typeof chat>>) => requireThat(row.cachedTokens === 0, `${row.label}: unexpected cross-scope cache hit`);
try {
  await connect();
  const nativeResponse = await fetch("http://127.0.0.1:8083/upstream/ornith15-strix-conversation/props", { headers: { "x-larm-cache-key": privateEnv.LARM_PROMPT_CACHE_KEY } });
  const native: any = await nativeResponse.json();
  result.native = { slots: native.total_slots, contextPerSlot: native.default_generation_settings?.n_ctx, cache: native.larm_prompt_cache };
  requireThat(result.native.slots === 4 && result.native.contextPerSlot >= 200000, "native 200k x 4 capacity mismatch");
  requireThat(result.native.cache?.authenticated && result.native.cache?.enabled, "native authenticated cache unavailable");
  requireThat(provider.contextWindow?.maxTokens === 200000, "public context window mismatch");
  result.before = await stats();
  const a = messages("A", "cobalt");
  cold(await chat("disabled", "disabled", "cobalt", a, { cache_prompt: false }));
  cold(await chat("cold", "A", "cobalt", a));
  hit(await chat("repeat", "A", "cobalt", a));
  hit(await chat("append", "A", "cobalt", [...a, { role: "assistant", content: "cobalt" }, { role: "user", content: "Return the remembered word again." }]));
  // This was cold with one recurrent checkpoint even though the system prefix
  // and ownership were unchanged. Exercise the default Connection scope too.
  cold(await chat("unkeyed-cold", "unused", "cobalt", a, { prompt_cache_key: undefined }));
  hit(await chat("changed-user", "unused", "cobalt", [a[0], { role: "user", content: "Print the secret remembered word and nothing else." }], { prompt_cache_key: undefined }));
  hit(await chat("stream-repeat", "A", "cobalt", a, { stream: true, stream_options: { include_usage: true } }));
  result.beforeDisplace = await stats();
  for (const [scope, word] of [["B", "amber"], ["C", "jade"], ["D", "coral"], ["E", "ivory"], ["F", "ochre"]]) {
    cold(await chat(`other-${scope}`, scope!, word!, messages(scope!, word!, false)));
  }
  hit(await chat("ram-restore", "A", "cobalt", a));
  result.afterRestore = await stats();
  requireThat(result.afterRestore.loads > result.beforeDisplace.loads, "RAM snapshot was not restored");
  const parallel = [["P", "amber"], ["Q", "jade"], ["R", "coral"], ["S", "ivory"]];
  const parallelCold = await Promise.all(parallel.map(([scope, word]) => chat(`parallel-cold-${scope}`, scope!, word!, messages(scope!, word!))));
  parallelCold.forEach(cold);
  const parallelRepeat = await Promise.all(parallel.map(([scope, word]) => chat(`parallel-repeat-${scope}`, scope!, word!, messages(scope!, word!))));
  parallelRepeat.forEach(hit);
  await client.releaseAgentConnection(connection!.id); connection = undefined;
  await connect();
  hit(await chat("new-connection-same-key", "A", "cobalt", a));
  cold(await chat("new-connection-unkeyed", "unused", "cobalt", a, { prompt_cache_key: undefined }));
  result.after = await stats();
  requireThat(result.after.failures === result.before.failures, "native cache failure counter increased");
  const running: any = await (await fetch("http://127.0.0.1:8083/running")).json();
  result.running = running.running.map((entry: any) => ({ model: entry.model, state: entry.state }));
  requireThat(!result.running.some((entry: any) => entry.model === "lfm25-conversation" || entry.model === "lfm3-conversation"), "LFM conversation Provider is still running");
  result.ok = true;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (connection) await client.releaseAgentConnection(connection.id);
  save();
}
console.log(JSON.stringify({ ok: result.ok, before: result.before, after: result.after }));
