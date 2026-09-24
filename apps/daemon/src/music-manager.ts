import type {
  MusicFavorite,
  MusicGenerationJob,
  MusicGenerationRequest,
  MusicGenerationResult,
  MusicGenerationStatus,
  MusicProvider,
  MusicProviderCapabilities,
} from "@larm/core";
import { musicArtifactMetadataSchema } from "@larm/core";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { MusicArtifactRetention } from "./music-artifact-retention";

type FetchLike = typeof fetch;

type AceStepResult = {
  file?: unknown;
  metas?: unknown;
  seed_value?: unknown;
  dit_model?: unknown;
  lm_model?: unknown;
};

export class MusicProviderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MusicProviderError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

export class AceStepMusicProvider implements MusicProvider {
  readonly id = "ace-step";
  readonly capabilities: MusicProviderCapabilities = {
    instrumental: true,
    vocals: true,
    lyrics: true,
    referenceAudio: false,
    remix: false,
    cover: false,
    repaint: false,
    stemSeparation: false,
    bpmControl: true,
    keyControl: true,
    maxDurationSeconds: 600,
    qualityProfile: "high",
    speedProfile: "fast",
  };
  private readonly base: URL;

  constructor(private readonly options: {
    endpoint: string;
    apiKey?: string;
    fetchImpl?: FetchLike;
    pollIntervalMs?: number;
    maxAudioBytes?: number;
    upstreamOutputRoot?: string;
  }) {
    this.base = new URL(options.endpoint);
    if (!new Set(["http:", "https:"]).has(this.base.protocol)) {
      throw new Error("ACE-Step endpoint must use http or https");
    }
    this.base.pathname = `${this.base.pathname.replace(/\/+$/, "")}/`;
    this.base.search = "";
    this.base.hash = "";
    if (options.upstreamOutputRoot && !isAbsolute(options.upstreamOutputRoot)) {
      throw new Error("ACE-Step upstream output root must be absolute");
    }
  }

  async load(): Promise<void> {
    const health = await this.health();
    if (!health.available) throw new MusicProviderError("provider_unavailable", health.reason!);
  }

  async unload(): Promise<void> {}

