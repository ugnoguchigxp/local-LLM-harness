import type {
  MusicFavorite,
  MusicFavoriteQuery,
  MusicGenerationJob,
  MusicGenerationRequest,
  MusicGenerationResult,
  MusicGenerationStatus,
  MusicProvider,
  MusicProviderCapabilities,
  MusicTrack,
  MusicTrackQuery,
  MusicTagQuery,
} from "@larm/core";
import { deriveMusicTags, listMusicTags, listMusicTracks, paginateMusicFavorites, musicTrackMatches, musicTrackTagsMatch, musicArtifactMetadataSchema, musicGenerationJobSchema, musicGenerationRequestSchema } from "@larm/core";
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { MusicArtifactRetention } from "./music-artifact-retention";
import { encodeMusicOpus, verifyMusicOpusEncoder } from "./music-audio";
import { MediaVariantStopError, type MediaVariantManager } from "@larm/backends";

type FetchLike = typeof fetch;

type AceStepResult = {
  file?: unknown;
  metas?: unknown;
  seed_value?: unknown;
  dit_model?: unknown;
  lm_model?: unknown;
};

export { MusicProviderError } from "./music-errors";
import { MusicProviderError } from "./music-errors";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
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

  async unload(): Promise<void> {
    // Called only after the on-demand worker has stopped, including cancellation.
    const root = this.options.upstreamOutputRoot;
    if (!root) return;
    const info = await lstat(root).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new MusicProviderError("intermediate_cleanup_failed", "ACE-Step output root must be a real directory");
    }
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(wav|flac|mp3|opus|aac)$/.test(entry.name)) continue;
      const url = new URL("v1/audio", this.base);
      url.searchParams.set("path", join(root, entry.name));
      if (await this.removeUpstreamArtifact(url) !== "removed") {
        throw new MusicProviderError("intermediate_cleanup_failed", "could not remove ACE-Step intermediate audio");
      }
    }
  }

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
    const isOpus = request.outputFormat === "opus";
    if (isOpus) {
      if (!this.options.upstreamOutputRoot) {
        throw new MusicProviderError("intermediate_cleanup_required", "Opus output requires an ACE-Step output root for intermediate cleanup");
      }
      try { await verifyMusicOpusEncoder(); }
      catch { throw new MusicProviderError("audio_encoder_unavailable", "music Opus output requires ffmpeg with libopus"); }
    }
    context.signal.throwIfAborted();
    context.phase("loading");
    const quality = request.quality;
    const providerOptions = request.providerOptions ?? {};
    const payload = {
      ...providerOptions,
      prompt: request.prompt,
      lyrics: request.instrumental ? "[Instrumental]" : (request.lyrics ?? ""),
      audio_duration: request.durationSeconds,
      audio_format: isOpus ? "wav32" : request.outputFormat,
      // Quality changes diffusion steps; this runtime has no auxiliary LM.
      thinking: false,
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
      model: request.model === "ace-step-1.5" ? "acestep-v15-turbo" : (request.model ?? "acestep-v15-turbo"),
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
    let audio: Uint8Array;
    let upstreamArtifactCleanup: Awaited<ReturnType<AceStepMusicProvider["removeUpstreamArtifact"]>>;
    try {
      const waveform = await this.downloadAudio(audioUrl, context.signal);
      if (isOpus) {
        try { audio = await encodeMusicOpus(waveform, context.signal, this.options.maxAudioBytes ?? 512 * 1024 * 1024); }
        catch (error) {
          context.signal.throwIfAborted();
          throw new MusicProviderError("audio_encoding_failed", error instanceof Error ? error.message : "music Opus encoding failed");
        }
      } else audio = waveform;
    } finally {
      upstreamArtifactCleanup = await this.removeUpstreamArtifact(audioUrl);
      if (isOpus && upstreamArtifactCleanup !== "removed") {
        throw new MusicProviderError("intermediate_cleanup_failed", "could not remove ACE-Step intermediate audio");
      }
    }
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
        ...(typeof first.lm_model === "string" ? { lmModel: first.lm_model } : {}),
        ...metas,
        upstreamTaskId: taskId,
        upstreamArtifactCleanup,
        ...(isOpus ? { encoding: { codec: "opus", container: "ogg", bitrateBps: 128_000,
          bitrateMode: "vbr", sampleRateHz: 48_000, intermediateFormat: "wav32" } } : {}),
      },
    };
  }

  private async downloadAudio(audioUrl: URL, signal: AbortSignal): Promise<Uint8Array> {
    const audioResponse = await (this.options.fetchImpl ?? fetch)(audioUrl, {
      headers: this.headers(),
      signal,
      redirect: "error",
    });
    if (!audioResponse.ok) {
      throw new MusicProviderError("audio_download_failed", `ACE-Step audio returned HTTP ${audioResponse.status}`);
    }
    const declaredBytes = Number(audioResponse.headers.get("content-length") ?? 0);
    const maxBytes = this.options.maxAudioBytes ?? 512 * 1024 * 1024;
    if (declaredBytes > maxBytes) {
      await audioResponse.body?.cancel();
      throw new MusicProviderError("audio_too_large", "generated audio is too large");
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = audioResponse.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) throw new MusicProviderError("audio_too_large", "generated audio is too large");
          chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    }
    const audio = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.byteLength; }
    if (audio.byteLength === 0 || audio.byteLength > maxBytes) {
      throw new MusicProviderError("audio_too_large", "generated audio is empty or too large");
    }
    return audio;
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

