import { lstat, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { MusicProviderError } from "./music-errors";

export type StoredArtifact = {
  jobId: string;
  directory: string;
  format: "wav" | "flac" | "mp3" | "opus";
  bytes: number;
  createdAtMs: number;
  favorite: boolean;
  complete: boolean;
  favoritedAtMs?: number;
};

export type MusicArtifactRetentionOptions = {
  artifactRoot: string;
  retentionMs: number;
  wavRetentionMs: number;
  maxBytes: number;
  favoriteMaxBytes: number;
  now?: () => number;
};

export class MusicArtifactRetention {
  private readonly root: string;

  constructor(private readonly options: MusicArtifactRetentionOptions) {
    if (!isAbsolute(options.artifactRoot)) {
      throw new Error("music artifact root must be absolute");
    }
    this.root = resolve(options.artifactRoot);
  }

  async prune(protectedJobIds = new Set<string>()): Promise<string[]> {
    const artifacts = await this.scan();
    const now = this.options.now?.() ?? Date.now();
    const expired = new Set(artifacts.filter((artifact) => {
      if (protectedJobIds.has(artifact.jobId)) return false;
      if (!artifact.complete) return artifact.createdAtMs + 86_400_000 <= now;
      if (artifact.favorite) return false;
      if (this.options.retentionMs === 0) return false;
      const retentionMs = artifact.format === "wav"
        ? Math.min(this.options.retentionMs, this.options.wavRetentionMs)
        : this.options.retentionMs;
      return artifact.createdAtMs + retentionMs <= now;
    }).map((artifact) => artifact.jobId));

    const removed: string[] = [];
    for (const artifact of artifacts) {
      if (!expired.has(artifact.jobId)) continue;
      await this.removeDirectory(artifact.directory);
      removed.push(artifact.jobId);
    }
    return removed;
  }

  async list(): Promise<readonly StoredArtifact[]> {
    return await this.scan();
  }

  // The caller serializes this check with writes, deletions and favorite changes.
  // A full library rejects new data instead of evicting a saved song.
  async assertCapacity(bytes: number, favorite: boolean, replacingJobId?: string): Promise<void> {
    const artifacts = (await this.scan()).filter((artifact) => artifact.jobId !== replacingJobId);
    const total = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) + bytes;
    const bucket = artifacts.filter((artifact) => artifact.favorite === favorite)
      .reduce((sum, artifact) => sum + artifact.bytes, 0) + bytes;
    const limit = favorite ? this.options.favoriteMaxBytes : this.options.maxBytes - this.options.favoriteMaxBytes;
    if (total > this.options.maxBytes || bucket > limit) {
      throw new MusicProviderError("music_storage_full", "music storage is full; delete unwanted tracks or increase the storage limit");
    }
  }

  private async scan(): Promise<StoredArtifact[]> {
    const rootInfo = await lstat(this.root).catch(() => undefined);
    if (!rootInfo) return [];
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("music artifact root must be a real directory");
    }
    const canonicalRoot = await realpath(this.root);
    const artifacts: StoredArtifact[] = [];
    for (const year of await this.directories(this.root)) {
      for (const month of await this.directories(year)) {
        for (const directory of await this.directories(month)) {
          const canonical = await realpath(directory);
          if (!canonical.startsWith(`${canonicalRoot}${sep}`)) {
            throw new Error("music artifact directory escaped its root");
          }
          const artifact = await this.inspect(directory);
          if (artifact) artifacts.push(artifact);
        }
      }
    }
    return artifacts.sort((left, right) =>
      left.createdAtMs - right.createdAtMs || left.jobId.localeCompare(right.jobId)
    );
  }

  private async directories(parent: string): Promise<string[]> {
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => join(parent, entry.name))
      .sort();
  }

  private async inspect(directory: string): Promise<StoredArtifact | undefined> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink());
    const observed = await Promise.all(files.map(async (entry) => {
      const info = await stat(join(directory, entry.name)).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      return info ? { name: entry.name, info } : undefined;
    }));
    const stats = observed.filter((entry) => entry !== undefined);
    if (stats.length === 0) return undefined;
    const fallbackId = basename(directory);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(fallbackId)) return undefined;
    const fallbackFormat = stats.some(({ name }) => name === "output.wav")
      ? "wav"
      : stats.some(({ name }) => name === "output.flac") ? "flac"
      : stats.some(({ name }) => name === "output.opus") ? "opus" : "mp3";
    const fallback = {
      jobId: fallbackId,
      directory,
      format: fallbackFormat as StoredArtifact["format"],
      bytes: stats.reduce((total, entry) => total + entry.info.size, 0),
      createdAtMs: Math.max(...stats.map((entry) => entry.info.mtimeMs)),
      favorite: false,
      complete: false,
    };
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
    } catch {
      return fallback;
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return fallback;
    const value = metadata as Record<string, unknown>;
    const jobId = value.id;
    const format = value.format;
    if (
      typeof jobId !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(jobId)
      || (format !== "wav" && format !== "flac" && format !== "mp3" && format !== "opus")
    ) return fallback;
    const audio = join(directory, `output.${format}`);
    const [audioStat, metadataStat] = await Promise.all([
      stat(audio).catch(() => undefined),
      stat(join(directory, "metadata.json")).catch(() => undefined),
    ]);
    if (!audioStat?.isFile() || !metadataStat?.isFile()) return fallback;
    const parsedCreatedAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
    return {
      jobId,
      directory,
      format,
      bytes: fallback.bytes,
      createdAtMs: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : audioStat.mtimeMs,
      favorite: value.favorite === true,
      complete: true,
      ...(typeof value.favoritedAt === "string" && Number.isFinite(Date.parse(value.favoritedAt))
        ? { favoritedAtMs: Date.parse(value.favoritedAt) }
        : {}),
    };
  }

  private async removeDirectory(directory: string): Promise<void> {
    const parent = resolve(directory);
    if (!parent.startsWith(`${this.root}${sep}`) || parent === this.root) {
      throw new Error("refusing to remove an unsafe music artifact path");
    }
    await rm(parent, { recursive: true, force: false });
  }
}