  async health(): Promise<{ available: boolean; reason?: string }> {
    try {
      const response = await this.request("health", { method: "GET", signal: AbortSignal.timeout(5_000) });
      return response.ok
        ? { available: true }
        : { available: false, reason: `ACE-Step health returned HTTP ${response.status}` };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async generate(request: MusicGenerationRequest, context: {
    jobId: string;
    signal: AbortSignal;
    phase: (phase: MusicGenerationStatus, progress?: number) => void;
  }) {
    if (request.referenceAudio) {
      throw new MusicProviderError(
        "unsupported_feature",
        "referenceAudio upload is not enabled for the ACE-Step provider yet",
      );
    }
    context.phase("loading");
    const quality = request.quality;
    const providerOptions = request.providerOptions ?? {};
    const payload = {
      ...providerOptions,
      prompt: request.prompt,
      lyrics: request.instrumental ? "[Instrumental]" : (request.lyrics ?? ""),
      audio_duration: request.durationSeconds,
      audio_format: request.outputFormat,
      thinking: quality !== "fast",
      inference_steps: quality === "fast" ? 4 : quality === "high" ? 12 : 8,
      batch_size: 1,
      ...(request.language ? { vocal_language: request.language } : {}),
      ...(request.bpm ? { bpm: request.bpm } : {}),
      ...(request.key ? { key_scale: request.key } : {}),
      ...(request.timeSignature
        ? { time_signature: request.timeSignature.split("/")[0] }
        : {}),
      ...(request.seed === undefined
        ? { use_random_seed: true }
        : { use_random_seed: false, seed: request.seed }),
      ...(request.model ? { model: request.model } : {}),
    };
    const started = Date.now();
    const submitted = await this.json("release_task", payload, context.signal);
    const taskId = record(submitted.data)?.task_id;
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new MusicProviderError("invalid_upstream_response", "ACE-Step did not return a task_id");
    }

    context.phase("generating");
    let item: Record<string, unknown> | undefined;
    while (!context.signal.aborted) {
      const queried = await this.json("query_result", { task_id_list: [taskId] }, context.signal);
      item = Array.isArray(queried.data) ? record(queried.data[0]) : undefined;
      if (item?.status === 1) break;
      if (item?.status === 2) {
        throw new MusicProviderError("generation_failed", "ACE-Step generation failed");
      }
      await sleep(this.options.pollIntervalMs ?? 1_000, context.signal);
    }
    if (!item) throw new MusicProviderError("invalid_upstream_response", "ACE-Step result is missing");

    let parsedResults: unknown;
    try {
      parsedResults = typeof item.result === "string" ? JSON.parse(item.result) : item.result;
    } catch {
      throw new MusicProviderError("invalid_upstream_response", "ACE-Step result is invalid JSON");
    }
    const first = Array.isArray(parsedResults) ? record(parsedResults[0]) as AceStepResult | undefined : undefined;
    if (!first || typeof first.file !== "string") {
      throw new MusicProviderError("invalid_upstream_response", "ACE-Step result has no audio file");
    }

    context.phase("encoding");
    const audioUrl = new URL(first.file, this.base);
    if (audioUrl.origin !== this.base.origin) {
      throw new MusicProviderError("invalid_upstream_response", "ACE-Step returned a cross-origin audio URL");
    }
    const audioResponse = await (this.options.fetchImpl ?? fetch)(audioUrl, {
      headers: this.headers(),
      signal: context.signal,
      redirect: "error",
    });
    if (!audioResponse.ok) {
      throw new MusicProviderError("audio_download_failed", `ACE-Step audio returned HTTP ${audioResponse.status}`);
    }
    const declaredBytes = Number(audioResponse.headers.get("content-length") ?? 0);
    const maxBytes = this.options.maxAudioBytes ?? 512 * 1024 * 1024;
    if (declaredBytes > maxBytes) throw new MusicProviderError("audio_too_large", "generated audio is too large");
    const audio = new Uint8Array(await audioResponse.arrayBuffer());
    if (audio.byteLength === 0 || audio.byteLength > maxBytes) {
      throw new MusicProviderError("audio_too_large", "generated audio is empty or too large");
    }
    const upstreamArtifactCleanup = await this.removeUpstreamArtifact(audioUrl);
    const metas = record(first.metas) ?? {};
    const durationSeconds = typeof metas.duration === "number" && metas.duration > 0
      ? metas.duration
      : request.durationSeconds;
    const seedText = typeof first.seed_value === "string" ? first.seed_value.split(",")[0] : undefined;
    const actualSeed = seedText && /^\d+$/.test(seedText) ? Number(seedText) : request.seed;
    const generationTimeMs = Date.now() - started;
    return {
      model: typeof first.dit_model === "string"
        ? first.dit_model
        : (request.model ?? "acestep-v15-turbo"),
      audio,
      durationSeconds,
      format: request.outputFormat,
      ...(actualSeed === undefined ? {} : { seed: actualSeed }),
      generationTimeMs,
      realtimeFactor: generationTimeMs / 1_000 / durationSeconds,
      metadata: {
        upstreamTaskId: taskId,
        upstreamArtifactCleanup,
        ...(typeof first.lm_model === "string" ? { lmModel: first.lm_model } : {}),
        ...metas,
      },
    };
  }

  private async removeUpstreamArtifact(audioUrl: URL): Promise<"removed" | "not_configured" | "not_applicable" | "failed"> {
    const configuredRoot = this.options.upstreamOutputRoot;
    if (!configuredRoot) return "not_configured";
    const rawPath = audioUrl.searchParams.get("path");
    if (!rawPath || !isAbsolute(rawPath)) return "not_applicable";
    try {
      const root = resolve(configuredRoot);
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return "failed";
      const candidate = resolve(rawPath);
      if (candidate === root || !candidate.startsWith(`${root}${sep}`)) return "not_applicable";
      const candidateInfo = await lstat(candidate);
      if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) return "failed";
      const [canonicalRoot, canonicalCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
      if (!canonicalCandidate.startsWith(`${canonicalRoot}${sep}`)) return "failed";
      await rm(candidate, { force: false });
      return "removed";
    } catch {
      return "failed";
    }
  }

  private headers(): Record<string, string> {
    return {
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
    };
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    return (this.options.fetchImpl ?? fetch)(new URL(path, this.base), {
      ...init,
      redirect: "error",
      headers: { ...this.headers(), ...init.headers },
    });
  }

  private async json(path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new MusicProviderError("upstream_error", `ACE-Step ${path} returned HTTP ${response.status}`);
    }
    const value = record(await response.json());
    if (!value || (typeof value.code === "number" && value.code !== 200)) {
      throw new MusicProviderError("invalid_upstream_response", `ACE-Step ${path} returned an error`);
    }
    return value;
  }
}

