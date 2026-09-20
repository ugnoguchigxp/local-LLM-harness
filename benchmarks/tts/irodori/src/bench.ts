import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { appendJsonl, loadCorpus, parseWav, shuffled, speedMetrics, writeJsonAtomic, type CorpusItem } from "./lib";

export type Profile = {
  id: string;
  backend: string;
  device: string;
  precision: string;
  url: string;
  model: string;
  voice?: string;
  responseFormat: "wav" | "pcm";
  nativeStreaming: boolean;
  options?: Record<string, unknown>;
  irodori?: Record<string, unknown>;
  revisions?: Record<string, string>;
};

export type SpeechMeasurement = {
  status: number;
  contentType: string;
  firstResponseByteMs: number;
  firstAudioReadyMs: number;
  generationCompleteMs: number;
  bytes: Uint8Array;
};

const root = resolve(import.meta.dir, "../../../..");

if (import.meta.main) await main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profilePath = resolveProfile(args.profile);
  const profile = JSON.parse(await readFile(profilePath, "utf8")) as Profile;
  if (args.url) profile.url = args.url;
  const corpusPath = resolveCorpus(args.corpus);
  const corpus = await loadCorpus(corpusPath);
  const output = args.output ?? `/srv/ai/results/larm/tts/${timestampId()}-${profile.id}`;
  if (!isAbsolute(output)) throw new Error("--output must be an absolute path outside the source repository");
  if (output === root || output.startsWith(`${root}/`)) throw new Error("benchmark output must remain outside the source repository");

  const configuration = {
    profile: profile.id,
    profilePath,
    corpusPath,
    output,
    mode: args.mode,
    warmups: args.warmups,
    iterations: args.iterations,
    concurrency: args.concurrency,
    seed: args.seed,
    text: args.text,
    saveAudio: args.saveAudio,
    url: profile.url,
  };
  if (args.dryRun) {
    console.log(JSON.stringify({ configuration, profile, corpusItems: corpus.length }, null, 2));
    return;
  }

  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(output, "environment.json"), await environment(profile, configuration));
  const runsPath = join(output, "runs.jsonl");
  let interrupted = false;
  process.on("SIGINT", () => { interrupted = true; });

  for (let index = 0; index < args.warmups && !interrupted; index += 1) {
    await runOne(profile, corpus[index % corpus.length]!, args, "warmup", index + 1).catch(() => undefined);
  }

  const queue = shuffled(
    Array.from({ length: args.iterations }, (_, iteration) => corpus.map((item) => ({ item, iteration: iteration + 1 }))).flat(),
    args.seed,
  );
  for (let offset = 0; offset < queue.length && !interrupted; offset += args.concurrency) {
    const batch = queue.slice(offset, offset + args.concurrency);
    await Promise.all(batch.map(async ({ item, iteration }) => {
      const sample = await runOne(profile, item, args, "measured", iteration);
      if (args.saveAudio && sample.ok && sample.audio) {
        const audioDir = join(output, "audio");
        await mkdir(audioDir, { recursive: true, mode: 0o700 });
        const path = join(audioDir, `${item.id}-i${iteration}-${args.text}.wav`);
        await writeFile(path, sample.audio, { mode: 0o600 });
        sample.record.audioPath = `audio/${basename(path)}`;
      }
      await appendJsonl(runsPath, sample.record);
    }));
  }
  console.log(JSON.stringify({ output, profile: profile.id, interrupted, runs: queue.length }, null, 2));
}

async function runOne(profile: Profile, item: CorpusItem, args: Args, phase: "warmup" | "measured", iteration: number) {
  const input = args.text === "raw" ? item.display_text : item.spoken_text;
  const recordedAt = new Date().toISOString();
  try {
    const measurement = await fetchSpeech(profile, input, args.seed, args.timeoutMs);
    if (measurement.status < 200 || measurement.status >= 300) {
      throw new Error(`http_${measurement.status}:${new TextDecoder().decode(measurement.bytes).slice(0, 300)}`);
    }
    if (!measurement.contentType.toLowerCase().startsWith("audio/")) throw new Error("non_audio_response");
    const wav = profile.responseFormat === "wav" ? parseWav(measurement.bytes) : undefined;
    const speed = wav ? speedMetrics(measurement.generationCompleteMs, wav.durationSeconds) : { rtf: null, xRealtime: null };
    return {
      ok: true as const,
      audio: measurement.bytes,
      record: {
        schemaVersion: 1, phase, recordedAt, profile: profile.id, corpusId: item.id, category: item.category,
        iteration, seed: args.seed, mode: args.mode, textMode: args.text, inputCharacters: [...input].length,
        status: measurement.status, contentType: measurement.contentType, responseBytes: measurement.bytes.length,
        latencyMs: {
          requestStart: 0,
          providerStart: 0,
          upstreamAccepted: null,
          firstResponseByte: measurement.firstResponseByteMs,
          firstAudioReady: measurement.firstAudioReadyMs,
          generationComplete: measurement.generationCompleteMs,
        },
        audio: wav,
        rtf: speed.rtf,
        xRealtime: speed.xRealtime,
        msPerCharacter: measurement.generationCompleteMs / Math.max(1, [...input].length),
        ok: true,
      } as Record<string, unknown>,
    };
  } catch (cause) {
    return {
      ok: false as const,
      record: {
        schemaVersion: 1, phase, recordedAt, profile: profile.id, corpusId: item.id, category: item.category,
        iteration, seed: args.seed, mode: args.mode, textMode: args.text, inputCharacters: [...input].length,
        ok: false, error: cause instanceof Error ? cause.message : String(cause),
      } as Record<string, unknown>,
    };
  }
}

