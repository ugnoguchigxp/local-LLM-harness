import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { LarmClient, LarmApiError } from "../../../packages/client/src/index";
import { inspectionProviderInstanceListSchema } from "../../../packages/core/src/index";
import type { AgentConnectionClaim } from "../../../packages/core/src/agent-connection";

type Provider = AgentConnectionClaim["providers"][number];
const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
const output = process.env.LARM_SHARING_EVIDENCE;
if (!output || !isAbsolute(output) || resolve(output).startsWith(resolve(import.meta.dir, "../../..") + "/")) {
  throw new Error("LARM_SHARING_EVIDENCE must be an absolute directory outside the source tree");
}
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(readFileSync("/etc/larm/larm.env", "utf8").split("\n")
  .filter(line => line && !line.startsWith("#")).map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1).replace(/^("|')(.*)\1$/, "$2")];
  }));
const client = new LarmClient({ baseUrl, apiToken: env.LARM_API_TOKEN, timeoutMs: 60_000 });
const owned = new Set<string>();
const shared = ["ornith15-strix-conversation", "granite-asr", "voicevox-tts", "kittentts-nano", "multilingual-e5-small", "ruri-system-one"];
const evidence: Record<string, unknown> = { ok: false, startedAt: new Date().toISOString() };
const headers = (provider: Provider) => ({ authorization: `Bearer ${provider.credential.token}`, "content-type": "application/json" });
const provider = (claim: AgentConnectionClaim, name: string) => {
  const item = claim.providers.find(item => item.name === name);
  if (!item) throw new Error(`Missing ${name}`);
  return item;
};

function processes() {
  const services = Object.fromEntries(["granite-asr.service", "voicevox-tts.service", "kittentts-tts.service"].map(service => {
    const value = execFileSync("systemctl", ["show", service, "--property=MainPID,ActiveEnterTimestampMonotonic,NRestarts"], { encoding: "utf8" }).trim();
    if (!/MainPID=[1-9]\d*/.test(value)) throw new Error(`${service} is not running`);
    return [service, value];
  }));
  const workers = [];
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (command[0] !== "/srv/ai/apps/q38rocm/engine/bin/llama-server"
        || !command.some(argument => argument.endsWith("/Ornith-1.5-35B-ROCmFP4-STRIX_LEAN.gguf"))) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      workers.push({ pid, startedTicks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] });
    } catch { /* Unrelated processes can exit or be unreadable. */ }
  }
  if (workers.length !== 1) throw new Error(`Expected one Strix worker, found ${workers.length}`);
  return { services, workers };
}