type InternalJob = MusicGenerationJob & {
  request: MusicGenerationRequest;
  abort: AbortController;
  audioPath?: string;
  metadataPath?: string;
  favorite?: boolean;
  favoritedAt?: string;
};

export class MusicGenerationManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queue: string[] = [];
  private readonly listeners = new Map<string, Set<(job: MusicGenerationJob) => void>>();
  private readonly retention: MusicArtifactRetention;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private running = 0;
  constructor(readonly provider: MusicProvider, private readonly options: {
    artifactRoot: string;
    concurrency?: number;
    now?: () => number;
    random?: () => string;
    retentionMs?: number;
    wavRetentionMs?: number;
    maxArtifactBytes?: number;
    favoriteMaxArtifactBytes?: number;
    pruneIntervalMs?: number;
  }) {
    this.retention = new MusicArtifactRetention({
      artifactRoot: options.artifactRoot,
      retentionMs: options.retentionMs ?? 24 * 60 * 60 * 1_000,
      wavRetentionMs: options.wavRetentionMs ?? 60 * 60 * 1_000,
      maxBytes: options.maxArtifactBytes ?? 50 * 1024 * 1024 * 1024,
      favoriteMaxBytes: options.favoriteMaxArtifactBytes ?? 30 * 1024 * 1024 * 1024,
      now: options.now,
    });
  }

  async initialize(): Promise<void> {
    await mkdir(this.options.artifactRoot, { recursive: true, mode: 0o750 });
    await this.pruneArtifacts();
    await this.recoverStoredJobs();
    this.pruneTimer = setInterval(
      () => void this.pruneArtifacts().catch((error) => {
        console.warn(`music artifact pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      }),
      this.options.pruneIntervalMs ?? 5 * 60 * 1_000,
    );
    this.pruneTimer.unref?.();
  }

  close(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
  }

  async pruneArtifacts(): Promise<string[]> {
    const protectedJobIds = new Set([...this.jobs.values()]
      .filter((job) => !["completed", "failed", "cancelled"].includes(job.status))
      .map((job) => job.jobId));
    const removed = await this.retention.prune(protectedJobIds);
    for (const jobId of removed) {
      this.jobs.delete(jobId);
      this.listeners.delete(jobId);
    }
    return removed;
  }

  listFavorites(): MusicFavorite[] {
    return [...this.jobs.values()]
      .filter((job) => job.status === "completed" && job.result && job.favorite && job.favoritedAt)
      .map((job) => this.favoriteView(job))
      .sort((left, right) => right.favoritedAt.localeCompare(left.favoritedAt));
  }

  getFavorite(jobId: string): MusicFavorite | undefined {
    const job = this.jobs.get(jobId);
    return job?.status === "completed" && job.result && job.favorite && job.favoritedAt
      ? this.favoriteView(job)
      : undefined;
  }

  async favorite(jobId: string): Promise<MusicFavorite | undefined> {
    const job = this.jobs.get(jobId);
    if (job?.status !== "completed" || !job.result || !job.metadataPath) return undefined;
    const metadata = musicArtifactMetadataSchema.parse(JSON.parse(await readFile(job.metadataPath, "utf8")));
    const favoritedAt = job.favoritedAt ?? this.isoNow();
    const updated = { ...metadata, favorite: true, favoritedAt };
    const temporary = `${job.metadataPath}.favorite.tmp`;
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o640 });
    await rename(temporary, job.metadataPath);
    job.favorite = true;
    job.favoritedAt = favoritedAt;
    void this.pruneArtifacts().catch((error) => {
      console.warn(`music artifact pruning failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.favoriteView(job);
  }

  async unfavorite(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (job?.status !== "completed" || !job.metadataPath) return false;
    const metadata = musicArtifactMetadataSchema.parse(JSON.parse(await readFile(job.metadataPath, "utf8")));
    const { favoritedAt: _favoritedAt, ...updated } = { ...metadata, favorite: false };
    const temporary = `${job.metadataPath}.favorite.tmp`;
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o640 });
    await rename(temporary, job.metadataPath);
    job.favorite = false;
    delete job.favoritedAt;
    void this.pruneArtifacts().catch((error) => {
      console.warn(`music artifact pruning failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return true;
  }

  create(request: MusicGenerationRequest): MusicGenerationJob {
    const now = this.isoNow();
    const jobId = `music_${this.options.random?.() ?? crypto.randomUUID()}`;
    const job: InternalJob = {
      jobId,
      status: "queued",
      phase: "queued",
      createdAt: now,
      updatedAt: now,
      request,
      abort: new AbortController(),
    };
    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    queueMicrotask(() => void this.drain());
    return this.publicJob(job);
  }

  get(jobId: string): MusicGenerationJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.publicJob(job) : undefined;
  }

  subscribe(jobId: string, listener: (job: MusicGenerationJob) => void): (() => void) | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const listeners = this.listeners.get(jobId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(jobId, listeners);
    listener(this.publicJob(job));
    if (["completed", "failed", "cancelled"].includes(job.status)) listeners.delete(listener);
    return () => listeners.delete(listener);
  }

  async cancel(jobId: string): Promise<MusicGenerationJob | undefined> {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (["completed", "failed", "cancelled"].includes(job.status)) return this.publicJob(job);
    job.abort.abort(new Error("cancelled"));
    await this.provider.cancel?.(jobId);
    this.transition(job, "cancelled");
    return this.publicJob(job);
  }

  artifact(jobId: string, kind: "audio" | "metadata", favoriteOnly = false):
    { path: string; contentType: string; filename: string } | undefined {
    const job = this.jobs.get(jobId);
    if (job?.status !== "completed" || !job.result || (favoriteOnly && !job.favorite)) return undefined;
    if (kind === "metadata" && job.metadataPath) {
      return { path: job.metadataPath, contentType: "application/json; charset=utf-8", filename: "metadata.json" };
    }
    if (!job.audioPath) return undefined;
    const contentTypes = { wav: "audio/wav", flac: "audio/flac", mp3: "audio/mpeg" };
    return {
      path: job.audioPath,
      contentType: contentTypes[job.result.format],
      filename: `output.${job.result.format}`,
    };
  }

  private async drain(): Promise<void> {
    const concurrency = this.options.concurrency ?? 1;
    while (this.running < concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.status === "cancelled") continue;
      this.running++;
      void this.run(job).finally(() => {
        this.running--;
        void this.drain();
      });
    }
  }

  private async run(job: InternalJob): Promise<void> {
    try {
      const generated = await this.provider.generate(job.request, {
        jobId: job.jobId,
        signal: job.abort.signal,
        phase: (phase, progress) => this.transition(job, phase, progress),
      });
      if (job.abort.signal.aborted || job.status === "cancelled") return;
      const date = new Date(this.options.now?.() ?? Date.now());
      const directory = join(
        this.options.artifactRoot,
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, "0"),
        job.jobId,
      );
      await mkdir(directory, { recursive: true, mode: 0o750 });
      const audioPath = join(directory, `output.${generated.format}`);
      const metadataPath = join(directory, "metadata.json");
      const audioTmp = `${audioPath}.tmp`;
      const metadataTmp = `${metadataPath}.tmp`;
      const { audio, ...providerResult } = generated;
      const result: MusicGenerationResult = {
        id: job.jobId,
        provider: this.provider.id,
        ...providerResult,
        audioUrl: `/v1/music/generations/${encodeURIComponent(job.jobId)}/audio`,
        metadataUrl: `/v1/music/generations/${encodeURIComponent(job.jobId)}/metadata`,
      };
      const metadata = {
        ...result,
        audioFile: `output.${generated.format}`,
        prompt: job.request.prompt,
        ...(job.request.lyrics ? { lyrics: job.request.lyrics } : {}),
        request: job.request,
        createdAt: job.createdAt,
        favorite: false,
      };
      await writeFile(audioTmp, audio, { mode: 0o640 });
      await writeFile(metadataTmp, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o640 });
      if (job.abort.signal.aborted) {
        await Promise.all([
          rm(audioTmp, { force: true }),
          rm(metadataTmp, { force: true }),
        ]);
        return;
      }
      await rename(audioTmp, audioPath);
      await rename(metadataTmp, metadataPath);
      job.audioPath = audioPath;
      job.metadataPath = metadataPath;
      job.result = result;
      this.transition(job, "completed", 1);
      void this.pruneArtifacts().catch((error) => {
        console.warn(`music artifact pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      if (job.abort.signal.aborted || job.status === "cancelled") return;
      job.error = {
        code: error instanceof MusicProviderError ? error.code : "generation_failed",
        message: error instanceof Error ? error.message : String(error),
      };
      this.transition(job, "failed");
    }
  }

  private transition(job: InternalJob, status: MusicGenerationStatus, progress?: number): void {
    if (job.status === "cancelled") return;
    job.status = status;
    job.phase = status;
    job.updatedAt = this.isoNow();
    if (progress === undefined) delete job.progress;
    else job.progress = progress;
    const publicJob = this.publicJob(job);
    for (const listener of this.listeners.get(job.jobId) ?? []) listener(publicJob);
  }

  private publicJob(job: InternalJob): MusicGenerationJob {
    const {
      request: _request,
      abort: _abort,
      audioPath: _audio,
      metadataPath: _metadata,
      favorite: _favorite,
      favoritedAt: _favoritedAt,
      ...value
    } = job;
    return structuredClone(value);
  }

  private favoriteView(job: InternalJob): MusicFavorite {
    const result = job.result!;
    return {
      jobId: job.jobId,
      audioUrl: `/v1/music/favorites/${encodeURIComponent(job.jobId)}/audio`,
      metadataUrl: `/v1/music/favorites/${encodeURIComponent(job.jobId)}/metadata`,
      format: result.format,
      durationSeconds: result.durationSeconds,
      model: result.model,
      createdAt: job.createdAt,
      favoritedAt: job.favoritedAt!,
    };
  }

  private async recoverStoredJobs(): Promise<void> {
    for (const artifact of await this.retention.list()) {
      try {
        const metadataPath = join(artifact.directory, "metadata.json");
        const metadata = musicArtifactMetadataSchema.parse(JSON.parse(await readFile(metadataPath, "utf8")));
        if (metadata.audioFile !== `output.${metadata.format}`) continue;
        const {
          audioFile: _audioFile,
          prompt: _prompt,
          lyrics: _lyrics,
          request,
          createdAt,
          favorite,
          favoritedAt,
          ...result
        } = metadata;
        this.jobs.set(metadata.id, {
          jobId: metadata.id,
          status: "completed",
          phase: "completed",
          progress: 1,
          createdAt,
          updatedAt: favoritedAt ?? createdAt,
          request,
          abort: new AbortController(),
          audioPath: join(artifact.directory, metadata.audioFile),
          metadataPath,
          result,
          favorite,
          ...(favoritedAt ? { favoritedAt } : {}),
        });
      } catch {
        // Corrupt or partial artifacts remain eligible for bounded retention cleanup.
      }
    }
  }

  private isoNow(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }
}
