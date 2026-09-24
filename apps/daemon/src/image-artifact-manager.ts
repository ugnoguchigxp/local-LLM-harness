import { mkdir, lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  imageArtifactSchema,
  storedImageArtifactMetadataSchema,
  type ImageArtifact,
  type ImageArtifactList,
  type StoredImageArtifactMetadata,
} from "@larm/core";
import {
  GeneratedImageArtifactRetention,
  type GeneratedImagePruneResult,
} from "@larm/backends";

const MAX_METADATA_BYTES = 64 * 1024;

export type ImageArtifactContent = {
  path: string;
  filename: string;
  mimeType: "image/webp" | "image/png";
  bytes: number;
  sha256: string;
};

export class ImageArtifactManager {
  private readonly retention: GeneratedImageArtifactRetention;
  private timer?: ReturnType<typeof setInterval>;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    readonly artifactRoot: string,
    options: {
      maxBytes?: number;
      targetBytes?: number;
      pruneIntervalMs?: number;
    } = {},
  ) {
    this.retention = new GeneratedImageArtifactRetention({
      artifactRoot,
      maxBytes: options.maxBytes,
      targetBytes: options.targetBytes,
    });
    const intervalMs = options.pruneIntervalMs ?? 5 * 60 * 1_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
      throw new Error("generated image prune interval is invalid");
    }
    this.timer = setInterval(() => {
      void this.prune().catch((error) => {
        console.warn(`generated image pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  async initialize(): Promise<GeneratedImagePruneResult> {
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    return await this.prune();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async prune(requiredBytes = 0, protectedArtifactIds = new Set<string>()): Promise<GeneratedImagePruneResult> {
    return await this.serialized(async () =>
      await this.retention.prune(requiredBytes, protectedArtifactIds)
    );
  }

  async list(): Promise<ImageArtifactList> {
    return await this.serialized(async () => {
      const images: ImageArtifact[] = [];
      const storedArtifacts = await this.retention.list();
      for (const stored of storedArtifacts) {
        const metadata = await this.readMetadata(stored.directory, stored.artifactId);
        if (!metadata) continue;
        images.push(this.publicArtifact(metadata));
      }
      return {
        images: images.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
        totalBytes: storedArtifacts.reduce((total, artifact) => total + artifact.bytes, 0),
        maxBytes: this.retention.maxBytes,
        targetBytes: this.retention.targetBytes,
      };
    });
  }

  async get(artifactId: string): Promise<ImageArtifact | undefined> {
    return await this.serialized(async () => {
      const artifact = (await this.retention.list()).find((candidate) => candidate.artifactId === artifactId);
      if (!artifact) return undefined;
      const metadata = await this.readMetadata(artifact.directory, artifactId);
      return metadata ? this.publicArtifact(metadata) : undefined;
    });
  }

  async content(artifactId: string): Promise<ImageArtifactContent | undefined> {
    return await this.serialized(async () => {
      const artifact = (await this.retention.list()).find((candidate) => candidate.artifactId === artifactId);
      if (!artifact) return undefined;
      const metadata = await this.readMetadata(artifact.directory, artifactId);
      if (!metadata) return undefined;
      const path = join(artifact.directory, metadata.file);
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || info.size !== metadata.bytes) return undefined;
      const [canonicalRoot, canonicalPath] = await Promise.all([
        realpath(resolve(this.artifactRoot)),
        realpath(path),
      ]);
      if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) return undefined;
      return {
        path: canonicalPath,
        filename: metadata.file,
        mimeType: metadata.mimeType,
        bytes: metadata.bytes,
        sha256: metadata.sha256,
      };
    });
  }

  async delete(artifactId: string): Promise<boolean> {
    return await this.serialized(async () => await this.retention.remove(artifactId));
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.operationTail.then(operation, operation);
    this.operationTail = running.then(() => undefined, () => undefined);
    return await running;
  }

  private publicArtifact(metadata: StoredImageArtifactMetadata): ImageArtifact {
    const { file: _file, ...publicMetadata } = metadata;
    return imageArtifactSchema.parse({
      ...publicMetadata,
      contentUrl: `/v1/image-artifacts/${encodeURIComponent(metadata.id)}/content`,
    });
  }

  private async readMetadata(
    directory: string,
    expectedArtifactId: string,
  ): Promise<StoredImageArtifactMetadata | undefined> {
    try {
      const path = join(directory, "metadata.json");
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_METADATA_BYTES) return undefined;
      const value = storedImageArtifactMetadataSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      return value.success && value.data.id === expectedArtifactId ? value.data : undefined;
    } catch {
      return undefined;
    }
  }
}
