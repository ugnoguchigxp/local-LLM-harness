import { parseDaemonConfig } from "./config";
import { loadCatalogGeneration } from "./catalog-generation";

const config = parseDaemonConfig();
const generation = loadCatalogGeneration({
  configDir: config.configDir,
  artifactManifestPath: config.artifactManifestPath,
  releaseCatalogPath: config.releaseCatalogPath,
});
console.log(generation.revision);
