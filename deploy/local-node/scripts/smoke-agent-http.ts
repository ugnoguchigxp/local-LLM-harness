import {
  agentProviderHealthSchema,
  inspectOpenAiChatCompletionJson,
  inspectOpenAiChatCompletionSse,
  type AgentProfileSelectorId,
} from "../../../packages/core/src/index";
import { LarmClient } from "../../../packages/client/src/index";

export type AgentHttpSmokeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type AgentHttpSmokeOptions = {
  baseUrl: string;
  apiToken?: string;
  agentProfile: string;
  profile?: AgentProfileSelectorId;
  audience: string;
  client: string;
  provider?: string;
  expectedModel?: string;
  expectedReleaseCommit?: string;
  requireReleaseIdentity?: boolean;
  requireIdleBeforeCreate?: boolean;
  requireIdleAfterRelease?: boolean;
  timeoutMs?: number;
  ttlSeconds?: number;
  fetch?: AgentHttpSmokeFetch;
  now?: () => number;
  random?: () => string;
};

export type AgentHttpSmokeResult = {
  ok: true;
  releaseCommit: string;
  configRevision: string;
  bootEpoch: string;
  agentProfile: string;
  audience: string;
  provider: string;
  model: string;
  initialActivity: "idle" | "active" | "draining";
  finalActivity: "idle" | "active" | "draining";
  jsonValidated: true;
  sse: { chunks: number; deltas: number; finishReasons: number };
  released: true;
  credentialRevoked: true;
};

const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_HEALTH_BYTES = 64 * 1024;

type AgentProfiles = Awaited<ReturnType<LarmClient["listAgentProfilesV3"]>>;
type AdvertisedProfile = AgentProfiles["profiles"][number];
type AdvertisedProvider = AdvertisedProfile["providers"][number];

function integerOption(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return selected;
}