export class OnDemandMusicProvider implements MusicProvider {
  readonly id: string;
  readonly capabilities: MusicProviderCapabilities;

  constructor(private readonly upstream: MusicProvider, private readonly variants: MediaVariantManager) {
    this.id = upstream.id;
    this.capabilities = upstream.capabilities;
  }

  async load(): Promise<void> {}
  async unload(): Promise<void> { await this.upstream.unload(); }
  async health(): Promise<{ available: boolean; reason?: string }> {
    return { available: this.variants.available, ...(!this.variants.available ? { reason: "media runtime unavailable" } : {}) };
  }
  async cancel(jobId: string): Promise<void> {
    await this.upstream.cancel?.(jobId);
  }
  async generate(request: MusicGenerationRequest, context: Parameters<MusicProvider["generate"]>[1]) {
    context.phase("loading");
    const stopWorker = await this.variants.waitForMusic(context.signal);
    const release = async () => { await stopWorker(); await this.upstream.unload(); };
    try {
      context.signal.throwIfAborted();
      return { ...await this.upstream.generate(request, context), release };
    } catch (error) {
      await release();
      throw error;
    }
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
  private readonly workloadFinishes = new Map<string, () => void>();
  private readonly listeners = new Map<string, Set<(job: MusicGenerationJob) => void>>();
  private readonly retention: MusicArtifactRetention;
  private pruneTimer?: ReturnType<typeof setInterval>;
  private running = 0;
  private readonly runningJobs = new Map<string, Promise<void>>();
  private closed = false;
  private storageChain: Promise<void> = Promise.resolve();
  constructor(readonly provider: MusicProvider, private readonly options: {
    artifactRoot: string;
    beginWorkload?: () => () => void;
    concurrency?: number;
    now?: () => number;
    random?: () => string;
    retentionMs?: number;
    wavRetentionMs?: number;
    maxArtifactBytes?: number;
    favoriteMaxArtifactBytes?: number;
    pruneIntervalMs?: number;
    queueTimeoutMs?: number;
  }) {
    this.retention = new MusicArtifactRetention({
      artifactRoot: options.artifactRoot,
      retentionMs: options.retentionMs ?? 0,
      wavRetentionMs: options.wavRetentionMs ?? 60 * 60 * 1_000,
      maxBytes: options.maxArtifactBytes ?? 50 * 1024 * 1024 * 1024,
      favoriteMaxBytes: options.favoriteMaxArtifactBytes ?? 30 * 1024 * 1024 * 1024,
      now: options.now,
    });
  }

  async initialize(): Promise<void> {
    mkdirSync(join(this.options.artifactRoot, "jobs"), { recursive: true, mode: 0o750 });
    await mkdir(this.options.artifactRoot, { recursive: true, mode: 0o750 });
    for (const entry of await readdir(this.options.artifactRoot, { withFileTypes: true })) {
      const match = /^\.deleted-(music_[a-zA-Z0-9._-]+)$/.exec(entry.name);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      await rm(join(this.options.artifactRoot, "jobs", `${match[1]}.json`), { force: true });
      await rm(join(this.options.artifactRoot, entry.name), { recursive: true, force: true });
    }
    await this.pruneArtifacts();
    await this.recoverStoredJobs();
    for (const file of readdirSync(join(this.options.artifactRoot, "jobs"))) {
      if (!/^music_[a-zA-Z0-9._-]+\.json$/.test(file)) continue;
      try {
        const saved = JSON.parse(readFileSync(join(this.options.artifactRoot, "jobs", file), "utf8"));
        const publicJob = musicGenerationJobSchema.parse(this.publicJob(saved));
        if (file !== `${publicJob.jobId}.json`) continue;
        const artifact = this.jobs.get(publicJob.jobId);
        if (!artifact && (this.options.now?.() ?? Date.now()) - Date.parse(publicJob.updatedAt) >= (this.options.retentionMs || 86_400_000)) {
          await rm(join(this.options.artifactRoot, "jobs", file), { force: true });
          continue;
        }
        const job: InternalJob = { ...publicJob, ...(artifact ? { result: artifact.result, audioPath: artifact.audioPath, metadataPath: artifact.metadataPath, favorite: artifact.favorite, favoritedAt: artifact.favoritedAt } : {}), request: musicGenerationRequestSchema.parse(saved.request), abort: new AbortController() };
        if (!["failed", "cancelled"].includes(job.status) && !(job.status === "completed" && artifact)) {
          job.status = "failed"; job.phase = "failed";
          if (!artifact) delete job.result;
          job.error = { code: "generation_interrupted", message: "generation interrupted by daemon restart; not resubmitted" };
        }
        this.jobs.set(job.jobId, job);
        this.persist(job);
      } catch (error) {
        console.warn(`music job recovery skipped invalid record: ${file}`);
      }
    }
    this.pruneTimer = setInterval(
      () => void this.pruneArtifacts().catch((error) => {
        console.warn(`music artifact pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      }),
      this.options.pruneIntervalMs ?? 5 * 60 * 1_000,
    );
    this.pruneTimer.unref?.();
  }

  close(): void {
    this.closed = true;
    for (const job of this.jobs.values()) {
      if (!["completed", "failed", "cancelled"].includes(job.status)) job.abort.abort(new Error("daemon shutting down"));
    }
    for (const id of this.queue.splice(0)) {
      const job = this.jobs.get(id);
      if (job) this.transition(job, "cancelled");
    }
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
  }

  async pruneArtifacts(): Promise<string[]> {
    return this.withStorage(async () => {
      const protectedJobIds = new Set([...this.jobs.values()]
        .filter((job) => !["completed", "failed", "cancelled"].includes(job.status))
        .map((job) => job.jobId));
      const removed = await this.retention.prune(protectedJobIds);
      for (const jobId of removed) {
        this.jobs.delete(jobId);
        this.listeners.delete(jobId);
        await rm(join(this.options.artifactRoot, "jobs", `${jobId}.json`), { force: true });
      }
      for (const [id, job] of this.jobs) {
        if (!job.result && ["failed", "cancelled"].includes(job.status) && (this.options.now?.() ?? Date.now()) - Date.parse(job.updatedAt) >= (this.options.retentionMs || 86_400_000)) {
          await rm(join(this.options.artifactRoot, "jobs", `${id}.json`), { force: true });
          this.jobs.delete(id); this.listeners.delete(id);
        }
      }
      return removed;
    });
  }

  listFavorites(q?: string, tags?: string[]): MusicFavorite[] {
    return [...this.jobs.values()]
      .filter((job) => job.status === "completed" && job.result && job.favorite && job.favoritedAt
        && musicTrackMatches(this.trackView(job), q) && musicTrackTagsMatch(this.trackView(job), tags))
      .map((job) => this.favoriteView(job))
      .sort((left, right) => right.favoritedAt.localeCompare(left.favoritedAt));
  }

  listFavoritesPage(query: MusicFavoriteQuery) {
    return paginateMusicFavorites(this.listFavorites(query.q, query.tags), query);
  }

  getFavorite(jobId: string): MusicFavorite | undefined {
    const job = this.jobs.get(jobId);
    return job?.status === "completed" && job.result && job.favorite && job.favoritedAt
      ? this.favoriteView(job)
      : undefined;
  }

  async favorite(jobId: string): Promise<MusicFavorite | undefined> {
    return this.withStorage(async () => {
      const job = this.jobs.get(jobId);
      if (job?.status !== "completed" || !job.result || !job.metadataPath) return undefined;
      const metadata = musicArtifactMetadataSchema.parse(JSON.parse(await readFile(job.metadataPath, "utf8")));
      const favoritedAt = job.favoritedAt ?? this.isoNow();
      const updated = { ...metadata, favorite: true, favoritedAt };
      await this.retention.assertCapacity((await lstat(job.audioPath!)).size
        + Buffer.byteLength(`${JSON.stringify(updated, null, 2)}\n`), updated.favorite, job.jobId);
      const temporary = `${job.metadataPath}.favorite.tmp`;
      await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o640 });
      await rename(temporary, job.metadataPath);
      job.favorite = true;
      job.favoritedAt = favoritedAt;
      void this.pruneArtifacts().catch((error) => {
        console.warn(`music artifact pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return this.favoriteView(job);
    });
  }

  async unfavorite(jobId: string): Promise<boolean> {
    return this.withStorage(async () => {
      const job = this.jobs.get(jobId);
      if (job?.status !== "completed" || !job.metadataPath) return false;
      const metadata = musicArtifactMetadataSchema.parse(JSON.parse(await readFile(job.metadataPath, "utf8")));
      const { favoritedAt: _favoritedAt, ...updated } = { ...metadata, favorite: false };
      await this.retention.assertCapacity((await lstat(job.audioPath!)).size
        + Buffer.byteLength(`${JSON.stringify(updated, null, 2)}\n`), updated.favorite, job.jobId);
      const temporary = `${job.metadataPath}.favorite.tmp`;
      await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o640 });
      await rename(temporary, job.metadataPath);
      job.favorite = false;
      delete job.favoritedAt;
      void this.pruneArtifacts().catch((error) => {
        console.warn(`music artifact pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return true;
    });
  }

  create(request: MusicGenerationRequest): MusicGenerationJob {
    if (request.referenceAudio && !this.provider.capabilities.referenceAudio) throw new MusicProviderError("unsupported_feature", "referenceAudio is not supported by this provider");
    if (this.closed || this.queue.length >= 16) throw new MusicProviderError("queue_full", "music generation queue unavailable");
    request = { ...request, tags: deriveMusicTags(request) };
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
    const finish = this.options.beginWorkload?.();
    try { this.persist(job); } catch {
      finish?.();
      throw new MusicProviderError("job_persistence_failed", "unable to persist accepted music job");
    }
    if (finish) this.workloadFinishes.set(jobId, finish);
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
    try { listener(this.publicJob(job)); } catch { listeners.delete(listener); }
    if (["completed", "failed", "cancelled"].includes(job.status)) listeners.delete(listener);
    return () => listeners.delete(listener);
  }

  async cancel(jobId: string): Promise<MusicGenerationJob | undefined> {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (["completed", "failed", "cancelled"].includes(job.status)) return this.publicJob(job);
    job.abort.abort(new Error("cancelled"));
    const queued = this.queue.indexOf(jobId);
    if (queued >= 0) this.queue.splice(queued, 1);
    await this.provider.cancel?.(jobId);
    await this.runningJobs.get(jobId);
    this.transition(job, "cancelled");
    return this.publicJob(job);
  }

  artifact(jobId: string, kind: "audio" | "metadata", favoriteOnly = false):
    { path: string; contentType: string; filename: string } | undefined {
    const job = this.jobs.get(jobId);
    if (!job?.result || (favoriteOnly && !job.favorite)) return undefined;
    if (kind === "metadata" && job.metadataPath) {
      return { path: job.metadataPath, contentType: "application/json; charset=utf-8", filename: "metadata.json" };
    }
    if (!job.audioPath) return undefined;
    const contentTypes = { wav: "audio/wav", flac: "audio/flac", mp3: "audio/mpeg", opus: "audio/ogg" };
    return {
      path: job.audioPath,
      contentType: contentTypes[job.result.format],
      filename: `output.${job.result.format}`,
    };
  }

  private async drain(): Promise<void> {
    const concurrency = this.options.concurrency ?? 1;
    while (!this.closed && this.running < concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.abort.signal.aborted || ["completed", "failed", "cancelled"].includes(job.status)) continue;
      if ((this.options.now?.() ?? Date.now()) - Date.parse(job.createdAt) >= (this.options.queueTimeoutMs ?? 300_000)) {
        job.error = { code: "queue_timeout", message: "music queue wait expired; not submitted" };
        this.transition(job, "failed");
        continue;
      }
      this.running++;
      const running = this.run(job).finally(() => {
        this.runningJobs.delete(id);
        this.running--;
        void this.drain();
      });
      this.runningJobs.set(id, running);
      void running.catch((error) => console.error(`music job execution failed: ${String(error)}`));
    }
  }

  private async run(job: InternalJob): Promise<void> {
    let release: (() => Promise<void>) | undefined;
    let failure: unknown;
    const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(900_000)]);
    try {
      await this.withStorage(() => this.retention.assertCapacity(0, false));
      const generated = await this.provider.generate(job.request, {
        jobId: job.jobId,
        signal,
        phase: (phase, progress) => this.transition(job, phase, progress),
      });
      release = generated.release;
      if (job.abort.signal.aborted || job.status === "cancelled") return;
      await this.withStorage(async () => {
        const date = new Date(this.options.now?.() ?? Date.now());
        const directory = join(
          this.options.artifactRoot,
          String(date.getUTCFullYear()),
          String(date.getUTCMonth() + 1).padStart(2, "0"),
          job.jobId,
        );
        const audioPath = join(directory, `output.${generated.format}`);
        const metadataPath = join(directory, "metadata.json");
        const audioTmp = `${audioPath}.tmp`;
        const metadataTmp = `${metadataPath}.tmp`;
        const { audio, release: _release, ...providerResult } = generated;
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
        const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
        await this.retention.assertCapacity(audio.byteLength + Buffer.byteLength(metadataText), false);
        signal.throwIfAborted();
        await mkdir(directory, { recursive: true, mode: 0o750 });
        try {
          await writeFile(audioTmp, audio, { mode: 0o640 });
          await writeFile(metadataTmp, metadataText, { mode: 0o640 });
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
        } finally {
          await Promise.all([rm(audioTmp, { force: true }), rm(metadataTmp, { force: true })]);
        }
      });
      signal.throwIfAborted();
      void this.pruneArtifacts().catch((error) => {
        console.warn(`music artifact pruning failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      failure = error;
    } finally {
      try { await release?.(); } catch (error) { failure = error; }
      try {
        if (failure instanceof MediaVariantStopError || (!signal.aborted && failure)) {
          job.error = {
            code: failure instanceof MediaVariantStopError ? "worker_stop_failed" : failure instanceof MusicProviderError ? failure.code : "generation_failed",
            message: failure instanceof Error ? failure.message : String(failure),
          };
          this.transition(job, "failed");
        } else if (job.abort.signal.aborted) {
          this.transition(job, "cancelled");
        } else if (signal.aborted) {
          job.error = { code: "generation_timeout", message: "generation timed out" };
          this.transition(job, "failed");
        } else {
          this.transition(job, "completed", 1);
        }
      } finally { this.finishWorkload(job.jobId); }
    }
  }

  private transition(job: InternalJob, status: MusicGenerationStatus, progress?: number): void {
    if (["completed", "failed", "cancelled"].includes(job.status)) return;
    job.status = status;
    job.phase = status;
    job.updatedAt = this.isoNow();
    if (progress === undefined) delete job.progress;
    else job.progress = progress;
    try { this.persist(job); } catch {
      if (!["completed", "failed", "cancelled"].includes(status)) {
        throw new MusicProviderError("job_persistence_failed", "unable to persist music job status");
      }
      job.status = "failed"; job.phase = "failed";
      job.error = { code: "job_persistence_failed", message: "unable to persist music job status" };
    }
    if (["completed", "failed", "cancelled"].includes(job.status)) this.finishWorkload(job.jobId);
    const publicJob = this.publicJob(job);
    for (const listener of this.listeners.get(job.jobId) ?? []) {
      try { listener(structuredClone(publicJob)); } catch { this.listeners.get(job.jobId)?.delete(listener); }
    }
    if (["completed", "failed", "cancelled"].includes(job.status)) this.listeners.delete(job.jobId);
  }

  private finishWorkload(jobId: string): void {
    const finish = this.workloadFinishes.get(jobId);
    this.workloadFinishes.delete(jobId);
    finish?.();
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

  listTracks(query: MusicTrackQuery) {
    return listMusicTracks([...this.jobs.values()]
      .filter((job) => job.status === "completed" && job.result)
      .map((job) => this.trackView(job)), query);
  }

  listTags(query: MusicTagQuery = { limit: 50 }) {
    return listMusicTags([...this.jobs.values()]
      .filter((job) => job.status === "completed" && job.result)
      .map((job) => this.trackView(job)), query);
  }

  getTrack(id: string): MusicTrack | undefined {
    const job = this.jobs.get(id);
    return job?.status === "completed" && job.result ? this.trackView(job) : undefined;
  }

  async deleteTrack(id: string): Promise<boolean> {
    return this.withStorage(async () => {
      const job = this.jobs.get(id);
      if (!job) return false;
      if (!["completed", "failed", "cancelled"].includes(job.status)) {
        throw new MusicProviderError("music_track_busy", "cannot delete a music job while it is running");
      }
      if (!job.audioPath) return false;
      const directory = resolve(job.audioPath, "..");
      const trash = join(this.options.artifactRoot, `.deleted-${id}`);
      // Hide the entire artifact atomically before removing the journal. A
      // crash cannot rediscover a deleted track as a completed artifact.
      await rename(directory, trash);
      this.jobs.delete(id);
      this.listeners.delete(id);
      await rm(join(this.options.artifactRoot, "jobs", `${id}.json`), { force: true });
      await rm(trash, { recursive: true, force: true });
      return true;
    });
  }

  private withStorage<T>(work: () => Promise<T>): Promise<T> {
    const result = this.storageChain.then(work);
    this.storageChain = result.then(() => {}, () => {});
    return result;
  }

  private trackView(job: InternalJob): MusicTrack {
    const result = job.result!;
    return {
      id: job.jobId,
      title: job.request.title ?? job.request.prompt.slice(0, 200),
      tags: deriveMusicTags(job.request),
      prompt: job.request.prompt,
      ...(job.request.lyrics === undefined ? {} : { lyrics: job.request.lyrics }),
      instrumental: job.request.instrumental,
      ...(job.request.language ? { language: job.request.language } : {}),
      provider: result.provider,
      model: result.model,
      format: result.format,
      durationSeconds: result.durationSeconds,
      createdAt: job.createdAt,
      favorite: job.favorite ?? false,
      ...(job.favoritedAt ? { favoritedAt: job.favoritedAt } : {}),
      audioUrl: `/v1/music/tracks/${encodeURIComponent(job.jobId)}/audio`,
      metadataUrl: `/v1/music/tracks/${encodeURIComponent(job.jobId)}/metadata`,
    };
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
        if (metadata.audioFile !== `output.${metadata.format}` || metadata.id !== artifact.directory.split(sep).at(-1)) continue;
        const audio = await lstat(join(artifact.directory, metadata.audioFile));
        if (!audio.isFile() || audio.isSymbolicLink()) continue;
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

  private persist(job: InternalJob): void {
    const root = join(this.options.artifactRoot, "jobs");
    mkdirSync(root, { recursive: true, mode: 0o750 });
    const path = join(root, `${job.jobId}.json`);
    const { abort: _abort, ...saved } = job;
    writeFileSync(`${path}.tmp`, JSON.stringify(saved), { mode: 0o640 });
    renameSync(`${path}.tmp`, path);
  }

  private isoNow(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }
}