export async function fetchSpeech(
  profile: Profile,
  input: string,
  seed: number,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SpeechMeasurement> {
  const started = performance.now();
  const response = await fetchImpl(profile.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "audio/wav",
      ...(process.env.LARM_API_TOKEN ? { authorization: `Bearer ${process.env.LARM_API_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      model: profile.model,
      input,
      ...(profile.voice ? { voice: profile.voice } : {}),
      response_format: profile.responseFormat,
      seed,
      ...(profile.options ? { options: profile.options } : {}),
      ...(profile.irodori ? { irodori: profile.irodori } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response_body_missing");
  const chunks: Uint8Array[] = [];
  let length = 0;
  let firstResponseByteMs: number | undefined;
  let firstAudioReadyMs: number | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;
    const now = performance.now() - started;
    firstResponseByteMs ??= now;
    chunks.push(value);
    length += value.length;
    if (firstAudioReadyMs === undefined && (profile.responseFormat === "pcm" ? length >= 2 : length > 44)) firstAudioReadyMs = now;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const complete = performance.now() - started;
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    firstResponseByteMs: firstResponseByteMs ?? complete,
    firstAudioReadyMs: firstAudioReadyMs ?? complete,
    generationCompleteMs: complete,
    bytes,
  };
}

type Args = ReturnType<typeof parseArgs>;

function parseArgs(argv: string[]) {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const integer = (name: string, fallback: number, minimum: number, maximum: number) => {
    const parsed = Number(value(name) ?? fallback);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be ${minimum}..${maximum}`);
    return parsed;
  };
  const profile = value("--profile");
  if (!profile) throw new Error("--profile is required");
  const mode = value("--mode") ?? "direct";
  if (!new Set(["direct", "larm"]).has(mode)) throw new Error("--mode must be direct or larm");
  const text = value("--text") ?? "spoken";
  if (!new Set(["raw", "spoken"]).has(text)) throw new Error("--text must be raw or spoken");
  return {
    profile,
    corpus: value("--corpus") ?? "ja-latency",
    output: value("--output"),
    url: value("--url"),
    mode: mode as "direct" | "larm",
    text: text as "raw" | "spoken",
    warmups: integer("--warmups", 2, 0, 100),
    iterations: integer("--iterations", 5, 1, 100),
    concurrency: integer("--concurrency", 1, 1, 32),
    seed: integer("--seed", 42, 0, 0x7fff_ffff),
    timeoutMs: integer("--timeout-ms", 300_000, 100, 3_600_000),
    dryRun: argv.includes("--dry-run"),
    saveAudio: argv.includes("--save-audio"),
  };
}

function resolveProfile(value: string) {
  if (isAbsolute(value)) return value;
  return join(root, "benchmarks/tts/irodori/profiles", value.endsWith(".json") ? value : `${value}.json`);
}

function resolveCorpus(value: string) {
  if (isAbsolute(value)) return value;
  return join(root, "benchmarks/tts/irodori/corpus", value.endsWith(".jsonl") ? value : `${value}.jsonl`);
}

function command(args: string[]) {
  const result = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

async function environment(profile: Profile, configuration: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    larm: { commit: command(["git", "rev-parse", "HEAD"]), dirty: Boolean(command(["git", "status", "--porcelain"])) },
    profile,
    configuration,
    system: {
      uname: command(["uname", "-a"]),
      cpu: command(["bash", "-lc", "lscpu | sed -n '1,28p'"]),
      memory: command(["free", "-b"]),
      rocm: command(["bash", "-lc", "rocminfo 2>/dev/null | sed -n '1,100p'"]),
    },
    runtimes: {
      bun: Bun.version,
      python: command(["python3", "--version"]),
      ffmpeg: command(["bash", "-lc", "ffmpeg -version | head -1"]),
    },
    environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(OMP|OPENBLAS|MKL|ROCM|HSA|HIP|CUDA|BENCH_TTS)_/.test(key))),
  };
}

function timestampId() { return new Date().toISOString().replaceAll(":", "").replaceAll(".", "-"); }