function selectedProfile(
  profiles: AgentProfiles,
  id: string,
): AdvertisedProfile {
  const profile = profiles.profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Agent Profile is not advertised: ${id}`);
  if (profile.deprecated) throw new Error(`Agent Profile is deprecated: ${id}`);
  return profile;
}

function selectedProvider(
  profile: AdvertisedProfile,
  name: string,
): AdvertisedProvider {
  const provider = profile.providers.find((candidate) => candidate.name === name);
  if (!provider) throw new Error(`Agent Provider is not advertised by ${profile.id}: ${name}`);
  if (provider.protocol !== "openai.chat-completions.v1") {
    throw new Error(`Agent Provider does not use OpenAI Chat Completions: ${name}`);
  }
  return provider;
}

function selectorForAgentProfile(agentProfile: string): AgentProfileSelectorId {
  if (agentProfile === "coding-default") return "vulnWorkbench";
  if (agentProfile === "contextstill-background") return "contextStill";
  if (agentProfile === "saaa-conversation-ornith15") return "SAAA";
  if (agentProfile === "saaa-conversation-ornith15-image") return "SAAA-w-Image";
  if (agentProfile === "saaa-conversation-ornith15-music") return "SAAA-w-music";
  if (agentProfile === "contextstill-embedding") return "embeddingCanary";
  throw new Error(`no public profile selector is configured for ${agentProfile}`);
}

function mediaType(response: Response): string | undefined {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

function cancelResponseBody(response: Response, reason: string): void {
  void response.body?.cancel(new Error(reason)).catch(() => undefined);
}

async function responseBytes(response: Response, limit = MAX_PROVIDER_RESPONSE_BYTES): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    cancelResponseBody(response, "provider_response_too_large");
    throw new Error("provider_response_too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error("provider_response_too_large");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function providerRequest(
  fetchImpl: AgentHttpSmokeFetch,
  url: string,
  token: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
}

function validateJsonCompletion(bytes: Uint8Array): void {
  const inspected = inspectOpenAiChatCompletionJson(parseJson(bytes, "OpenAI JSON completion response"));
  if (!inspected.ok) throw new Error(`OpenAI JSON completion is invalid: ${inspected.reason}`);
  if (inspected.textChoices === 0) {
    throw new Error("OpenAI JSON completion contains no content or reasoning content");
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
}

export async function runAgentHttpSmoke(options: AgentHttpSmokeOptions): Promise<AgentHttpSmokeResult> {
  const timeoutMs = integerOption(options.timeoutMs, 300_000, "timeoutMs", 3_600_000);
  const ttlSeconds = integerOption(options.ttlSeconds, 300, "ttlSeconds", 86_400);
  const providerName = options.provider ?? "llm";
  if (
    options.expectedReleaseCommit
    && (options.expectedReleaseCommit.length !== 40 || !/^[a-f0-9]{40}$/.test(options.expectedReleaseCommit))
  ) {
    throw new Error("expectedReleaseCommit must be a full lowercase Git commit");
  }
  const fetchImpl = options.fetch ?? fetch;
  const larm = new LarmClient({
    baseUrl: options.baseUrl,
    ...(options.apiToken ? { apiToken: options.apiToken } : {}),
    fetch: fetchImpl,
    timeoutMs,
    ...(options.now ? { now: options.now } : {}),
    ...(options.random ? { random: options.random } : {}),
  });

  const health = await larm.getHealth();
  if ((options.requireReleaseIdentity ?? true) && health.releaseCommit === "development") {
    throw new Error("live release identity is development");
  }
  if (options.expectedReleaseCommit && health.releaseCommit !== options.expectedReleaseCommit) {
    throw new Error(`release drift: expected ${options.expectedReleaseCommit}, got ${health.releaseCommit}`);
  }
  const readiness = await larm.getReadiness();
  if (readiness.status !== "ready") throw new Error(`LARM is not ready: ${readiness.status}`);
  const initialActivity = await larm.getServiceActivity();
  if (initialActivity.state === "draining") throw new Error("LARM is draining");
  if ((options.requireIdleBeforeCreate ?? true) && initialActivity.state !== "idle") {
    throw new Error(`LARM is not idle before the canary: ${initialActivity.state}`);
  }

  const selector = options.profile ?? selectorForAgentProfile(options.agentProfile);
  const profiles = await larm.listAgentProfilesV3(selector);
  if (profiles.catalogRevision !== health.configRevision) {
    throw new Error("Agent Profile catalog revision does not match daemon health");
  }
  if (!profiles.audiences.includes(options.audience)) {
    throw new Error(`Agent audience is not advertised: ${options.audience}`);
  }
  const profile = selectedProfile(profiles, options.agentProfile);
  const advertised = selectedProvider(profile, providerName);
  if (options.expectedModel && advertised.model !== options.expectedModel) {
    throw new Error(`model drift: expected ${options.expectedModel}, got ${advertised.model}`);
  }

  let connectionId: string | undefined;
  let released = false;
  try {
    const created = await larm.createAgentConnection({
      profile: selector,
      audience: options.audience,
      client: options.client,
      ttlSeconds,
      allowFallback: false,
      deploymentPolicy: "existing-only",
    });
    connectionId = created.id;
    const connection = await larm.waitForAgentConnection(created, {
      timeoutMs,
      pollIntervalMs: 500,
    });
    if (connection.catalogRevision !== health.configRevision) {
      throw new Error("Agent Connection catalog revision drifted during creation");
    }
    const connectionProvider = connection.providers.find((candidate) => candidate.name === providerName);
    if (!connectionProvider?.claimable || connectionProvider.model !== advertised.model) {
      throw new Error("Agent Connection provider does not match its advertised profile");
    }

    const claim = await larm.claimAgentConnection(connection.id);
    const provider = claim.providers.find((candidate) => candidate.name === providerName);
    if (!provider || provider.model !== advertised.model) {
      throw new Error("claimed Agent Provider does not match its advertised profile");
    }
    const credential = provider.credential.token;

    const providerHealth = await providerRequest(fetchImpl, provider.health.url, credential, timeoutMs);
    if (!providerHealth.ok) {
      cancelResponseBody(providerHealth, "claimed Provider health returned an error");
      throw new Error(`claimed Provider health returned HTTP ${providerHealth.status}`);
    }
    if (mediaType(providerHealth) !== "application/json") {
      cancelResponseBody(providerHealth, "claimed Provider health returned the wrong content type");
      throw new Error("claimed Provider health returned the wrong content type");
    }
    const parsedHealth = agentProviderHealthSchema.safeParse(parseJson(
      await responseBytes(providerHealth, MAX_PROVIDER_HEALTH_BYTES),
      "claimed Provider health",
    ));
    if (!parsedHealth.success) throw new Error("claimed Provider health violated its schema");
    const semanticHealth = parsedHealth.data;
    const healthAgeMs = (options.now?.() ?? Date.now()) - Date.parse(semanticHealth.probe?.observedAt ?? "");
    if (
      semanticHealth.name !== provider.name
      || semanticHealth.capability !== provider.capability
      || !semanticHealth.ready
      || !semanticHealth.acceptingRequests
      || !semanticHealth.probe?.validated
      || semanticHealth.probe.protocol !== provider.protocol
      || !Number.isFinite(healthAgeMs)
      || healthAgeMs < -provider.health.maxAgeMs
      || healthAgeMs > provider.health.maxAgeMs
    ) {
      throw new Error("claimed Provider did not pass semantic readiness");
    }

    const completionUrl = `${provider.baseUrl}/chat/completions`;
    const jsonResponse = await providerRequest(fetchImpl, completionUrl, credential, timeoutMs, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        temperature: 0,
        max_tokens: 8,
        stream: false,
      }),
    });
    if (!jsonResponse.ok) {
      cancelResponseBody(jsonResponse, "OpenAI JSON completion returned an error");
      throw new Error(`OpenAI JSON completion returned HTTP ${jsonResponse.status}`);
    }
    if (mediaType(jsonResponse) !== "application/json") {
      cancelResponseBody(jsonResponse, "OpenAI JSON completion returned the wrong content type");
      throw new Error("OpenAI JSON completion returned the wrong content type");
    }
    validateJsonCompletion(await responseBytes(jsonResponse));

    const sseResponse = await providerRequest(fetchImpl, completionUrl, credential, timeoutMs, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        temperature: 0,
        max_tokens: 8,
        stream: true,
      }),
    });
    if (!sseResponse.ok) {
      cancelResponseBody(sseResponse, "OpenAI SSE completion returned an error");
      throw new Error(`OpenAI SSE completion returned HTTP ${sseResponse.status}`);
    }
    if (mediaType(sseResponse) !== "text/event-stream") {
      cancelResponseBody(sseResponse, "OpenAI SSE completion returned the wrong content type");
      throw new Error("OpenAI SSE completion returned the wrong content type");
    }
    const sse = inspectOpenAiChatCompletionSse(await responseBytes(sseResponse));
    if (!sse.ok) throw new Error(`OpenAI SSE completion is invalid: ${sse.reason}`);

    await larm.releaseAgentConnection(connection.id);
    released = true;
    const releasedConnection = await larm.getAgentConnection(connection.id);
    if (releasedConnection.status !== "released" || !releasedConnection.releasedAt) {
      throw new Error("released Agent Connection is not observable as released");
    }
    const revoked = await providerRequest(fetchImpl, provider.health.url, credential, Math.min(timeoutMs, 15_000));
    cancelResponseBody(revoked, "released Provider credential check completed");
    if (revoked.status !== 401) throw new Error(`released Provider credential returned HTTP ${revoked.status}`);

    const finalActivity = await larm.getServiceActivity();
    if ((options.requireIdleAfterRelease ?? true) && finalActivity.state !== "idle") {
      throw new Error(`LARM retained active work after release: ${finalActivity.state}`);
    }
    return {
      ok: true,
      releaseCommit: health.releaseCommit,
      configRevision: health.configRevision,
      bootEpoch: health.bootEpoch,
      agentProfile: profile.id,
      audience: options.audience,
      provider: provider.name,
      model: provider.model,
      initialActivity: initialActivity.state,
      finalActivity: finalActivity.state,
      jsonValidated: true,
      sse: { chunks: sse.chunks, deltas: sse.deltas, finishReasons: sse.finishReasons },
      released: true,
      credentialRevoked: true,
    };
  } catch (error) {
    if (connectionId && !released) {
      try {
        await larm.releaseAgentConnection(connectionId);
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], `Agent HTTP smoke failed and ${connectionId} could not be released`);
      }
    }
    throw error;
  }
}

function envInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return integerOption(Number(raw), fallback, name, maximum);
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(`${name} must be 0 or 1`);
}

if (import.meta.main) {
  try {
    const result = await runAgentHttpSmoke({
      baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
      ...(process.env.LARM_API_TOKEN ? { apiToken: process.env.LARM_API_TOKEN } : {}),
      agentProfile: process.env.LARM_AGENT_PROFILE ?? "coding-default",
      audience: process.env.LARM_AGENT_AUDIENCE ?? "same-host",
      client: process.env.LARM_AGENT_CLIENT ?? "larm-agent-http-smoke",
      ...(process.env.LARM_AGENT_PROVIDER ? { provider: process.env.LARM_AGENT_PROVIDER } : {}),
      ...(process.env.LARM_EXPECTED_MODEL ? { expectedModel: process.env.LARM_EXPECTED_MODEL } : {}),
      ...(process.env.LARM_EXPECTED_RELEASE_COMMIT
        ? { expectedReleaseCommit: process.env.LARM_EXPECTED_RELEASE_COMMIT }
        : {}),
      requireReleaseIdentity: envBoolean("LARM_HTTP_SMOKE_REQUIRE_RELEASE_IDENTITY", true),
      requireIdleBeforeCreate: envBoolean("LARM_HTTP_SMOKE_REQUIRE_INITIAL_IDLE", true),
      requireIdleAfterRelease: envBoolean("LARM_HTTP_SMOKE_REQUIRE_IDLE", true),
      timeoutMs: envInteger("LARM_HTTP_SMOKE_TIMEOUT_MS", 300_000, 3_600_000),
      ttlSeconds: envInteger("LARM_AGENT_TTL_SECONDS", 300, 86_400),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`Agent HTTP smoke failed: ${message}`);
    process.exitCode = 1;
  }
}
