import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type DaemonIdentity = {
  version: string;
  releaseCommit: string;
  configRevision: string;
  bootEpoch: string;
};

export function loadReleaseCommit(manifestPath: string | undefined): string {
  if (!manifestPath) return "development";
  const descriptor = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed: unknown;
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("release manifest is invalid");
    parsed = JSON.parse(readFileSync(descriptor, "utf8")) as unknown;
  } finally {
    closeSync(descriptor);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("release manifest is invalid");
  }
  const manifest = parsed as Record<string, unknown>;
  const requiredKeys = [
    "schemaVersion",
    "commit",
    "larmVersion",
    "bunVersion",
    "lockfileSha256",
    "nodeModulesSha256",
    "configRevision",
    "createdAt",
  ];
  if (
    Object.keys(manifest).sort().join("\n") !== [...requiredKeys].sort().join("\n")
    || manifest.schemaVersion !== 1
    || typeof manifest.commit !== "string" || !/^[a-f0-9]{40}$/.test(manifest.commit)
    || typeof manifest.larmVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.larmVersion)
    || typeof manifest.bunVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.bunVersion)
    || typeof manifest.lockfileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.lockfileSha256)
    || typeof manifest.nodeModulesSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.nodeModulesSha256)
    || typeof manifest.configRevision !== "string" || !/^[a-f0-9]{64}$/.test(manifest.configRevision)
    || typeof manifest.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.createdAt)
    || Number.isNaN(Date.parse(manifest.createdAt))
  ) {
    throw new Error("release manifest is invalid");
  }
  return manifest.commit;
}

const CONFIG_FILES = [
  "nodes.yaml",
  "runtimes.yaml",
  "profiles.yaml",
  "routes.yaml",
  "agent-connections.yaml",
];

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
