import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const output = "/srv/ai/evidence/ornith-profile-retirement-20261013";
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(readFileSync("/etc/larm/larm.env", "utf8").split("\n")
  .filter(line => line && !line.startsWith("#")).map(line => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
const retired = ["deep-reasoning-35b", "saaa-qwen38", "saaa-conversation-gemma4",
  "saaa-conversation-ornith15-image", "saaa-conversation-ornith15-music",
  "contextstill-decision-default-canary", "backchannelLfm25Jp", "backchannelGemma3",
  "coding-default", "saaa-conversation-ornith15", "SAAA", "ornith1.5Strix-64k", "vulnWorkbench"];
const catalogResponse = await fetch("http://127.0.0.1:9810/v3/agent-profiles");
if (!catalogResponse.ok) throw new Error("Catalog unavailable");
const catalog = await catalogResponse.json() as { catalogRevision: string; profiles: { id: string }[] };
if (catalog.profiles.length !== 15 || catalog.profiles.some(item => retired.includes(item.id))) {
  throw new Error("Retired profiles still present or retained profile count changed");
}
const results = [];
for (const profile of retired) {
  const response = await fetch(`http://127.0.0.1:9810/v3/agent-profiles?profile=${encodeURIComponent(profile)}`);
  await response.body?.cancel();
  if (response.status !== 404) throw new Error(`${profile} is still discoverable`);
  results.push({ profile, status: response.status });
}
for (const profile of ["backchannelLfm25Jp", "backchannelGemma3", "SAAA", "ornith1.5Strix-64k", "vulnWorkbench"]) {
  const response = await fetch("http://127.0.0.1:9810/v1/agent-connections", { method: "POST",
    headers: { authorization: `Bearer ${env.LARM_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ profile, audience: "same-host", client: "profile-cleanup-negative-smoke",
      ttlSeconds: 60, allowFallback: false, deploymentPolicy: "existing-only" }) });
  await response.body?.cancel();
  if (response.status !== 400) throw new Error(`${profile}: request schema still accepts the retired selector`);
}
for (const profile of ["ornith1.5Strix", "contextStill", "SAAA-w-Image", "SAAA-w-music", "backchannelQwen35"]) {
  const response = await fetch(`http://127.0.0.1:9810/v3/agent-profiles?profile=${encodeURIComponent(profile)}`);
  await response.body?.cancel();
  if (response.status !== 200) throw new Error(`${profile}: retained selector unavailable`);
}
writeFileSync(`${output}/live-removal.json`, JSON.stringify({ ok: true, observedAt: new Date().toISOString(),
  catalogRevision: catalog.catalogRevision, profileCount: catalog.profiles.length, retired: results,
  modelFilesDeleted: false, retainedSelectorsValidated: true }, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, removed: retired.length, remainingProfiles: catalog.profiles.length }));
