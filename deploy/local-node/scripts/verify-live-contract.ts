import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  daemonHealthSchema,
  publicAgentProfileListSchema,
  readinessSchema,
  serviceActivitySchema,
  type AgentConnectionCatalog,
} from "../../../packages/core/src/index";
import { loadCatalogGeneration } from "../../../apps/daemon/src/catalog-generation";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ExpectedLiveContract = {
  commit: string;
  version: string;
  configRevision: string;
  agentConnections?: AgentConnectionCatalog;
};

export type LiveContractResult = {
  ok: true;
  releaseCommit: string;
  configRevision: string;
  bootEpoch: string;
  activity: "idle" | "active" | "draining";
  agentProfiles: number;
};

function expectedProfiles(expected: ExpectedLiveContract): unknown {
  const catalog = expected.agentConnections;
  if (!catalog) return undefined;
  return {
    contractVersion: "agent-connection.v2",
    catalogRevision: expected.configRevision,
    defaultAgentProfile: catalog.defaultAgentProfile,
    profiles: catalog.profiles.map((profile) => ({
      id: profile.id,
      canonicalProfile: profile.canonicalProfile,
      description: profile.description,
      selectionPolicy: profile.selectionPolicy,
      deprecated: profile.deprecated,
      providers: profile.providers.map((provider) => ({
        name: provider.name,
        capability: provider.capability,
        supportedCapabilities: provider.supportedCapabilities,
        protocol: provider.protocol,
        model: provider.publicModel,
        ...(provider.streamingProtocol ? { streamingProtocol: provider.streamingProtocol } : {}),
      })),
    })),
    audiences: catalog.audiences.map((audience) => audience.id),
  };
}

async function requestJson(
  fetchImpl: FetchLike,
  baseUrl: string,
  path: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${path} returned the wrong content type`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 1_048_576) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${path} response is too large`);
  }
  if (!response.body) throw new Error(`${path} returned an empty body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1_048_576) throw new Error(`${path} response is too large`);
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new Error(`${path} returned invalid UTF-8 JSON`);
  }
}

export async function verifyLiveContract(options: {
  baseUrl: string;
  expected: ExpectedLiveContract;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}): Promise<LiveContractResult> {
  const url = new URL(options.baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("baseUrl must not contain credentials, query, or fragment");
  }
  const baseUrl = url.toString().replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 3_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError("timeoutMs must be an integer from 1 through 60000");
  }
  const fetchImpl = options.fetch ?? fetch;
  const health = daemonHealthSchema.parse(await requestJson(fetchImpl, baseUrl, "/health", timeoutMs));
  if (
    health.releaseCommit !== options.expected.commit
    || health.version !== options.expected.version
    || health.configRevision !== options.expected.configRevision
  ) {
    throw new Error("live daemon identity does not match the candidate release manifest");
  }
  const readiness = readinessSchema.parse(await requestJson(fetchImpl, baseUrl, "/ready", timeoutMs));
  if (readiness.status !== "ready") throw new Error(`live daemon is not ready: ${readiness.status}`);
  const activity = serviceActivitySchema.parse(
    await requestJson(fetchImpl, baseUrl, "/v1/activity", timeoutMs),
  );
  if (activity.bootEpoch !== health.bootEpoch || activity.configRevision !== health.configRevision) {
    throw new Error("service activity identity does not match daemon health");
  }
  const activityAgeMs = (options.now?.() ?? Date.now()) - Date.parse(activity.observedAt);
  if (!Number.isFinite(activityAgeMs) || activityAgeMs < -activity.validForMs || activityAgeMs > activity.validForMs) {
    throw new Error("service activity snapshot is outside its validity window");
  }

  const advertisedExpected = expectedProfiles(options.expected);
  let agentProfiles = 0;
  if (advertisedExpected) {
    const advertised = publicAgentProfileListSchema.parse(
      await requestJson(fetchImpl, baseUrl, "/v2/agent-profiles", timeoutMs),
    );
    const validatedExpected = publicAgentProfileListSchema.parse(advertisedExpected);
    if (!isDeepStrictEqual(advertised, validatedExpected)) {
      throw new Error("live Agent Profile catalog does not match the candidate release");
    }
    agentProfiles = advertised.profiles.length;
  }
  return {
    ok: true,
    releaseCommit: health.releaseCommit,
    configRevision: health.configRevision,
    bootEpoch: health.bootEpoch,
    activity: activity.state,
    agentProfiles,
  };
}

export async function expectedContractFromRelease(releaseDir: string): Promise<ExpectedLiveContract> {
  const manifest = JSON.parse(
    await readFile(`${releaseDir}/release-manifest.json`, "utf8"),
  ) as Record<string, unknown>;
  const commit = manifest.commit;
  const version = manifest.larmVersion;
  const configRevision = manifest.configRevision;
  if (
    typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit)
    || typeof version !== "string" || version.length === 0
    || typeof configRevision !== "string" || !/^[a-f0-9]{64}$/.test(configRevision)
  ) {
    throw new Error("release manifest identity is invalid");
  }
  const generation = loadCatalogGeneration({
    configDir: `${releaseDir}/config/local-node`,
    artifactManifestPath: `${releaseDir}/deploy/local-node/models.yaml`,
    releaseCatalogPath: `${releaseDir}/deploy/local-node/releases.yaml`,
  });
  if (generation.revision !== configRevision) {
    throw new Error("candidate catalog revision does not match its release manifest");
  }
  return {
    commit,
    version,
    configRevision,
    ...(generation.agentConnections ? { agentConnections: generation.agentConnections } : {}),
  };
}

if (import.meta.main) {
  try {
    const releaseDir = process.env.LARM_VERIFY_RELEASE_DIR;
    if (!releaseDir?.startsWith("/")) throw new Error("LARM_VERIFY_RELEASE_DIR must be an absolute path");
    const result = await verifyLiveContract({
      baseUrl: process.env.LARM_VERIFY_BASE_URL ?? "http://127.0.0.1:9810",
      expected: await expectedContractFromRelease(releaseDir),
      timeoutMs: 3_000,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`live contract verification failed: ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  }
}
