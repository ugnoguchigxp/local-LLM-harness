import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { LarmClient } from "../../../packages/client/src/index";

const output = process.env.GRANITE_SMOKE_OUTPUT_DIR ?? "/srv/ai/evidence/granite-standard-20261013";
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(readFileSync("/etc/larm/larm.env", "utf8").split("\n")
  .filter(line => line && !line.startsWith("#")).map(line => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
const client = new LarmClient({ baseUrl: "http://127.0.0.1:9810", apiToken: env.LARM_API_TOKEN, timeoutMs: 60_000 });
const health = await client.getHealth();
const manifest = JSON.parse(readFileSync("/srv/ai/apps/larm-current/release-manifest.json", "utf8"));
if (!health.ready || health.releaseCommit !== manifest.commit || health.configRevision !== manifest.configRevision) {
  throw new Error("Live identity does not match the standard release manifest");
}
const fixtures = JSON.parse(readFileSync("/srv/ai/benchmarks/asr-2026-10-12/manifest.json", "utf8")).clips;
const results = [];
for (const [selector, llm] of [["ornith1.5Strix", "ornith-1.5-strix-lean"], ["SAAA-gemma4-26b", "gemma4-26b-a4b"]] as const) {
  const catalog = await client.listAgentProfilesV3(selector);
  const profile = catalog.profiles[0];
  if (catalog.catalogRevision !== health.configRevision
    || profile?.providers.find(provider => provider.name === "asr")?.model !== "granite-speech-4.1-2b"
    || profile.providers.find(provider => provider.name === "llm")?.model !== llm
    || profile.providers.find(provider => provider.name === "llm")?.contextWindow?.maxTokens !== 262144
    || profile.providers.find(provider => provider.name === "tts")?.model !== "voicevox-core"
    || profile.providers.find(provider => provider.name === "tts-english")?.model !== "kitten-tts-nano-0.8-fp32"
    || profile.providers.some(provider => provider.name === "sentence-language")) {
    throw new Error(`${selector}: standard ASR or retained provider contract mismatch`);
  }
  const created = await client.createAgentConnection({ profile: selector, expectedCatalogRevision: catalog.catalogRevision,
    audience: "same-host", client: "granite-standard-live-smoke", providers: ["asr"], ttlSeconds: 300,
    allowFallback: false, deploymentPolicy: "existing-only" });
  let released = false;
  try {
    const ready = await client.waitForAgentConnection(created, { timeoutMs: 60_000 });
    const claim = await client.claimAgentConnection(ready.id);
    const provider = claim.providers[0];
    if (claim.providers.length !== 1 || provider?.model !== "granite-speech-4.1-2b") throw new Error("Incorrect ASR claim");
    const samples = [];
    for (const group of ["short", "long"]) {
      const clip = fixtures.find((item: { group: string }) => item.group === group);
      const form = new FormData();
      form.set("model", provider.model); form.set("response_format", "json");
      form.set("file", new Blob([readFileSync(clip.wav)], { type: "audio/wav" }), "speech.wav");
      const start = performance.now();
      const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, { method: "POST", body: form,
        headers: { authorization: `Bearer ${provider.credential.token}` }, signal: AbortSignal.timeout(15_000) });
      const text = await response.text();
      const normalize = (value: string) => value.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").replaceAll("3時", "三時");
      if (response.status !== 200 || typeof JSON.parse(text).text !== "string"
        || normalize(JSON.parse(text).text) !== normalize(clip.reference)) throw new Error(`${selector}: transcription rejected or incorrect`);
      samples.push({ group, seconds: (performance.now() - start) / 1000, status: response.status });
    }
    await client.releaseAgentConnection(ready.id); released = true;
    const revoked = await fetch(`${provider.baseUrl}/audio/transcriptions`, { method: "POST", body: new FormData(),
      headers: { authorization: `Bearer ${provider.credential.token}` } });
    await revoked.body?.cancel();
    if (revoked.status !== 401) throw new Error("Released ASR credential is still valid");
    results.push({ selector, llm, samples, revokedStatus: revoked.status });
  } finally { if (!released) await client.releaseAgentConnection(created.id).catch(() => undefined); }
}
const evidence = { ok: true, observedAt: new Date().toISOString(), releaseCommit: health.releaseCommit,
  configRevision: health.configRevision, bootEpoch: health.bootEpoch, results, eumenesModified: false };
writeFileSync(`${output}/live-evidence.json`, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
