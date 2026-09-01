import { createHash } from "node:crypto";
import {
  loadArtifactManifest,
  loadAgentConnectionCatalogForRegistry,
  loadRegistry,
  loadRuntimeReleaseCatalog,
  type ArtifactDefinition,
  type AgentConnectionCatalog,
  type Registry,
  type RuntimeReleaseDefinition,
} from "@larm/core";

export type CatalogGeneration = {
  revision: string;
  registry: Registry;
  artifacts: ArtifactDefinition[];
  releases: RuntimeReleaseDefinition[];
  agentConnections?: AgentConnectionCatalog;
};

export type CatalogPaths = {
  configDir: string;
  artifactManifestPath: string;
  releaseCatalogPath: string;
};

export function computeCatalogGenerationRevision(input: {
  registry: Registry;
  artifacts: ArtifactDefinition[];
  releases: RuntimeReleaseDefinition[];
  agentConnections?: AgentConnectionCatalog;
}): string {
  return createHash("sha256").update(JSON.stringify({
    nodes: input.registry.nodes,
    runtimes: input.registry.runtimes,
    profiles: input.registry.profiles,
    routes: input.registry.routes,
    artifacts: input.artifacts,
    releases: input.releases,
    agentConnections: input.agentConnections ?? null,
  })).digest("hex");
}

export function loadCatalogGeneration(paths: CatalogPaths): CatalogGeneration {
  const registry = loadRegistry(paths.configDir);
  const artifacts = loadArtifactManifest(paths.artifactManifestPath);
  const releases = loadRuntimeReleaseCatalog(paths.releaseCatalogPath, registry, artifacts);
  const agentConnections = loadAgentConnectionCatalogForRegistry(paths.configDir, registry);
  return {
    registry,
    artifacts,
    releases,
    agentConnections,
    revision: computeCatalogGenerationRevision({ registry, artifacts, releases, agentConnections }),
  };
}
