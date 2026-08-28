import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ArtifactDefinition } from "./artifacts";
import { getRuntime, type Registry } from "./registry";

const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const artifactIdsSchema = z.array(identifierSchema).min(1).max(64).refine(
  (items) => new Set(items).size === items.length,
  "artifacts must be unique",
);

const runtimeReleaseYamlSchema = z.object({
  runtime: identifierSchema,
  artifacts: artifactIdsSchema,
  providerConfigRevision: identifierSchema,
  estimatedMemoryGB: z.number().positive(),
  healthPath: z.string().min(1).max(256).startsWith("/").default("/health"),
  default: z.boolean().default(false),
}).strict();

const runtimeReleasesFileSchema = z.object({
  runtimeReleases: z.record(identifierSchema, runtimeReleaseYamlSchema),
}).strict();

export const runtimeReleaseDefinitionSchema = runtimeReleaseYamlSchema.extend({
  id: identifierSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export type RuntimeReleaseDefinition = z.infer<typeof runtimeReleaseDefinitionSchema>;

export class RuntimeReleaseCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeReleaseCatalogError";
  }
}

function releaseDigest(release: Omit<RuntimeReleaseDefinition, "digest">): string {
  return createHash("sha256").update(JSON.stringify({
    id: release.id,
    runtime: release.runtime,
    artifacts: release.artifacts,
    providerConfigRevision: release.providerConfigRevision,
    estimatedMemoryGB: release.estimatedMemoryGB,
    healthPath: release.healthPath,
    default: release.default,
  })).digest("hex");
}

export function parseRuntimeReleaseCatalog(
  input: unknown,
  registry: Registry,
  artifacts: ArtifactDefinition[],
): RuntimeReleaseDefinition[] {
  const parsed = runtimeReleasesFileSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new RuntimeReleaseCatalogError(`releases.yaml: ${detail}`);
  }

  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const releases = Object.entries(parsed.data.runtimeReleases)
    .map(([id, release]) => {
      const base = { id, ...release };
      return { ...base, digest: releaseDigest(base) };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const defaults = new Map<string, string>();
  for (const release of releases) {
    const runtime = getRuntime(registry, release.runtime);
    if (!runtime) {
      throw new RuntimeReleaseCatalogError(
        `releases.yaml: release ${release.id} references unknown runtime ${release.runtime}`,
      );
    }
    if (release.estimatedMemoryGB > runtime.resources.estimatedMemoryGB) {
      throw new RuntimeReleaseCatalogError(
        `releases.yaml: release ${release.id} memory estimate exceeds the static runtime admission bound`,
      );
    }
    if ((runtime.artifacts?.length ?? 0) === 0) {
      throw new RuntimeReleaseCatalogError(
        `releases.yaml: runtime ${runtime.id} does not declare release-managed artifact targets`,
      );
    }
    if (release.healthPath !== "/health") {
      throw new RuntimeReleaseCatalogError(
        `releases.yaml: release ${release.id} uses an unsupported health contract`,
      );
    }
    const targets = new Set<string>();
    for (const artifactId of release.artifacts) {
      const artifact = artifactsById.get(artifactId);
      if (!artifact) {
        throw new RuntimeReleaseCatalogError(
          `releases.yaml: release ${release.id} references unknown artifact ${artifactId}`,
        );
      }
      if (targets.has(artifact.path)) {
        throw new RuntimeReleaseCatalogError(
          `releases.yaml: release ${release.id} contains multiple artifacts for ${artifact.path}`,
        );
      }
      targets.add(artifact.path);
    }
    const runtimeTargets = new Set((runtime.artifacts ?? []).map((artifactId) => {
      const artifact = artifactsById.get(artifactId);
      if (!artifact) {
        throw new RuntimeReleaseCatalogError(
          `releases.yaml: runtime ${runtime.id} references unknown artifact ${artifactId}`,
        );
      }
      return artifact.path;
    }));
    if (
      targets.size !== runtimeTargets.size
      || [...targets].some((target) => !runtimeTargets.has(target))
    ) {
      throw new RuntimeReleaseCatalogError(
        `releases.yaml: release ${release.id} artifact targets must match runtime ${runtime.id}`,
      );
    }
    if (release.default) {
      const existing = defaults.get(release.runtime);
      if (existing) {
        throw new RuntimeReleaseCatalogError(
          `releases.yaml: runtime ${release.runtime} has multiple defaults: ${existing}, ${release.id}`,
        );
      }
      defaults.set(release.runtime, release.id);
      const declared = [...(runtime.artifacts ?? [])].sort();
      const selected = [...release.artifacts].sort();
      if (JSON.stringify(declared) !== JSON.stringify(selected)) {
        throw new RuntimeReleaseCatalogError(
          `releases.yaml: default release ${release.id} must match runtime ${release.runtime} artifacts`,
        );
      }
    }
  }

  for (const runtime of registry.runtimes) {
    if ((runtime.artifacts?.length ?? 0) > 0 && !defaults.has(runtime.id)) {
      throw new RuntimeReleaseCatalogError(
        `releases.yaml: runtime ${runtime.id} requires exactly one default release`,
      );
    }
  }
  return releases;
}

export function loadRuntimeReleaseCatalog(
  path: string,
  registry: Registry,
  artifacts: ArtifactDefinition[],
): RuntimeReleaseDefinition[] {
  try {
    return parseRuntimeReleaseCatalog(parseYaml(readFileSync(path, "utf8")), registry, artifacts);
  } catch (error) {
    if (error instanceof RuntimeReleaseCatalogError) {
      throw error;
    }
    throw new RuntimeReleaseCatalogError(
      `failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function defaultRuntimeRelease(
  releases: RuntimeReleaseDefinition[],
  runtimeId: string,
): RuntimeReleaseDefinition | undefined {
  return releases.find((release) => release.runtime === runtimeId && release.default);
}
