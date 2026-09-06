import {
  agentProviderHealthSchema,
  inspectOpenAiChatCompletionSse,
  type AgentProviderProfile,
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

function integerOption(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return selected;
}

function selectedProfile(
  profiles: Awaited<ReturnType<LarmClient["listAgentProfiles"]>>,
  id: string,
): Awaited<ReturnType<LarmClient["listAgentProfiles"]>>["profiles"][number] {
  const profile = profiles.profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Agent Profile is not advertised: ${id}`);
  if (profile.deprecated) throw new Error(`Agent Profile is deprecated: ${id}`);
  return profile;
}

function selectedProvider(
  profile: ReturnType<typeof selectedProfile>,
  name: string,
): AgentProviderProfile {
  const provider = profile.providers.find((candidate) => candidate.name === name);
  if (!provider) throw new Error(`Agent Provider is not advertised by ${profile.id}: ${name}`);
  if (provider.protocol !== "openai.chat-completions.v1") {
    throw new Error(`Agent Provider does not use OpenAI Chat Completions: ${name}`);
  }
  return {
    name: provider.name,
    capability: provider.capability,
    supportedCapabilities: provider.supportedCapabilities,
    route: "advertised-only",
    publicModel: provider.model,
    protocol: provider.protocol,
    readiness: "llm-inference",
    ...(provider.streamingProtocol ? { streamingProtocol: provider.streamingProtocol } : {}),
  };
}

async function responseBytes(response: Response, limit = MAX_PROVIDER_RESPONSE_BYTES): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("provider_response_too_large");
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
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("OpenAI JSON completion response is not valid UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenAI JSON completion response is not an object");
  }
  const choices = (value as Record<string, unknown>).choices;
  const meaningful = Array.isArray(choices) && choices.some((choice) => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) return false;
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const record = message as Record<string, unknown>;
    return [record.content, record.reasoning_content].some(
      (part) => typeof part === "string" && part.length > 0,
    );
  });
  if (!meaningful) throw new Error("OpenAI JSON completion contains no content or reasoning content");
}

export async function runAgentHttpSmoke(options: AgentHttpSmokeOptions): Promise<AgentHttpSmokeResult> {
  const timeoutMs = integerOption(options.timeoutMs, 300_000, "timeoutMs", 3_600_000);
  const ttlSeconds = integerOption(options.ttlSeconds, 300, "ttlSeconds", 86_400);
  const providerName = options.provider ?? "llm";
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

  const profiles = await larm.listAgentProfiles();
  if (profiles.catalogRevision !== health.configRevision) {
    throw new Error("Agent Profile catalog revision does not match daemon health");
  }
  if (!profiles.audiences.includes(options.audience)) {
    throw new Error(`Agent audience is not advertised: ${options.audience}`);
  }
  const profile = selectedProfile(profiles, options.agentProfile);
  const advertised = selectedProvider(profile, providerName);
  if (options.expectedModel && advertised.publicModel !== options.expectedModel) {
    throw new Error(`model drift: expected ${options.expectedModel}, got ${advertised.publicModel}`);
  }

  let connectionId: string | undefined;
  let released = false;
  try {
    const created = await larm.createAgentConnection({
      agentProfile: profile.id,
      explicitAgentProfile: profile.selectionPolicy === "explicit-only",
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
    if (!connectionProvider?.claimable || connectionProvider.publicModel !== advertised.publicModel) {
      throw new Error("Agent Connection provider does not match its advertised profile");
    }

    const claim = await larm.claimAgentConnection(connection.id);
    const provider = claim.providers.find((candidate) => candidate.name === providerName);
    if (!provider || provider.model !== advertised.publicModel) {
      throw new Error("claimed Agent Provider does not match its advertised profile");
    }
    const credential = provider.credential.token;

    const providerHealth = await providerRequest(fetchImpl, provider.health.url, credential, timeoutMs);
    if (!providerHealth.ok) {
      await providerHealth.body?.cancel().catch(() => undefined);
      throw new Error(`claimed Provider health returned HTTP ${providerHealth.status}`);
    }
    const semanticHealth = agentProviderHealthSchema.parse(await providerHealth.json());
    if (!semanticHealth.ready || !semanticHealth.acceptingRequests || !semanticHealth.probe?.validated) {
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
      await jsonResponse.body?.cancel().catch(() => undefined);
      throw new Error(`OpenAI JSON completion returned HTTP ${jsonResponse.status}`);
    }
    if (!(jsonResponse.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      await jsonResponse.body?.cancel().catch(() => undefined);
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
      await sseResponse.body?.cancel().catch(() => undefined);
      throw new Error(`OpenAI SSE completion returned HTTP ${sseResponse.status}`);
    }
    const sseContentType = sseResponse.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (sseContentType !== "text/event-stream") {
      await sseResponse.body?.cancel().catch(() => undefined);
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
    await revoked.body?.cancel().catch(() => undefined);
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
