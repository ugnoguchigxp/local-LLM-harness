import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { loadCatalogGeneration } from "../../../apps/daemon/src/catalog-generation";

const source = resolve(import.meta.dir, "../../..");
const active = realpathSync("/srv/ai/apps/larm-current");
const root = "/srv/ai/apps/larm-ornith-strix-profile";
if (existsSync(root)) throw new Error("Preparation already exists; retain its baseline and backups");
const unitEnvironment = execFileSync("systemctl", ["show", "larm-daemon.service", "--property=Environment", "--value"], { encoding: "utf8" });
const setting = (key: string, fallback: string) => {
  const value = unitEnvironment.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`))?.[1] ?? fallback;
  if (!value.startsWith("/") || /["'\\]/.test(value)) throw new Error(`Unsupported ${key} path`);
  return value;
};
const originalPaths = {
  configDir: setting("LARM_CONFIG_DIR", join(active, "config/local-node")),
  artifactManifestPath: setting("LARM_ARTIFACT_MANIFEST", join(active, "deploy/local-node/models.yaml")),
  releaseCatalogPath: setting("LARM_RELEASE_CATALOG", join(active, "deploy/local-node/releases.yaml")),
};
const original = loadCatalogGeneration(originalPaths);
const sourcePaths = { configDir: join(source, "config/local-node"), artifactManifestPath: join(source, "deploy/local-node/models.yaml"), releaseCatalogPath: join(source, "deploy/local-node/releases.yaml") };
loadCatalogGeneration(sourcePaths);
const profileId = "ornith1.5Strix";
const auxiliaryProfileId = "ornith1.5Strix-64k";
const runtimeId = "ornith15-strix-conversation";
const routeId = "llm-ornith15-strix";
const artifactId = "ornith15-35b-strix-lean";
const releaseId = "ornith15-strix-conversation-p4-v3";
const baseProfileId = "saaa-conversation-gemma4-26b-voice";
const providerConfig = "/var/lib/larm/provider-config/llama-swap.yaml";
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const baselineFiles = Object.fromEntries([
  ...readdirSync(originalPaths.configDir).filter(name => name.endsWith(".yaml")).map(name => join(originalPaths.configDir, name)),
  originalPaths.artifactManifestPath, originalPaths.releaseCatalogPath, providerConfig,
].map(path => [path, digest(path)]));
mkdirSync(root, { mode: 0o700 });
cpSync(originalPaths.configDir, join(root, "config"), { recursive: true });
cpSync(originalPaths.artifactManifestPath, join(root, "models.yaml"));
cpSync(originalPaths.releaseCatalogPath, join(root, "releases.yaml"));
cpSync(providerConfig, join(root, "config/llama-swap.yaml"));
cpSync(providerConfig, join(root, "llama-swap.previous.yaml"));
const readDoc = (path: string) => parseDocument(readFileSync(path, "utf8"));
const add = (target: string, origin: string, path: string[]) => {
  const doc = readDoc(target);
  if (doc.hasIn(path)) throw new Error(`Existing definition: ${path.join(".")}`);
  const value = readDoc(origin).toJS();
  doc.setIn(path, path.reduce((node, key) => node[key], value));
  writeFileSync(target, String(doc));
};
const connectionsPath = join(root, "config/agent-connections.yaml");
const connections = readDoc(connectionsPath);
if (connections.hasIn(["agentProfiles", profileId])) throw new Error("Profile already exists");
const profile = structuredClone(connections.toJS().agentProfiles[baseProfileId]);
if (!profile) throw new Error("Gemma base profile missing");
profile.description = readDoc(join(sourcePaths.configDir, "agent-connections.yaml")).toJS().agentProfiles[profileId].description;
const llm = profile.providers.find((provider: { name: string }) => provider.name === "llm");
if (!llm || llm.contextWindow?.maxTokens !== 262144) throw new Error("Unexpected Gemma context contract");
llm.route = routeId;
llm.publicModel = "ornith-1.5-strix-lean";
connections.setIn(["agentProfiles", profileId], profile);
connections.setIn(["profileSelectors", profileId], { agentProfile: profileId });
const auxiliary = structuredClone(connections.toJS().agentProfiles["saaa-conversation-gemma4-26b-64k"]);
if (!auxiliary || auxiliary.providers[0]?.contextWindow?.maxTokens !== 65536) throw new Error("Unexpected auxiliary context contract");
auxiliary.description = readDoc(join(sourcePaths.configDir, "agent-connections.yaml")).toJS().agentProfiles[auxiliaryProfileId].description;
auxiliary.providers[0].route = routeId;
auxiliary.providers[0].publicModel = llm.publicModel;
connections.setIn(["agentProfiles", auxiliaryProfileId], auxiliary);
connections.setIn(["profileSelectors", auxiliaryProfileId], { agentProfile: auxiliaryProfileId });
writeFileSync(connectionsPath, String(connections));
add(join(root, "config/runtimes.yaml"), join(sourcePaths.configDir, "runtimes.yaml"), ["runtimes", runtimeId]);
add(join(root, "config/routes.yaml"), join(sourcePaths.configDir, "routes.yaml"), ["routes", routeId]);
add(join(root, "models.yaml"), sourcePaths.artifactManifestPath, ["models", artifactId]);
add(join(root, "releases.yaml"), sourcePaths.releaseCatalogPath, ["runtimeReleases", releaseId]);
add(join(root, "config/llama-swap.yaml"), join(sourcePaths.configDir, "llama-swap.yaml"), ["models", runtimeId]);
const swapPath = join(root, "config/llama-swap.yaml");
const swap = readDoc(swapPath);
const members = swap.toJS().groups["conversation-llm-slot"].members;
swap.setIn(["groups", "conversation-llm-slot", "members"], [...members, runtimeId]);
writeFileSync(swapPath, String(swap));
const paths = { configDir: join(root, "config"), artifactManifestPath: join(root, "models.yaml"), releaseCatalogPath: join(root, "releases.yaml") };
const prepared = loadCatalogGeneration(paths);
const normalized = structuredClone(prepared);
normalized.registry.runtimes = normalized.registry.runtimes.filter(item => item.id !== runtimeId);
normalized.registry.routes = normalized.registry.routes.filter(item => item.id !== routeId);
normalized.artifacts = normalized.artifacts.filter(item => item.id !== artifactId);
normalized.releases = normalized.releases.filter(item => item.id !== releaseId);
normalized.agentConnections!.profiles = normalized.agentConnections!.profiles.filter(item => ![profileId, auxiliaryProfileId].includes(item.id));
normalized.agentConnections!.profileSelectors = normalized.agentConnections!.profileSelectors.filter(item => ![profileId, auxiliaryProfileId].includes(item.id));
normalized.revision = original.revision;
if (JSON.stringify(normalized) !== JSON.stringify(original)) throw new Error("Unrelated catalog change");
const normalizedSwap = swap.toJS();
delete normalizedSwap.models[runtimeId];
normalizedSwap.groups["conversation-llm-slot"].members = members;
if (JSON.stringify(normalizedSwap) !== JSON.stringify(readDoc(providerConfig).toJS())) throw new Error("Unrelated llama-swap change");
for (const [path, hash] of Object.entries(baselineFiles)) {
  if (digest(path) !== hash) throw new Error("Active configuration changed while preparing");
}
const overrides = `[Service]\nEnvironment=LARM_CONFIG_DIR=${paths.configDir}\nEnvironment=LARM_ARTIFACT_MANIFEST=${paths.artifactManifestPath}\nEnvironment=LARM_RELEASE_CATALOG=${paths.releaseCatalogPath}\n`;
writeFileSync(join(root, "99-ornith-strix-profile.conf"), overrides);
cpSync(join(source, "deploy/local-node/scripts/activate-ornith-strix-profile.sh"), join(root, "activate.sh"));
cpSync(join(source, "deploy/local-node/scripts/smoke-ornith-strix-profile.ts"), join(root, "smoke.ts"));
const stagedFiles = Object.fromEntries([
  ...readdirSync(paths.configDir).map(name => join(paths.configDir, name)),
  paths.artifactManifestPath, paths.releaseCatalogPath, join(root, "99-ornith-strix-profile.conf"), join(root, "activate.sh"), join(root, "smoke.ts"), join(root, "llama-swap.previous.yaml"),
].map(path => [path, digest(path)]));
writeFileSync(join(root, "prepared.json"), JSON.stringify({ preparedAt: new Date().toISOString(), activeRelease: active, originalPaths,
  originalRevision: original.revision, profileRevision: prepared.revision, profileId, auxiliaryProfileId, baselineFiles, stagedFiles,
  nonLlmProviders: profile.providers.filter((provider: { name: string }) => provider.name !== "llm"),
}, null, 2) + "\n");
console.log(JSON.stringify({ prepared: true, root, profileId, originalRevision: original.revision, profileRevision: prepared.revision }));
