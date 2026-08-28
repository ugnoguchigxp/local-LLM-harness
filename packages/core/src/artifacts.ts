import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const artifactIdSchema = z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);
const safeRelativePathSchema = z.string().min(1).max(1024).refine(
  (value) => !value.startsWith("/") && !value.split("/").includes(".."),
  "must be a safe relative path",
);

const artifactYamlSchema = z.object({
  role: z.string().min(1),
  source: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  }, "source must use http or https"),
  sourcePath: safeRelativePathSchema.optional(),
  revision: safeRelativePathSchema.optional(),
  version: z.string().min(1).optional(),
  filename: z.string().min(1).max(255).refine(
    (value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\"),
    "filename must be a safe base name",
  ).optional(),
  path: z.string().startsWith("/").refine(
    (value) => !value.split("/").includes(".."),
    "path must not traverse parent directories",
  ),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  sha256: sha256Schema.optional(),
  quantization: z.string().min(1).optional(),
  runtime: z.string().min(1).max(128).optional(),
}).superRefine((artifact, context) => {
  const singleFileFields = [artifact.filename, artifact.bytes, artifact.sha256, artifact.sourcePath];
  if (!singleFileFields.some((value) => value !== undefined)) {
    return;
  }
  for (const field of ["filename", "revision", "bytes", "sha256"] as const) {
    if (artifact[field] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} is required for a single-file artifact`,
        path: [field],
      });
    }
  }
});

const artifactsFileSchema = z.object({
  models: z.record(artifactIdSchema, artifactYamlSchema),
});

export const artifactDefinitionSchema = artifactYamlSchema.extend({
  id: artifactIdSchema,
});

export type ArtifactDefinition = z.infer<typeof artifactDefinitionSchema>;

export class ArtifactManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactManifestError";
  }
}

export function parseArtifactManifest(input: unknown): ArtifactDefinition[] {
  const parsed = artifactsFileSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ArtifactManifestError(`models.yaml: ${detail}`);
  }
  return Object.entries(parsed.data.models)
    .map(([id, artifact]) => ({ id, ...artifact }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadArtifactManifest(path: string): ArtifactDefinition[] {
  try {
    return parseArtifactManifest(parseYaml(readFileSync(path, "utf8")));
  } catch (err) {
    if (err instanceof ArtifactManifestError) {
      throw err;
    }
    throw new ArtifactManifestError(
      `failed to load ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function isStageableArtifact(artifact: ArtifactDefinition): artifact is ArtifactDefinition & {
  filename: string;
  revision: string;
  bytes: number;
  sha256: string;
} {
  return Boolean(artifact.filename && artifact.revision && artifact.bytes && artifact.sha256);
}

export function artifactDownloadUrl(artifact: ArtifactDefinition): string {
  if (!isStageableArtifact(artifact)) {
    throw new ArtifactManifestError(`artifact ${artifact.id} is not a checksummed single-file artifact`);
  }
  const source = artifact.source.replace(/\/+$/, "");
  const hostname = new URL(source).hostname.toLowerCase();
  if (hostname === "huggingface.co" || hostname === "www.huggingface.co") {
    const sourcePath = (artifact.sourcePath ?? artifact.filename)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return `${source}/resolve/${encodeURIComponent(artifact.revision)}/${sourcePath}`;
  }
  return source;
}
