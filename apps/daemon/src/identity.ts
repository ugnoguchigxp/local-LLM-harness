import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DaemonIdentity = {
  version: string;
  configRevision: string;
  bootEpoch: string;
};

const CONFIG_FILES = ["nodes.yaml", "runtimes.yaml", "profiles.yaml", "routes.yaml"];

export function computeConfigRevision(configDir: string, artifactManifestPath: string): string {
  const hash = createHash("sha256");
  const inputs = [
    ...CONFIG_FILES.map((name) => ({ name: `registry/${name}`, path: join(configDir, name) })),
    { name: "artifacts/models.yaml", path: artifactManifestPath },
  ];
  for (const input of inputs) {
    hash.update(input.name);
    hash.update("\0");
    hash.update(readFileSync(input.path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function createBootEpoch(random: () => string = randomUUID): string {
  const value = random().replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  if (value.length < 8) {
    throw new Error("boot epoch source must provide at least 8 safe characters");
  }
  return `epoch-${value}`;
}
