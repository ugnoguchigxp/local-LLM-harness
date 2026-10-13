import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { LarmClient, LarmApiError } from "../../../packages/client/src/index";
import { inspectionProviderInstanceListSchema } from "../../../packages/core/src/index";
import type { AgentConnectionClaim } from "../../../packages/core/src/agent-connection";

type Provider = AgentConnectionClaim["providers"][number];
const output = process.env.LARM_PREEMPTION_EVIDENCE;
if (!output || !isAbsolute(output) || resolve(output).startsWith(resolve(import.meta.dir, "../../..") + "/")) throw new Error("LARM_PREEMPTION_EVIDENCE must be a directory outside the repository");
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(readFileSync("/etc/larm/larm.env", "utf8").split("\n").filter(line => line && !line.startsWith("#")).map(line => {
  const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1).replace(/^("|')(.*)\1$/, "$2")];
}));
const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
const client = new LarmClient({ baseUrl, apiToken: env.LARM_API_TOKEN, timeoutMs: 60_000 });
const run = randomUUID().slice(0, 8);
let sequence = 0;
const owned = new Set<string>();
const streams = new Set<AbortController>();
const evidence: Record<string, unknown> = { ok: false, startedAt: new Date().toISOString() };
const get = (claim: AgentConnectionClaim, name: string) => { const item = claim.providers.find(item => item.name === name); if (!item) throw new Error(`Missing ${name}`); return item; };
const headers = (provider: Provider) => ({ authorization: `Bearer ${provider.credential.token}`, "content-type": "application/json" });

function processes() {
  const services = Object.fromEntries(["granite-asr.service", "voicevox-tts.service", "kittentts-tts.service"].map(service => {
    const value = execFileSync("systemctl", ["show", service, "--property=MainPID,ActiveEnterTimestampMonotonic,NRestarts"], { encoding: "utf8" }).trim();
    if (!/MainPID=[1-9]\d*/.test(value)) throw new Error(`${service} is not running`);
    return [service, value];
  }));
  const workers = [];
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (args[0] !== "/srv/ai/apps/q38rocm/engine/bin/llama-server" || !args.some(argument => argument.endsWith("/Ornith-1.5-35B-ROCmFP4-STRIX_LEAN.gguf"))) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      workers.push({ pid, startedTicks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] });
    } catch { /* Unrelated processes can exit or be unreadable. */ }
  }
  if (workers.length !== 1) throw new Error("Expected exactly one shared Strix worker");
  return { services, workers };
}