async function instances(minRefs: number) {
  const response = await fetch(`${baseUrl}/v1/inspection/provider-instances`, {
    headers: { authorization: `Bearer ${env.LARM_API_TOKEN}`, "x-larm-management-token": env.LARM_MANAGEMENT_TOKEN! },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Inspection returned ${response.status}`);
  const items = inspectionProviderInstanceListSchema.parse(await response.json()).instances;
  return Object.fromEntries(shared.map(runtime => {
    const matching = items.filter(item => item.instance.runtimeId === runtime && ["HOT", "BUSY"].includes(item.instance.status));
    if (matching.length !== 1 || matching[0]!.refs.allocation < minRefs || matching[0]!.warmRefs !== 1) {
      throw new Error(`${runtime} is not one warm instance shared by ${minRefs} allocations: ${JSON.stringify(matching.map(item => ({ id: item.instance.id, refs: item.refs, warmRefs: item.warmRefs })))}`);
    }
    const item = matching[0]!;
    return [runtime, { id: item.instance.id, refs: item.refs, warmRefs: item.warmRefs }];
  }));
}

async function create(selector: "contextStill" | "ornith1.5Strix" | "ornith1.5Strix-64k", subset?: string[]) {
  const catalog = await client.listAgentProfilesV3(selector);
  const created = await client.createAgentConnection({ profile: selector, expectedCatalogRevision: catalog.catalogRevision,
    audience: "same-host", client: "contextstill-strix-sharing-smoke", ...(subset ? { providers: subset } : {}),
    ttlSeconds: 600, allowFallback: false, deploymentPolicy: "existing-only" });
  owned.add(created.id);
  return created;
}

async function ready(selector: "contextStill" | "ornith1.5Strix", subset?: string[]) {
  const created = await create(selector, subset);
  const connection = await client.waitForAgentConnection(created, { timeoutMs: 120_000 });
  const claim = await client.claimAgentConnection(connection.id);
  if (claim.providers.length !== (subset?.length ?? 7)) throw new Error("Incorrect Provider set");
  const allocation = await client.getAllocation(connection.allocationId);
  if (!allocation.bindings.some(binding => binding.runtime === shared[0])) throw new Error("Profile resolved to another LLM");
  return { connection, claim };
}

async function release(id: string) { await client.releaseAgentConnection(id); owned.delete(id); }

async function chat(item: Provider, code: string) {
  const start = performance.now();
  const response = await fetch(`${item.baseUrl}/chat/completions`, { method: "POST", headers: headers(item),
    body: JSON.stringify({ model: item.model, temperature: 0, max_tokens: 96, chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { name: "task_result", strict: true, schema: {
        type: "object", properties: { code: { type: "string" }, total: { type: "integer" } }, required: ["code", "total"], additionalProperties: false,
      } } }, messages: [{ role: "user", content: `このタスクの識別子は${code}です。記録には購入数が7個と11個とあります。JSONのcodeに識別子、totalに合計購入数を入れてください。` }] }),
    signal: AbortSignal.timeout(60_000) });
  const body = await response.json() as { model: string; choices: { message: { content: string } }[] };
  if (!response.ok || body.model !== item.model) throw new Error(`LLM response mismatch: HTTP ${response.status}`);
  const parsed = JSON.parse(body.choices[0]!.message.content);
  if (parsed.code !== code || parsed.total !== 18) throw new Error("Structured task result or task isolation failed");
  return { model: item.model, status: response.status, wallMs: performance.now() - start, structuredResult: parsed };
}

async function speech(claim: AgentConnectionClaim) {
  const samples = [];
  for (const [name, text, voice] of [["tts", "明日の予定を確認しましょう。", "1"], ["tts-english", "Let's review tomorrow's schedule.", "Rosie"]]) {
    const item = provider(claim, name!);
    const response = await fetch(`${item.baseUrl}/audio/speech`, { method: "POST", headers: headers(item),
      body: JSON.stringify({ model: item.model, input: text, voice, response_format: "wav" }), signal: AbortSignal.timeout(30_000) });
    const audio = Buffer.from(await response.arrayBuffer());
    if (!response.ok || audio.length <= 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error(`${name} returned invalid audio, HTTP ${response.status}`);
    }
    samples.push({ name, model: item.model, status: response.status, bytes: audio.length });
  }
  const item = provider(claim, "asr");
  const clips = JSON.parse(readFileSync("/srv/ai/benchmarks/asr-2026-10-12/manifest.json", "utf8")).clips;
  for (const group of ["short", "long"]) {
    const clip = clips.find((clip: { group: string }) => clip.group === group);
    const form = new FormData(); form.set("model", item.model); form.set("response_format", "json");
    form.set("file", new Blob([readFileSync(clip.wav)], { type: "audio/wav" }), "speech.wav");
    const response = await fetch(`${item.baseUrl}/audio/transcriptions`, { method: "POST", body: form,
      headers: { authorization: `Bearer ${item.credential.token}` }, signal: AbortSignal.timeout(20_000) });
    const body = await response.json() as { text: string };
    const normalize = (text: string) => text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").replaceAll("3時", "三時");
    if (!response.ok || typeof body.text !== "string" || normalize(body.text) !== normalize(clip.reference)) throw new Error("ASR transcription mismatch");
    samples.push({ name: "asr", model: item.model, status: response.status, group });
  }
  return samples;
}

try {
  const health = await client.getHealth();
  const manifest = JSON.parse(readFileSync("/srv/ai/apps/larm-current/release-manifest.json", "utf8"));
  if (!health.ready || health.releaseCommit !== manifest.commit || health.configRevision !== manifest.configRevision) throw new Error("Live release identity mismatch");
  if ((await client.getServiceActivity()).state !== "idle") throw new Error("Sharing canary requires an idle starting snapshot");
  evidence.health = health;
  const context = await ready("contextStill");
  const before = processes(); evidence.before = before;
  const foreground = await ready("ornith1.5Strix");
  if ((await client.getAgentConnection(context.connection.id)).status !== "ready") throw new Error("Foreground acquisition preempted a shared background Provider");
  const commonInstances = await instances(2); evidence.sharedInstances = commonInstances;
  if (context.connection.id === foreground.connection.id || context.connection.agentProfile === foreground.connection.agentProfile) throw new Error("Profiles or leases were merged");
  evidence.distinctProfiles = { context: context.connection.agentProfile, foreground: foreground.connection.agentProfile };
  evidence.concurrentTasks = await Promise.all([
    chat(provider(context.claim, "llm"), "CONTEXT_TASK"), chat(provider(foreground.claim, "llm"), "VOICE_TASK"),
  ]);
  const laya = provider(context.claim, "system-one");
  if (laya.apiStyle !== "larm-system-one") throw new Error("ContextStill decision Provider protocol changed");
  const decision = await client.systemOne(laya, { model: laya.model, state: "返品して返金をお願いします", questions: {
    intent: { type: "choice", instructions: "問い合わせの意図を分類してください", criteria: { refund: "返品または返金", other: "その他" } },
  } });
  if (decision.answers.intent?.choice !== "refund") throw new Error("ContextStill Laya behavior changed");
  evidence.layaValidated = true;
  evidence.foregroundSpeech = await speech(foreground.claim);
  const auxiliary = [];
  for (let index = 0; index < 2; index++) {
    const item = await create("ornith1.5Strix-64k");
    auxiliary.push(await client.waitForAgentConnection(item, { timeoutMs: 60_000 }));
  }
  const fifth = await create("ornith1.5Strix-64k");
  const waiting = await client.getAllocation(fifth.allocationId);
  if (waiting.status !== "waiting") throw new Error("Fifth lease exceeded the shared four-slot limit");
  try { await client.claimAgentConnection(fifth.id); throw new Error("Waiting lease was claimable"); }
  catch (error) { if (!(error instanceof LarmApiError) || error.status !== 409) throw error; }
  await release(auxiliary[1]!.id);
  await client.waitForAgentConnection(fifth, { timeoutMs: 60_000 });
  evidence.capacity = { sharedSlots: 4, fifthWaited: true, releasedSlotPromotedWaiter: true };
  await release(auxiliary[0]!.id); await release(fifth.id);
  await release(foreground.connection.id);
  const old = provider(foreground.claim, "llm");
  const revoked = await fetch(`${old.baseUrl}/chat/completions`, { method: "POST", headers: headers(old),
    body: JSON.stringify({ model: old.model, messages: [], max_tokens: 1 }), signal: AbortSignal.timeout(10_000) });
  await revoked.body?.cancel(); if (revoked.status !== 401) throw new Error("Released foreground credential was not revoked");
  evidence.revokedStatus = revoked.status;
  evidence.backgroundSpeechAfterForegroundRelease = await speech(context.claim);
  const reopened = await ready("ornith1.5Strix");
  await release(context.connection.id);
  evidence.foregroundAfterBackgroundRelease = await chat(provider(reopened.claim, "llm"), "REOPENED_TASK");
  await release(reopened.connection.id);
  const finalInstances = await instances(0); evidence.finalInstances = finalInstances;
  for (const runtime of shared) if (finalInstances[runtime]!.id !== commonInstances[runtime]!.id) throw new Error(`${runtime} instance changed during handoff`);
  const after = processes(); evidence.after = after;
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Shared LLM, ASR or TTS reloaded during profile handoff");
  evidence.ok = true; evidence.finishedAt = new Date().toISOString();
  console.log(JSON.stringify({ ok: true, releaseCommit: health.releaseCommit, distinctProfiles: true,
    sharedRuntime: true, noProcessReload: true, speechValidated: true, fourSharedSlots: true }));
} catch (error) {
  evidence.error = error instanceof Error ? { name: error.name, message: error.message } : String(error);
  throw error;
} finally {
  const cleanup = await Promise.allSettled([...owned].map(id => client.releaseAgentConnection(id)));
  evidence.cleanupFailures = cleanup.filter(result => result.status === "rejected").length;
  writeFileSync(`${output}/sharing.json`, JSON.stringify(evidence, null, 2) + "\n");
}
