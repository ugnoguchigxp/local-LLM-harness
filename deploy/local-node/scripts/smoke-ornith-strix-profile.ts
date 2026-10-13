import { readFileSync, writeFileSync } from "node:fs";

const root = "/srv/ai/apps/larm-ornith-strix-profile";
const prepared = JSON.parse(readFileSync(`${root}/prepared.json`, "utf8"));
const environment = Object.fromEntries(readFileSync("/etc/larm/larm.env", "utf8").split("\n")
  .filter(line => line && !line.startsWith("#")).map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1).replace(/^("|')(.*)\1$/, "$2")];
  }));
const headers = { authorization: `Bearer ${environment.LARM_API_TOKEN}` };
type Provider = { name: string; model: string; contextWindow?: { maxTokens: number } };
type Catalog = { profiles: { id: string; providers: Provider[] }[] };
const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(`http://127.0.0.1:9810${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`LARM returned ${response.status}`);
  return await response.json() as T;
};
const health = await get<{ ready: boolean; configRevision: string }>("/health");
const catalog = await get<Catalog>("/v3/agent-profiles");
const profile = catalog.profiles.find((item: { id: string }) => item.id === prepared.profileId);
const base = catalog.profiles.find((item: { id: string }) => item.id === "saaa-conversation-gemma4-26b-voice");
const llm = profile?.providers.find((item: { name: string }) => item.name === "llm");
if (!health.ready || health.configRevision !== prepared.profileRevision || !base || !profile
  || llm?.model !== "ornith-1.5-strix-lean" || llm.contextWindow?.maxTokens !== 262144
  || JSON.stringify(profile.providers.filter((item: { name: string }) => item.name !== "llm"))
    !== JSON.stringify(base.providers.filter((item: { name: string }) => item.name !== "llm"))) {
  throw new Error("Live Ornith profile does not match the Gemma copy and prepared revision");
}
const selectedBase = await get<Catalog>("/v3/agent-profiles?profile=SAAA-gemma4-26b");
if (selectedBase.profiles[0]?.id !== base.id) throw new Error("Existing Gemma selector changed");
const evidence = { ok: true, profileId: prepared.profileId, profileRevision: health.configRevision,
  observedAt: new Date().toISOString(), model: llm.model, providerCount: profile.providers.length,
  nonLlmProvidersPreserved: true, gemmaSelectorPreserved: true };
writeFileSync(`${root}/live-evidence.json`, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
