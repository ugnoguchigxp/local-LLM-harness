import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const artifactIdSchema = z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);
const safeRelativePathSchema = z.string().min(1).max(1024).refine((value) => {
  const segments = value.split("/");
  return !value.startsWith("/")
    && /^[a-zA-Z0-9._/-]+$/.test(value)
    && !value.includes("\\")
    && !value.includes("\0")
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "must be a normalized safe relative path");
const httpSourceSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:")
    && url.username === ""
    && url.password === "";
}, "source must use http or https without embedded credentials");
const targetPathSchema = z.string().startsWith("/").refine((value) => {
  const segments = value.slice(1).split("/");
  return value !== "/"
    && !value.startsWith("//")
    && !value.includes("\\")
    && !value.includes("\0")
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "path must be a normalized non-root absolute path");

const commonArtifactShape = {
  role: z.string().min(1),
  source: httpSourceSchema,
  revision: safeRelativePathSchema,
  version: z.string().min(1).optional(),
  path: targetPathSchema,
  quantization: z.string().min(1).optional(),
  runtime: z.string().min(1).max(128).optional(),
};

const fileArtifactYamlSchema = z.object({
  kind: z.literal("file"),
  ...commonArtifactShape,
  sourcePath: safeRelativePathSchema.optional(),
  filename: z.string().min(1).max(255).refine(
    (value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\"),
    "filename must be a safe base name",
  ),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema,
}).strict();

export const snapshotFileSchema = z.object({
  path: safeRelativePathSchema,
  sourcePath: safeRelativePathSchema.optional(),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema,
}).strict();

export function computeSnapshotDigest(
  files: readonly { path: string; bytes: number; sha256: string }[],
): string {
  const hasher = createHash("sha256");
  for (const file of files) {
    hasher.update(file.path);
    hasher.update("\0");
    hasher.update(String(file.bytes));
    hasher.update("\0");
    hasher.update(file.sha256.toLowerCase());
    hasher.update("\n");
  }
  return hasher.digest("hex");
}

const snapshotArtifactYamlSchema = z.object({
  kind: z.literal("snapshot"),
  ...commonArtifactShape,
  totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxFiles: z.number().int().positive().max(100_000),
  snapshotDigest: sha256Schema,
  files: z.array(snapshotFileSchema).min(1).max(100_000),
}).strict().superRefine((artifact, context) => {
  const source = new URL(artifact.source);
  if (source.search || source.hash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "snapshot source must be a base URL without query or fragment",
      path: ["source"],
    });
  }
  if (artifact.files.length > artifact.maxFiles) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `files exceeds maxFiles (${artifact.maxFiles})`,
      path: ["files"],
    });
  }

  let previous: string | undefined;
  const caseFolded = new Set<string>();
  let totalBytes = 0;
  artifact.files.forEach((file, index) => {
    if (previous !== undefined && file.path <= previous) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "files must be strictly sorted by path and contain no duplicates",
        path: ["files", index, "path"],
      });
    }
    previous = file.path;
    const folded = file.path.toLocaleLowerCase("en-US");
    if (caseFolded.has(folded)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "file paths must not collide when case-folded",
        path: ["files", index, "path"],
      });
    }
    caseFolded.add(folded);
    totalBytes += file.bytes;
  });
  if (totalBytes !== artifact.totalBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `totalBytes is ${artifact.totalBytes}; file entries sum to ${totalBytes}`,
      path: ["totalBytes"],
    });
  }
  const digest = computeSnapshotDigest(artifact.files);
  if (digest !== artifact.snapshotDigest.toLowerCase()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `snapshotDigest does not match canonical file metadata (${digest})`,
      path: ["snapshotDigest"],
    });
  }
});

const artifactYamlSchema = z.discriminatedUnion("kind", [
  fileArtifactYamlSchema,
  snapshotArtifactYamlSchema,
]);

const artifactsFileSchema = z.object({
  models: z.record(artifactIdSchema, artifactYamlSchema),
}).strict();

export const artifactDefinitionSchema = z.discriminatedUnion("kind", [
  fileArtifactYamlSchema.extend({ id: artifactIdSchema }),
  snapshotArtifactYamlSchema.safeExtend({ id: artifactIdSchema }),
]);

export type ArtifactDefinition = z.infer<typeof artifactDefinitionSchema>;
export type FileArtifactDefinition = Extract<ArtifactDefinition, { kind: "file" }>;
export type SnapshotArtifactDefinition = Extract<ArtifactDefinition, { kind: "snapshot" }>;
export type SnapshotFileDefinition = z.infer<typeof snapshotFileSchema>;

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

export function isFileArtifact(artifact: ArtifactDefinition): artifact is FileArtifactDefinition {
  return artifact.kind === "file";
}

export function isSnapshotArtifact(
  artifact: ArtifactDefinition,
): artifact is SnapshotArtifactDefinition {
  return artifact.kind === "snapshot";
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function artifactFileDownloadUrl(
  artifact: ArtifactDefinition,
  file?: SnapshotFileDefinition,
): string {
  const source = artifact.source.replace(/\/+$/, "");
  const hostname = new URL(source).hostname.toLowerCase();
  const sourcePath = isFileArtifact(artifact)
    ? artifact.sourcePath ?? artifact.filename
    : file?.sourcePath ?? file?.path;
  if (!sourcePath) {
    throw new ArtifactManifestError(`artifact ${artifact.id} snapshot file is missing`);
  }
  if (hostname === "huggingface.co" || hostname === "www.huggingface.co") {
    return `${source}/resolve/${encodeURIComponent(artifact.revision)}/${encodedPath(sourcePath)}`;
  }
  if (isFileArtifact(artifact)) {
    return source;
  }
  return `${source}/${encodedPath(sourcePath)}`;
}

export function artifactDownloadUrl(artifact: ArtifactDefinition): string {
  if (!isFileArtifact(artifact)) {
    throw new ArtifactManifestError(`artifact ${artifact.id} is not a single-file artifact`);
  }
  return artifactFileDownloadUrl(artifact);
}
