import { readFileSync, writeFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { LarmClient, LarmApiError } from "../../../packages/client/src/index";
import { inspectionProviderInstanceListSchema } from "../../../packages/core/src/index";
import type { AgentConnectionClaim } from "../../../packages/core/src/agent-connection";

type OpenAiAgentProvider = Extract<AgentConnectionClaim["providers"][number], { apiStyle: "openai" }>;

const output = process.env.LARM_SESSION_EVIDENCE;
if (!output || !isAbsolute(output) || resolve(output).startsWith(resolve(import.meta.dir, "../../..") + "/")) {
  throw new Error("LARM_SESSION_EVIDENCE must be an absolute path outside the source repository");
}
const environment = Object.fromEntries(readFileSync("/etc/larm/larm.env", "utf8").split("\n")
  .filter(line => line && !line.startsWith("#")).map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1).replace(/^("|')(.*)\1$/, "$2")];
  }));
const client = new LarmClient({ baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
  apiToken: environment.LARM_API_TOKEN, timeoutMs: 60_000 });
const runtime = "ornith15-strix-conversation";
const mainSessions = 4;
const run = randomUUID().slice(0, 8);
const owned = new Set<string>();
const evidence: Record<string, unknown> = { ok: false, observedAt: new Date().toISOString() };
async function sharedInstance(expectedRefs: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`${process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810"}/v1/inspection/provider-instances`, {
      headers: { authorization: `Bearer ${environment.LARM_API_TOKEN}`, "x-larm-management-token": environment.LARM_MANAGEMENT_TOKEN! },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Instance inspection returned ${response.status}`);
    const instances = inspectionProviderInstanceListSchema.parse(await response.json()).instances
      .filter(item => item.instance.runtimeId === runtime && ["HOT", "BUSY"].includes(item.instance.status));
    if (instances.length === 1 && instances[0]!.refs.allocation === expectedRefs) return instances[0]!;
    if (attempt === 19) throw new Error(`Expected one runtime with ${expectedRefs} allocation refs; observed ${JSON.stringify(instances.map(item => ({ id: item.instance.id, refs: item.refs })))}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Runtime reference inspection did not settle");
}
const llm = (claim: AgentConnectionClaim): OpenAiAgentProvider => {
  const provider = claim.providers.find((p): p is OpenAiAgentProvider => p.name === "llm" && p.apiStyle === "openai");
  if (!provider || provider.model !== "ornith-1.5-strix-lean") throw new Error("Unexpected LLM provider");
  return provider;
};
const headers = (provider: OpenAiAgentProvider) => ({ "content-type": "application/json", authorization: `Bearer ${provider.credential.token}` });
async function create(index: number) {
  const selector = "ornith1.5Strix";
  const catalog = await client.listAgentProfilesV3(selector);
  const connection = await client.createAgentConnection({ profile: selector,
    ...(index > 0 ? { providers: ["llm"] } : {}),
    expectedCatalogRevision: catalog.catalogRevision, audience: "same-host", client: `strix-four-${run}-${index}`,
    ttlSeconds: 600, allowFallback: false, deploymentPolicy: "existing-only" }, { waitSeconds: 3 });
  owned.add(connection.id);
  return connection;
}
async function release(id: string) {
  await client.releaseAgentConnection(id);
  owned.delete(id);
}
async function chat(provider: OpenAiAgentProvider, index: number) {
  const start = performance.now();
  const response = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: headers(provider),
    signal: AbortSignal.timeout(60_000), body: JSON.stringify({ model: provider.model, stream: true, temperature: 0,
      max_tokens: 128, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: "user", content: `試験番号${index}。ローカルLLMの応答速度と会話履歴の関係を日本語で詳しく説明してください。` }] }) });
  if (!response.ok || !response.body) throw new Error(`Stream returned ${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = "", text = "";
  let firstMs: number | undefined, completionTokens = 0, finish: string | undefined, done = false;
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    pending += decoder.decode(next.value, { stream: true });
    let boundary: number;
    while ((boundary = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, boundary).trim(); pending = pending.slice(boundary + 1);
      if (!line.startsWith("data: ")) continue;
      if (line === "data: [DONE]") { done = true; continue; }
      const chunk = JSON.parse(line.slice(6)); if (chunk.error) throw new Error("Inference stream contained an error");
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta && firstMs === undefined) firstMs = performance.now() - start;
      text += delta; completionTokens = chunk.usage?.completion_tokens ?? completionTokens;
      finish = chunk.choices?.[0]?.finish_reason ?? finish;
    }
  }
  const totalMs = performance.now() - start;
  if (!text || firstMs === undefined || !finish || !done || completionTokens < 1) throw new Error("Incomplete SSE response");
  return { index, firstContentMs: firstMs, totalMs, completionTokens, finishReason: finish,
    decodeWindowTokS: (completionTokens - 1) * 1000 / (totalMs - firstMs) };
}
async function recall(provider: OpenAiAgentProvider, index: number) {
  const secretWord = `SESSION_${index}_${run}`;
  const response = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: headers(provider),
    signal: AbortSignal.timeout(30_000), body: JSON.stringify({ model: provider.model, temperature: 0, max_tokens: 64,
      chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: {
        name: "session_recall", strict: true, schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } } },
      messages: [{ role: "user", content: `この会話の合言葉は ${secretWord} です。覚えてください。` },
        { role: "assistant", content: "合言葉を覚えました。" }, { role: "user", content: 'この会話の合言葉をJSONのcodeにそのまま返してください。' }] }) });
  if (!response.ok) throw new Error(`Recall returned ${response.status}`);
  const body = await response.json() as { choices: { message: { content: string } }[] };
  if (JSON.parse(body.choices[0]!.message.content).code !== secretWord) throw new Error(`Session ${index} history mixed`);
  return { index, exactHistoryPassed: true };
}
async function assertRevoked(provider: OpenAiAgentProvider) {
  const response = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: headers(provider),
    signal: AbortSignal.timeout(10_000), body: JSON.stringify({ model: provider.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }) });
  await response.body?.cancel(); if (response.status !== 401) throw new Error(`Released credential returned ${response.status}`);
  return response.status;
}
try {
  const health = await client.getHealth(); evidence.health = health;
  evidence.main256kSessions = mainSessions;
  const mainCatalog = await client.listAgentProfilesV3("ornith1.5Strix");
  if (mainCatalog.profiles[0]?.providers.find(p => p.name === "llm")?.contextWindow?.maxTokens !== 262144
) throw new Error("Wrong primary context window");
  const sessions = [];
  for (let index = 0; index < 4; index++) {
    const created = await create(index);
    const ready = await client.waitForAgentConnection(created, { timeoutMs: 120_000 });
    const claim = await client.claimAgentConnection(ready.id);
    if (claim.providers.length !== (index === 0 ? 7 : 1)) throw new Error("Provider set differs from Gemma pattern");
    const allocation = await client.getAllocation(ready.allocationId);
    const binding = allocation.bindings.find(b => b.runtime === runtime);
    if (!binding || allocation.status !== "ready") throw new Error("Runtime binding missing");
    const connectionHealth = await client.getAgentConnectionHealth(ready.id);
    if (connectionHealth.status !== "ready") throw new Error("Provider health is not ready");
    sessions.push({ ready, claim, provider: llm(claim), binding });
    console.log(JSON.stringify({ ready: index + 1, id: ready.id, providerCount: claim.providers.length }));
  }
  const instance = await sharedInstance(4); evidence.sharedInstance = instance;
  if (new Set(sessions.map(s => s.ready.id)).size !== 4) {
    throw new Error("Connections are not distinct leases sharing one runtime");
  }
  evidence.sessions = sessions.map(s => ({ id: s.ready.id, allocationId: s.ready.allocationId,
    providers: s.claim.providers.map(p => ({ name: p.name, model: p.model })), binding: s.binding }));
  evidence.concurrentFour = await Promise.all(sessions.map((s, i) => chat(s.provider, i)));
  evidence.independentHistories = await Promise.all(sessions.map((s, i) => recall(s.provider, i)));
  let capacityRejected = false;
  try {
    const unexpected = await client.allocate({ requirements: [{ capability: "llm.general", route: "llm-ornith15-strix" }],
      client: `strix-reject-${run}`, ttlSeconds: 60, deploymentPolicy: "existing-only", allowFallback: false, capacityPolicy: "reject", priority: 4000 });
    await client.release(unexpected.id);
  } catch (error) {
    if (!(error instanceof LarmApiError) || error.status !== 409 || error.code !== "resource_exhausted" || !error.message.includes("allocation capacity 4")) throw error;
    capacityRejected = true; evidence.fifthReject = { status: error.status, code: error.code, message: error.message };
  }
  if (!capacityRejected) throw new Error("Fifth allocation exceeded the four-session limit");
  const fifth = await create(4);
  await new Promise(r => setTimeout(r, 1000));
  const waiting = await client.getAllocation(fifth.allocationId);
  if (waiting.status !== "waiting") throw new Error(`Fifth connection was ${waiting.status}, expected waiting`);
  try { await client.claimAgentConnection(fifth.id); throw new Error("Waiting connection was claimable"); }
  catch (error) { if (!(error instanceof LarmApiError) || error.status !== 409) throw error; }
  evidence.fifthWaiting = { id: fifth.id, allocationId: fifth.allocationId, allocationStatus: waiting.status, claimStatus: 409 };
  await release(sessions[3]!.ready.id);
  evidence.releasedCredentialStatus = await assertRevoked(sessions[3]!.provider);
  const promoted = await client.waitForAgentConnection(fifth, { timeoutMs: 60_000 });
  const promotedClaim = await client.claimAgentConnection(promoted.id);
  const promotedInstance = await sharedInstance(4);
  if (promotedInstance.instance.id !== instance.instance.id) throw new Error("Promotion created a second runtime");
  evidence.replacement = { id: promoted.id, status: promoted.status, instanceId: promotedInstance.instance.id,
    chat: await chat(llm(promotedClaim), 4) };
  const renewed = await client.refreshAgentConnection(sessions[0]!.ready.id, { ttlSeconds: 600 });
  evidence.renewed = { id: renewed.connection.id, status: renewed.connection.status,
    recall: await recall(llm(renewed.claim), 0) };
  const activeProviders = [llm(renewed.claim), sessions[1]!.provider, sessions[2]!.provider, llm(promotedClaim)];
  for (const id of [...owned]) await release(id);
  evidence.revokedAfterRelease = await Promise.all(activeProviders.map(assertRevoked));
  evidence.finalActivity = await client.getServiceActivity();
  evidence.ok = true;
  console.log(JSON.stringify({ ok: true, fourDistinctSessions: true, singleSharedRuntime: true,
    fifthRejectedOrWaits: true, releasePromotesWaiter: true, credentialRevocation: true }));
} catch (error) {
  evidence.error = error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
  throw error;
} finally {
  const cleanup = await Promise.allSettled([...owned].map(id => client.releaseAgentConnection(id)));
  evidence.cleanupFailures = cleanup.filter(result => result.status === "rejected").length;
  writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
}
