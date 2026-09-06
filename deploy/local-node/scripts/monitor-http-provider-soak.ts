import {
  chmod,
  mkdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import {
  httpProviderSoakEvidenceSchema,
  type HttpProviderSoakEvidence,
} from "../../../packages/core/src/index";
import {
  runHttpProviderLiveSmoke,
  type HttpProviderLiveSmokeResult,
} from "./smoke-http-provider-live";

type SmokeRunner = () => Promise<HttpProviderLiveSmokeResult>;

export type HttpProviderSoakMonitorOptions = {
  statePath: string;
  runSmoke: SmokeRunner;
  now?: () => number;
};

function safeTimestamp(value: number): string {
  if (!Number.isFinite(value)) throw new Error("monitor clock is invalid");
  return new Date(value).toISOString();
}

async function loadState(path: string): Promise<HttpProviderSoakEvidence | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  if (file.size > 64 * 1024) throw new Error("soak state is too large");
  return httpProviderSoakEvidenceSchema.parse(await file.json());
}

async function writeState(path: string, state: HttpProviderSoakEvidence): Promise<void> {
  const parsed = httpProviderSoakEvidenceSchema.parse(state);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const temporary = `${path}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function sameGeneration(
  state: HttpProviderSoakEvidence,
  smoke: HttpProviderLiveSmokeResult,
): boolean {
  return state.releaseCommit === smoke.releaseCommit
    && state.configRevision === smoke.configRevision
    && state.bootEpoch === smoke.bootEpoch;
}

export async function recordHttpProviderSoak(
  options: HttpProviderSoakMonitorOptions,
): Promise<HttpProviderSoakEvidence> {
  if (!options.statePath.startsWith("/") || options.statePath === "/") {
    throw new Error("soak state path must be absolute and non-root");
  }
  const previous = await loadState(options.statePath);
  const attemptedAtMs = options.now?.() ?? Date.now();
  const attemptedAt = safeTimestamp(attemptedAtMs);
  let smoke: HttpProviderLiveSmokeResult;
  try {
    smoke = await options.runSmoke();
  } catch (error) {
    if (previous) {
      await writeState(options.statePath, {
        ...previous,
        ok: false,
        lastAttemptAt: attemptedAt,
        failureCount: previous.failureCount + 1,
      });
    }
    throw error;
  }

  const continued = previous !== undefined && sameGeneration(previous, smoke);
  const startedAt = continued ? previous.startedAt : attemptedAt;
  const priorSuccessMs = continued && previous.lastSuccessAt
    ? Date.parse(previous.lastSuccessAt)
    : attemptedAtMs;
  const gapSeconds = Math.max(0, Math.ceil((attemptedAtMs - priorSuccessMs) / 1_000));
  const failureCount = continued ? previous.failureCount : 0;
  const state: HttpProviderSoakEvidence = {
    schemaVersion: 1,
    kind: "http-provider-soak",
    ok: failureCount === 0,
    releaseCommit: smoke.releaseCommit,
    configRevision: smoke.configRevision,
    bootEpoch: smoke.bootEpoch,
    startedAt,
    lastAttemptAt: attemptedAt,
    lastSuccessAt: attemptedAt,
    durationSeconds: Math.max(
      0,
      Math.floor((attemptedAtMs - Date.parse(startedAt)) / 1_000),
    ),
    sampleCount: continued ? previous.sampleCount + 1 : 1,
    failureCount,
    maxGapSeconds: continued
      ? Math.max(previous.maxGapSeconds, gapSeconds)
      : 0,
  };
  await writeState(options.statePath, state);
  return state;
}

if (import.meta.main) {
  try {
    const state = await recordHttpProviderSoak({
      statePath: process.env.LARM_HTTP_SOAK_STATE
        ?? "/var/lib/larm/http-provider-soak/status.json",
      runSmoke: async () => await runHttpProviderLiveSmoke({
        baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
        apiToken: process.env.LARM_API_TOKEN ?? "",
        model: process.env.LARM_HTTP_MODEL ?? "coding-default",
        includeAudio: false,
        timeoutMs: Number(process.env.LARM_HTTP_SMOKE_TIMEOUT_MS ?? 300_000),
      }),
    });
    console.log(JSON.stringify(state));
    if (!state.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`HTTP Provider soak sample failed: ${error instanceof Error ? error.name : "unknown_error"}`);
    process.exitCode = 1;
  }
}