async function inspection() {
  const response = await fetch(`${baseUrl}/v1/inspection/provider-instances`, { headers: {
    authorization: `Bearer ${env.LARM_API_TOKEN}`, "x-larm-management-token": env.LARM_MANAGEMENT_TOKEN!,
  }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Inspection returned ${response.status}`);
  return inspectionProviderInstanceListSchema.parse(await response.json()).instances;
}
async function create(profile: "ornith1.5Strix" | "contextStill", providers?: string[]) {
  const catalog = await client.listAgentProfilesV3(profile);
  const created = await client.createAgentConnection({ profile, expectedCatalogRevision: catalog.catalogRevision, audience: "same-host",
    client: `request-preemption-${run}-${++sequence}`, ...(providers ? { providers } : {}), ttlSeconds: 600,
    allowFallback: false, deploymentPolicy: "existing-only" });
  owned.add(created.id);
  const connection = await client.waitForAgentConnection(created, { timeoutMs: 90_000 });
  return { connection, claim: await client.claimAgentConnection(connection.id) };
}
async function resumed(providers: string[]) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { return await create("contextStill", providers); }
    catch (error) {
      if (!(error instanceof LarmApiError) || error.status !== 409 || Date.now() >= deadline) throw error;
      await Bun.sleep(50);
    }
  }
}
async function generation(provider: Provider, kind: "background" | "foreground") {
  const abort = new AbortController(); streams.add(abort);
  const started = performance.now();
  const response = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: headers(provider),
    body: JSON.stringify({ model: provider.model, stream: true, temperature: 0, max_tokens: kind === "background" ? 4096 : 1024,
      chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: kind === "background"
        ? "架空の作業記録を日本語で200項目作ってください。一項目は一文。説明は不要です。"
        : "1から200までの数字を順番に、一つずつ日本語の短い説明を添えて書いてください。途中で省略しないでください。" }] }),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]) });
  if (!response.ok || !response.body) throw new Error(`${kind} stream returned HTTP ${response.status}`);
  const reader = response.body.getReader(); let buffered = "";
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) throw new Error(`${kind} completed before its first content`);
    buffered += new TextDecoder().decode(chunk.value);
    let meaningful = false;
    for (const frame of buffered.split("\n\n").slice(0, -1)) {
      const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
      if (!data || data === "[DONE]") continue;
      const body = JSON.parse(data); if (body.choices?.some((choice: { delta?: { content?: string } }) => !!choice.delta?.content)) meaningful = true;
    }
    if (meaningful) break;
  }
  return { reader, abort, firstContentMs: performance.now() - started };
}
async function close(stream: Awaited<ReturnType<typeof generation>>) {
  stream.abort.abort(new Error("synthetic foreground request finished"));
  await stream.reader.cancel().catch(() => undefined); streams.delete(stream.abort);
}
async function assertPreempted(background: Awaited<ReturnType<typeof create>>) {
  const connection = await client.getAgentConnection(background.connection.id);
  const allocation = await client.getAllocation(background.connection.allocationId);
  if (connection.status !== "failed" || connection.error?.code !== "foreground_preempted" || allocation.status !== "released") {
    throw new Error("Background connection or allocation was not preempted");
  }
  const old = get(background.claim, "llm");
  const revoked = await fetch(old.health.url, { headers: { authorization: `Bearer ${old.credential.token}` }, signal: AbortSignal.timeout(5_000) });
  await revoked.body?.cancel(); if (revoked.status !== 401) throw new Error("Preempted background credential was not revoked");
  const strix = (await inspection()).filter(item => item.instance.runtimeId === "ornith15-strix-conversation" && ["HOT", "BUSY"].includes(item.instance.status));
  if (strix.length !== 1 || strix[0]!.refs.allocation !== 1 || strix[0]!.warmRefs !== 1) throw new Error("Background did not release the shared runtime allocation reference");
  return { connectionStatus: connection.status, reason: connection.error.code, allocationStatus: allocation.status, revokedStatus: revoked.status, sharedInstance: strix[0]!.instance.id };
}

try {
  const health = await client.getHealth();
  const manifest = JSON.parse(readFileSync("/srv/ai/apps/larm-current/release-manifest.json", "utf8"));
  if (!health.ready || health.releaseCommit !== manifest.commit || health.configRevision !== manifest.configRevision) throw new Error("Live release identity mismatch");
  if ((await client.getServiceActivity()).state !== "idle") throw new Error("Preemption canary requires an idle starting snapshot");
  evidence.health = health;
  const foreground = await create("ornith1.5Strix");
  const before = processes(); evidence.before = before;
  const initialInstances = await inspection();
  const background = await resumed(["llm", "system-one", "embedding"]);
  const bg = await generation(get(background.claim, "llm"), "background");
  const foregroundStart = performance.now();
  const fg = await generation(get(foreground.claim, "llm"), "foreground");
  evidence.llmPreemption = { ...(await assertPreempted(background)), firstContentMs: fg.firstContentMs,
    observedAfterMs: performance.now() - foregroundStart, backgroundFirstContentMs: bg.firstContentMs };
  let blocked = false;
  try { const unexpected = await create("contextStill", ["llm"]); await client.releaseAgentConnection(unexpected.connection.id); owned.delete(unexpected.connection.id); }
  catch (error) { if (!(error instanceof LarmApiError) || error.status !== 409 || error.code !== "provider_conflict") throw error; blocked = true; }
  if (!blocked) throw new Error("Background reacquired a lease while the foreground stream was active");
  evidence.backgroundBlockedDuringForeground = true;
  await close(bg); await close(fg);
  const layaDeadline = Date.now() + 5_000;
  for (;;) {
    const laya = (await inspection()).find(item => item.instance.runtimeId === "laya-system-one" && ["HOT", "BUSY", "STOPPING"].includes(item.instance.status));
    if (!laya) break;
    if (Date.now() > layaDeadline) throw new Error("Background-only Laya did not release its process after preemption");
    await Bun.sleep(50);
  }
  evidence.backgroundOnlyProcessReleased = true;
  const checks = [];
  for (const name of ["asr", "tts", "tts-english", "system-one", "embedding"]) {
    const idleBackground = await resumed(["llm"]);
    const stream = await generation(get(idleBackground.claim, "llm"), "background");
    const item = get(foreground.claim, name); const started = performance.now();
    if (name === "asr") {
      const clip = JSON.parse(readFileSync("/srv/ai/benchmarks/asr-2026-10-12/manifest.json", "utf8")).clips.find((clip: { group: string }) => clip.group === "long");
      const form = new FormData(); form.set("model", item.model); form.set("response_format", "json");
      form.set("file", new Blob([readFileSync(clip.wav)], { type: "audio/wav" }), "speech.wav");
      const response = await fetch(`${item.baseUrl}/audio/transcriptions`, { method: "POST", body: form, headers: { authorization: `Bearer ${item.credential.token}` }, signal: AbortSignal.timeout(20_000) });
      const body = await response.json() as { text: string };
      const normalize = (text: string) => text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").replaceAll("3時", "三時");
      if (!response.ok || normalize(body.text) !== normalize(clip.reference)) throw new Error("Foreground ASR failed");
    } else if (name.startsWith("tts")) {
      const response = await fetch(`${item.baseUrl}/audio/speech`, { method: "POST", headers: headers(item), body: JSON.stringify({ model: item.model,
        input: name === "tts" ? "明日の予定を確認しましょう。" : "Let's review tomorrow's schedule.", voice: name === "tts" ? "1" : "Rosie", response_format: "wav" }), signal: AbortSignal.timeout(30_000) });
      const audio = Buffer.from(await response.arrayBuffer());
      if (!response.ok || audio.length <= 44 || audio.toString("ascii", 0, 4) !== "RIFF") throw new Error("Foreground TTS failed");
    } else if (name === "system-one") {
      if (item.apiStyle !== "larm-system-one") throw new Error("Unexpected decision provider");
      await client.systemOne(item, { model: item.model, state: "気にしないで大丈夫ですよ。", questions: { emotion: { type: "choice", instructions: "発話の態度を判定してください", criteria: { none: "中立", warmth: "親しみや気遣い" } } } });
    } else {
      if (item.apiStyle !== "larm-embedding") throw new Error("Unexpected embedding provider");
      const result = await client.embed(item, { texts: ["予定の確認"], type: "query", normalize: true, priority: "normal" });
      if (result.count !== 1 || result.dimension !== 384) throw new Error("Foreground embedding failed");
    }
    checks.push({ provider: name, wallMs: performance.now() - started, ...(await assertPreempted(idleBackground)) });
    await close(stream);
  }
  evidence.eachProviderPreempts = checks;
  const finalBackground = await resumed(["llm"]);
  const stream = await generation(get(finalBackground.claim, "llm"), "background"); await close(stream);
  evidence.backgroundResumesWhileForegroundConnectionHeld = (await client.getAgentConnection(foreground.connection.id)).status === "ready";
  if (!evidence.backgroundResumesWhileForegroundConnectionHeld) throw new Error("Foreground lease was unnecessarily released");
  const after = processes(); evidence.after = after;
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Shared model, ASR or TTS processes reloaded");
  const finalInstances = await inspection();
  for (const runtime of ["ornith15-strix-conversation", "granite-asr", "voicevox-tts", "kittentts-nano"]) {
    const initial = initialInstances.find(item => item.instance.runtimeId === runtime)!;
    const final = finalInstances.find(item => item.instance.runtimeId === runtime)!;
    if (initial.instance.id !== final.instance.id || final.warmRefs !== 1) throw new Error(`${runtime} was replaced or lost warm retention`);
  }
  evidence.ok = true; evidence.finishedAt = new Date().toISOString();
  console.log(JSON.stringify({ ok: true, releaseCommit: health.releaseCommit, eachRequestPreempts: true,
    backgroundBlockedDuringForeground: true, backgroundResumesWhenIdle: true, sharedProcessesNotReloaded: true }));
} catch (error) {
  evidence.error = error instanceof Error ? { name: error.name, message: error.message } : String(error);
  throw error;
} finally {
  for (const abort of streams) abort.abort(new Error("canary cleanup"));
  const cleanup = await Promise.allSettled([...owned].map(id => client.releaseAgentConnection(id)));
  evidence.cleanupFailures = cleanup.filter(result => result.status === "rejected").length;
  writeFileSync(`${output}/preemption.json`, JSON.stringify(evidence, null, 2) + "\n");
}
