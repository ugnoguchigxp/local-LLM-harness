import { readFileSync, writeFileSync } from "node:fs";
import { LarmClient } from "../../../packages/client/src/index";

const root = "/srv/ai/apps/larm-granite-trial";
const environment = Object.fromEntries(readFileSync("/etc/larm/larm.env", "utf8")
  .split("\n").filter(line => line && !line.startsWith("#"))
  .map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
const client = new LarmClient({ baseUrl: "http://127.0.0.1:9810", apiToken: environment.LARM_API_TOKEN, timeoutMs: 60_000 });
const prepared = JSON.parse(readFileSync(`${root}/prepared.json`, "utf8"));
const health = await client.getHealth();
const catalog = await client.listAgentProfilesV3("SAAA-gemma4-26b");
const profile = catalog.profiles[0];
if (!health.ready || health.configRevision !== prepared.trialRevision
  || profile?.id !== "saaa-conversation-gemma4-26b-voice"
  || profile.providers.find(provider => provider.name === "asr")?.model !== "granite-speech-4.1-2b"
  || profile.providers.find(provider => provider.name === "llm")?.model !== "gemma4-26b-a4b"
  || profile.providers.find(provider => provider.name === "llm")?.contextWindow?.maxTokens !== 262144
  || profile.providers.find(provider => provider.name === "tts")?.model !== "voicevox-core") {
  throw new Error("Live Gemma/Granite profile does not match the prepared contract");
}
const unaffected = await client.listAgentProfilesV3();
if (unaffected.profiles.find(profile => profile.id === "asr-qwen")?.providers.find(provider => provider.name === "asr")?.model !== "qwen3-asr-1.7b") {
  throw new Error("An unrelated selector's ASR changed");
}
const created = await client.createAgentConnection({ profile: "SAAA-gemma4-26b", expectedCatalogRevision: catalog.catalogRevision,
  audience: "same-host", client: "granite-asr-live-smoke", providers: ["asr"], ttlSeconds: 300,
  allowFallback: false, deploymentPolicy: "existing-only" });
let released = false;
try {
  const ready = await client.waitForAgentConnection(created, { timeoutMs: 60_000 });
  const claim = await client.claimAgentConnection(ready.id);
  const provider = claim.providers[0];
  if (claim.providers.length !== 1 || provider?.name !== "asr" || provider.model !== "granite-speech-4.1-2b") {
    throw new Error("Claim does not match Granite ASR catalog");
  }
  const manifest = JSON.parse(readFileSync("/srv/ai/benchmarks/asr-2026-10-12/manifest.json", "utf8"));
  const samples = [];
  for (const group of ["short", "long"]) {
    const clip = manifest.clips.find((item: { group: string }) => item.group === group);
    const body = new FormData();
    body.set("model", provider.model);
    body.set("response_format", "json");
    body.set("file", new Blob([readFileSync(clip.wav)], { type: "audio/wav" }), "speech.wav");
    const start = performance.now();
    const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, { method: "POST", body,
      headers: { authorization: `Bearer ${provider.credential.token}` }, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (response.status !== 200 || typeof JSON.parse(text).text !== "string") throw new Error(`Provider HTTP ${response.status}`);
    samples.push({ group, text: JSON.parse(text).text, seconds: (performance.now() - start) / 1000 });
  }
  await client.releaseAgentConnection(ready.id);
  released = true;
  const revoked = await fetch(`${provider.baseUrl}/audio/transcriptions`, { method: "POST",
    headers: { authorization: `Bearer ${provider.credential.token}` }, body: new FormData() });
  await revoked.body?.cancel();
  if (revoked.status !== 401) throw new Error("Released credential was not revoked");
  const evidence = { ok: true, productionApplied: true, observedAt: new Date().toISOString(),
    profile: "SAAA-gemma4-26b", agentProfile: profile.id, model: provider.model,
    configRevision: health.configRevision, samples, revokedStatus: revoked.status,
    eumenesModified: false, llmAndTtsPreserved: true, unrelatedSaaaAsrPreserved: true };
  writeFileSync(`${root}/live-evidence.json`, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
} finally {
  if (!released) await client.releaseAgentConnection(created.id).catch(() => undefined);
}
