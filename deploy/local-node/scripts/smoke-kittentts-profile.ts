import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LarmClient } from "../../../packages/client/src/index";

const baseUrl = process.env.LARM_SMOKE_BASE_URL ?? "http://127.0.0.1:9810";
const environment = Object.fromEntries(readFileSync("/etc/larm/larm.env", "utf8")
  .split("\n").filter((line) => line && !line.startsWith("#"))
  .map((line) => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
const client = new LarmClient({ baseUrl, apiToken: environment.LARM_API_TOKEN, timeoutMs: 60_000 });
const output = process.env.KITTENTTS_SMOKE_OUTPUT ?? "/srv/ai/results/larm/tts/2026-10-12-kittentts/deployed";
mkdirSync(output, { recursive: true });
const health = await client.getHealth();
const catalog = await client.listAgentProfilesV3("SAAA-gemma4-26b");
const profile = catalog.profiles[0];
if (!health.ready || profile?.id !== "saaa-conversation-gemma4-26b-voice"
  || profile.providers.find((provider) => provider.name === "tts")?.model !== "voicevox-core"
  || profile.providers.find((provider) => provider.name === "llm")?.contextWindow?.maxTokens !== 262144
  || profile.providers.find((provider) => provider.name === "tts-english")?.model !== "kitten-tts-nano-0.8-fp32") {
  throw new Error("Gemma discovery contract does not include the English TTS addition");
}
const auxiliary = await client.listAgentProfilesV3("SAAA-gemma4-26b-64k");
if (auxiliary.profiles[0]?.providers.length !== 1
  || auxiliary.profiles[0]?.providers[0]?.contextWindow?.maxTokens !== 65536) {
  throw new Error("Gemma auxiliary session contract changed");
}
const created = await client.createAgentConnection({
  profile: "SAAA-gemma4-26b", expectedCatalogRevision: catalog.catalogRevision,
  audience: "same-host", client: "kittentts-live-smoke", providers: ["tts-english"],
  ttlSeconds: 300, allowFallback: false, deploymentPolicy: "existing-only",
});
let releaseDone = false;
try {
  const ready = await client.waitForAgentConnection(created, { timeoutMs: 60_000 });
  const claim = await client.claimAgentConnection(ready.id);
  const provider = claim.providers[0];
  if (claim.providers.length !== 1 || !provider || provider.apiStyle !== "openai"
    || provider.name !== "tts-english" || provider.capability !== "speech.tts.english") {
    throw new Error("English-only claim is inconsistent with the requested profile subset");
  }
  const voiceResponse = await client.listVoices(provider.model);
  if (!voiceResponse.ok) throw new Error(`voice catalog returned HTTP ${voiceResponse.status}`);
  const voices = await voiceResponse.json() as { default_voice: string; voices: { id: string; voice_presentation: string }[] };
  if (voices.default_voice !== "Rosie"
    || voices.voices.find((voice) => voice.id === "Rosie")?.voice_presentation !== "feminine"
    || voices.voices.find((voice) => voice.id === "Hugo")?.voice_presentation !== "masculine") {
    throw new Error("Rosie/Hugo voice metadata is inconsistent");
  }
  const samples = [];
  for (const voice of ["Rosie", "Hugo"]) {
    const start = performance.now();
    const response = await fetch(`${provider.baseUrl}/audio/speech`, {
      method: "POST", headers: { authorization: `Bearer ${provider.credential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: provider.model, input: "Hello! I'm ready to help you plan your day.", voice, response_format: "wav" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "audio/wav") {
      throw new Error(`${voice} speech returned HTTP ${response.status}`);
    }
    const audio = new Uint8Array(await response.arrayBuffer());
    if (audio.length <= 44 || Buffer.from(audio.slice(0, 4)).toString() !== "RIFF"
      || Buffer.from(audio.slice(8, 12)).toString() !== "WAVE") throw new Error("invalid WAV response");
    writeFileSync(join(output, `${voice}.wav`), audio);
    samples.push({ voice, httpStatus: response.status, wallMs: performance.now() - start, bytes: audio.length });
  }
  await client.releaseAgentConnection(ready.id);
  releaseDone = true;
  const revoked = await fetch(`${provider.baseUrl}/audio/speech`, {
    method: "POST", headers: { authorization: `Bearer ${provider.credential.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: provider.model, input: "Hello.", voice: "Rosie", response_format: "wav" }),
  });
  await revoked.body?.cancel();
  if (revoked.status !== 401) throw new Error("released Provider credential was not revoked");
  const evidence = { ok: true, releaseCommit: health.releaseCommit, configRevision: health.configRevision,
    requestedProfile: "SAAA-gemma4-26b", agentProfile: profile.id, provider: "tts-english",
    model: provider.model, samples, released: true, revokedStatus: revoked.status,
    japaneseTtsRetained: true, auxiliaryContextRetained: true, observedAt: new Date().toISOString() };
  writeFileSync(join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally {
  if (!releaseDone) await client.releaseAgentConnection(created.id).catch(() => undefined);
}
