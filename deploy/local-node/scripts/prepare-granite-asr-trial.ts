import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { loadCatalogGeneration } from "../../../apps/daemon/src/catalog-generation";

const source = resolve(import.meta.dir, "../../..");
const active = realpathSync("/srv/ai/apps/larm-current");
const root = "/srv/ai/apps/larm-granite-trial";
const config = join(root, "config");
if (existsSync(join(root, "prepared.json"))) throw new Error("Trial is already prepared; retain its original snapshot");
mkdirSync(root, { recursive: true });
cpSync(join(active, "config/local-node"), config, { recursive: true });
cpSync(join(source, "apps/granite-asr"), join(root, "provider"), { recursive: true });
cpSync(join(source, "deploy/local-node/scripts/activate-granite-asr-trial.sh"), join(root, "activate.sh"));
cpSync(join(source, "deploy/local-node/systemd/trials/granite-asr-trial.service"), join(root, "granite-asr-trial.service"));
cpSync(join(source, "deploy/local-node/polkit/53-larm-granite-runtime-control.rules"), join(root, "53-larm-granite-runtime-control.rules"));
const paths = { configDir: join(active, "config/local-node"),
  artifactManifestPath: join(active, "deploy/local-node/models.yaml"),
  releaseCatalogPath: join(active, "deploy/local-node/releases.yaml") };
const original = loadCatalogGeneration(paths);
const profileId = "saaa-conversation-gemma4-26b-voice";
const connectionsPath = join(config, "agent-connections.yaml");
const connections = parseDocument(readFileSync(connectionsPath, "utf8"));
const before = connections.toJS();
if (before.profileSelectors["SAAA-gemma4-26b"].agentProfile !== profileId) throw new Error("Unexpected profile selector");
const providers = before.agentProfiles[profileId].providers;
const index = providers.findIndex((provider: { name: string }) => provider.name === "asr");
if (index < 0 || providers[index].route !== "stt-qwen" || providers[index].publicModel !== "qwen3-asr-1.7b") {
  throw new Error("Original ASR differs from the expected Qwen baseline");
}
connections.setIn(["agentProfiles", profileId, "providers", index, "route"], "stt-granite-trial");
connections.setIn(["agentProfiles", profileId, "providers", index, "publicModel"], "granite-speech-4.1-2b");
writeFileSync(connectionsPath, String(connections));
const routesPath = join(config, "routes.yaml");
const routes = parseDocument(readFileSync(routesPath, "utf8"));
routes.setIn(["routes", "stt-granite-trial"], { capabilities: ["speech.stt"], explicitOnly: true,
  candidates: [{ runtime: "granite-asr-trial", purpose: "primary" }] });
writeFileSync(routesPath, String(routes));
const runtimesPath = join(config, "runtimes.yaml");
const runtimes = parseDocument(readFileSync(runtimesPath, "utf8"));
runtimes.setIn(["runtimes", "granite-asr-trial"], {
  capability: ["speech.stt"], protocol: "openai.audio-transcriptions.v1", backend: "systemd", node: "local-node",
  policy: { class: "preferred", lifecycle: "managed", warm: { minInstances: 1, idleTtlSeconds: 60 } },
  resources: { estimatedMemoryGB: 3.5, maxConcurrentRequests: 1, maxQueuedRequests: 1, queueTimeoutMs: 2000 },
  deployment: { service: "granite-asr-trial.service", healthPort: 8089, healthPath: "/health", endpoint: "http://127.0.0.1:8089" },
});
writeFileSync(runtimesPath, String(runtimes));
const trial = loadCatalogGeneration({ ...paths, configDir: config });
// Prove that every pre-existing runtime, route and profile is preserved except the two ASR fields.
const originalRegistry = JSON.parse(JSON.stringify(original.registry));
const trialRegistry = JSON.parse(JSON.stringify(trial.registry));
trialRegistry.routes = trialRegistry.routes.filter((item: { id: string }) => item.id !== "stt-granite-trial");
trialRegistry.runtimes = trialRegistry.runtimes.filter((item: { id: string }) => item.id !== "granite-asr-trial");
if (JSON.stringify(originalRegistry) !== JSON.stringify(trialRegistry)) throw new Error("Unrelated registry change");
const normalized = connections.toJS();
normalized.agentProfiles[profileId].providers[index] = providers[index];
if (JSON.stringify(before) !== JSON.stringify(normalized)) throw new Error("Unrelated Agent Profile change");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(join(root, "prepared.json"), JSON.stringify({ preparedAt: new Date().toISOString(), activeRelease: active,
  originalRevision: original.revision, trialRevision: trial.revision, profile: "SAAA-gemma4-26b", agentProfile: profileId,
  originalAsr: providers[index], trialAsr: connections.toJS().agentProfiles[profileId].providers[index],
  baselineFiles: Object.fromEntries(["agent-connections.yaml", "runtimes.yaml", "routes.yaml"].map(name => [name, sha256(join(active, "config/local-node", name))])),
  aliasesSharingProfile: Object.entries(before.profileSelectors).filter(([, value]) => (value as { agentProfile: string }).agentProfile === profileId).map(([key]) => key),
}, null, 2) + "\n");
console.log(JSON.stringify({ prepared: true, root, originalRevision: original.revision, trialRevision: trial.revision }));
