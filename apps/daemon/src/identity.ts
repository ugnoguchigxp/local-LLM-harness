import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DaemonIdentity = {
  version: string;
  releaseCommit: string;
  configRevision: string;
  bootEpoch: string;
};

export function loadReleaseCommit(manifestPath: string | undefined): string {
  if (!manifestPath) return "development";
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  if (
    typeof parsed !== "object" || parsed === null || !("commit" in parsed)
    || typeof parsed.commit !== "string" || !/^[a-f0-9]{40}$/.test(parsed.commit)
  ) {
    throw new Error("release manifest commit is invalid");
  }
  return parsed.commit;
}

const CONFIG_FILES = ["nodes.yaml", "runtimes.yaml", "profiles.yaml", "routes.yaml"];

export function computeConfigRevision(
  configDir: string,
  artifactManifestPath: string,
  releaseCatalogPath?: string,
): string {
  const hash = createHash("sha256");
  const inputs = [
    ...CONFIG_FILES.map((name) => ({ name: `registry/${name}`, path: join(configDir, name) })),
    { name: "artifacts/models.yaml", path: artifactManifestPath },
    ...(releaseCatalogPath
      ? [{ name: "artifacts/releases.yaml", path: releaseCatalogPath }]
      : []),
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
