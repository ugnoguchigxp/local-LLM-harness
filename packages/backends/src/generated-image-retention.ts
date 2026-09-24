import { lstat, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const DEFAULT_GENERATED_IMAGE_MAX_BYTES = 20_000_000_000;
export const DEFAULT_GENERATED_IMAGE_TARGET_BYTES = 18_000_000_000;

const SAFE_ARTIFACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SAFE_YEAR = /^\d{4}$/;
const SAFE_MONTH = /^(?:0[1-9]|1[0-2])$/;

export type StoredGeneratedImageArtifact = {
  artifactId: string;
  directory: string;
  bytes: number;
  createdAtMs: number;
};

export type GeneratedImagePruneResult = {
  removedArtifactIds: string[];
  remainingArtifacts: number;
  remainingBytes: number;
};

export type GeneratedImageArtifactRetentionOptions = {
  artifactRoot: string;
  maxBytes?: number;
  targetBytes?: number;
};

export class GeneratedImageRetentionError extends Error {
  constructor(
    readonly code: "unsafe_image_artifact_root" | "image_pool_capacity_exhausted",
    message: string,
  ) {
    super(message);
    this.name = "GeneratedImageRetentionError";
  }
}

export class GeneratedImageArtifactRetention {
  readonly root: string;
  readonly maxBytes: number;
  readonly targetBytes: number;

  constructor(options: GeneratedImageArtifactRetentionOptions) {
    if (!isAbsolute(options.artifactRoot)) {
      throw new GeneratedImageRetentionError(
        "unsafe_image_artifact_root",
        "generated image artifact root must be absolute",
      );
    }
    this.root = resolve(options.artifactRoot);
    if (this.root === dirname(this.root)) {
      throw new GeneratedImageRetentionError(
        "unsafe_image_artifact_root",
        "generated image artifact root must not be a filesystem root",
      );
    }
    this.maxBytes = options.maxBytes ?? DEFAULT_GENERATED_IMAGE_MAX_BYTES;
    this.targetBytes = options.targetBytes ?? DEFAULT_GENERATED_IMAGE_TARGET_BYTES;
    if (
      !Number.isSafeInteger(this.maxBytes)
      || this.maxBytes < 1
      || !Number.isSafeInteger(this.targetBytes)
      || this.targetBytes < 0
      || this.targetBytes >= this.maxBytes
    ) {
      throw new GeneratedImageRetentionError(
        "image_pool_capacity_exhausted",
        "generated image artifact retention bounds are invalid",
      );
    }
  }

  async list(): Promise<readonly StoredGeneratedImageArtifact[]> {
    return await this.scan();
  }

  async remove(artifactId: string): Promise<boolean> {
    if (!SAFE_ARTIFACT_ID.test(artifactId)) return false;
    const artifact = (await this.scan()).find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) return false;
    await this.removeDirectory(artifact.directory);
    return true;
  }

  async prune(
    requiredBytes = 0,
    protectedArtifactIds = new Set<string>(),
  ): Promise<GeneratedImagePruneResult> {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0 || requiredBytes > this.maxBytes) {
      throw new GeneratedImageRetentionError(
        "image_pool_capacity_exhausted",
        "generated image reservation exceeds the pool limit",
      );
    }
    const artifacts = await this.scan();
    let remainingBytes = artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
    const removedArtifactIds: string[] = [];
    if (remainingBytes + requiredBytes > this.maxBytes) {
      const targetBeforeWrite = Math.max(0, this.targetBytes - requiredBytes);
      for (const artifact of artifacts) {
        if (remainingBytes <= targetBeforeWrite) break;
        if (protectedArtifactIds.has(artifact.artifactId)) continue;
        await this.removeDirectory(artifact.directory);
        remainingBytes = Math.max(0, remainingBytes - artifact.bytes);
        removedArtifactIds.push(artifact.artifactId);
      }
    }
    if (remainingBytes + requiredBytes > this.maxBytes) {
      throw new GeneratedImageRetentionError(
        "image_pool_capacity_exhausted",
        "generated image pool cannot satisfy the requested reservation",
      );
    }
    return {
      removedArtifactIds,
      remainingArtifacts: artifacts.length - removedArtifactIds.length,
      remainingBytes,
    };
  }

  private async scan(): Promise<StoredGeneratedImageArtifact[]> {
    const rootInfo = await lstat(this.root).catch(() => undefined);
    if (!rootInfo) return [];
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new GeneratedImageRetentionError(
        "unsafe_image_artifact_root",
        "generated image artifact root must be a real directory",
      );
    }
    const canonicalRoot = await realpath(this.root);
    const artifacts: StoredGeneratedImageArtifact[] = [];
    for (const year of await this.directories(this.root, SAFE_YEAR)) {
      for (const month of await this.directories(year, SAFE_MONTH)) {
        for (const directory of await this.directories(month, SAFE_ARTIFACT_ID)) {
          const canonical = await realpath(directory);
          if (!canonical.startsWith(`${canonicalRoot}${sep}`)) {
            throw new GeneratedImageRetentionError(
              "unsafe_image_artifact_root",
              "generated image artifact directory escaped its root",
            );
          }
          artifacts.push(await this.inspect(directory));
        }
      }
    }
    return artifacts.sort((left, right) =>
      left.createdAtMs - right.createdAtMs || left.artifactId.localeCompare(right.artifactId)
    );
  }

  private async directories(parent: string, acceptedName: RegExp): Promise<string[]> {
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && acceptedName.test(entry.name))
      .map((entry) => join(parent, entry.name))
      .sort();
  }

  private async inspect(directory: string): Promise<StoredGeneratedImageArtifact> {
    const artifactId = basename(directory);
    if (!SAFE_ARTIFACT_ID.test(artifactId)) {
      throw new GeneratedImageRetentionError(
        "unsafe_image_artifact_root",
        "generated image artifact id is unsafe",
      );
    }
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
      throw new GeneratedImageRetentionError(
        "unsafe_image_artifact_root",
        `generated image artifact ${artifactId} contains an unsafe entry`,
      );
    }
    const stats = await Promise.all(entries.map(async (entry) => await stat(join(directory, entry.name))));
    const bytes = stats.reduce((total, info) => total + info.size, 0);
    const fallbackCreatedAtMs = stats.length > 0
      ? Math.max(...stats.map((info) => info.mtimeMs))
      : (await stat(directory)).mtimeMs;
    let createdAtMs = fallbackCreatedAtMs;
    try {
      const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as unknown;
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        const value = metadata as Record<string, unknown>;
        const parsed = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
        if (Number.isFinite(parsed)) createdAtMs = parsed;
      }
    } catch {
      // Corrupt or partial artifacts remain eligible for oldest-first cleanup.
    }
    return { artifactId, directory, bytes, createdAtMs };
  }

  private async removeDirectory(directory: string): Promise<void> {
    const target = resolve(directory);
    if (!target.startsWith(`${this.root}${sep}`) || target === this.root) {
      throw new GeneratedImageRetentionError(
        "unsafe_image_artifact_root",
        "refusing to remove an unsafe generated image artifact path",
      );
    }
    await rm(target, { recursive: true, force: false });
  }
}
