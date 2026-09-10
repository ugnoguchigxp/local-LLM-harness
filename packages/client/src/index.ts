import {
  allocationRequestSchema,
  agentConnectionClaimSchema,
  agentConnectionClaimRequestSchema,
  agentConnectionHealthSchema,
  agentConnectionRequestSchema,
  agentConnectionRenewRequestSchema,
  controlOperationSchema,
  contextListSchema,
  contextRegistrationRequestSchema,
  contextStatusSchema,
  contextViewRequestSchema,
  daemonHealthSchema,
  errorResponseSchema,
  LARM_SERVICE_ACTIVITY_VALID_FOR_MS,
  openAiModelListSchema,
  publicAllocationSchema,
  publicContextDescriptorSchema,
  publicContextOperationSchema,
  publicContextViewSchema,
  publicAgentConnectionSchema,
  publicAgentProfileListSchema,
  publicAgentProfileListV3Schema,
  readinessSchema,
  releaseConvergenceStatusSchema,
  serviceActivitySchema,
  OpenAiChatCompletionSseInspector,
  embeddingAgentProviderDescriptorSchema,
  embeddingRequestSchema,
  inspectEmbeddingResponse,
  type AgentConnectionClaim,
  type AgentConnectionClaimRequest,
  type AgentConnectionHealth,
  type AgentConnectionRequestInput,
  type AllocationRequestInput,
  type ControlOperation,
  type ContextRegistrationRequest,
  type ContextViewRequest,
  type PublicAllocation,
  type PublicAgentConnection,
  type ServiceActivity,
  type OpenAiModelList,
  type OpenAiChatCompletionSseChunk,
  type ReleaseConvergenceStatus,
  type EmbeddingRequest,
  type EmbeddingResponse,
} from "@larm/core";

export type EmbeddingAgentProvider = Extract<
  AgentConnectionClaim["providers"][number],
  { apiStyle: "larm-embedding" }
>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type LarmClientOptions = {
  baseUrl: string;
  apiToken?: string;
  managementToken?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  random?: () => string;
  now?: () => number;
};

export type RequestOptions = {
  signal?: AbortSignal;
  idempotencyKey?: string;
  management?: boolean;
};

export class LarmApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "LarmApiError";
  }
}

export class LarmClientConfigurationError extends Error {
  constructor(
    readonly code: "api_token_missing",
    message: string,
  ) {
    super(message);
    this.name = "LarmClientConfigurationError";
  }
}

export class LarmEpochChangedError extends Error {
  constructor(readonly previous: string, readonly current: string) {
    super(`LARM boot epoch changed from ${previous} to ${current}; start a new request lifecycle`);
    this.name = "LarmEpochChangedError";
  }
}

export class LarmStreamProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LarmStreamProtocolError";
  }
}

export class LarmClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private bootEpoch?: string;
  private configRevision?: string;

  constructor(private readonly options: LarmClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("LARM baseUrl must use http or https");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("LARM baseUrl must not contain credentials, query, or fragment");
    }
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("LARM timeoutMs must be a positive finite number");
    }
  }

  get observedBootEpoch(): string | undefined {
    return this.bootEpoch;
  }

  get observedConfigRevision(): string | undefined {
    return this.configRevision;
  }

  get hasApiToken(): boolean {
    return Boolean(this.options.apiToken);
  }

  async getHealth(signal?: AbortSignal) {
    const response = await this.request(
      "/health",
      { signal },
      false,
      this.timeoutMs,
      [],
      false,
    );
    return this.parseJson(response, daemonHealthSchema);
  }

  async getReadiness(signal?: AbortSignal) {
    const response = await this.request(
      "/ready",
      { signal },
      false,
      this.timeoutMs,
      [503],
      false,
    );
    return this.parseJson(response, readinessSchema);
  }

  async getReleaseConvergenceStatus(signal?: AbortSignal): Promise<ReleaseConvergenceStatus> {
    const response = await this.request("/v1/release-convergence", { signal });
    return this.parseJson(response, releaseConvergenceStatusSchema);
  }

  async getServiceActivity(signal?: AbortSignal): Promise<ServiceActivity> {
    const response = await this.request(
      "/v1/activity",
      { signal },
      false,
      Math.min(this.timeoutMs, LARM_SERVICE_ACTIVITY_VALID_FOR_MS),
    );
    const activity = await this.parseJson(response, serviceActivitySchema);
    const ageMs = (this.options.now?.() ?? Date.now()) - Date.parse(activity.observedAt);
    if (!Number.isFinite(ageMs) || ageMs < -activity.validForMs || ageMs > activity.validForMs) {
      throw new LarmApiError(
        503,
        "activity_stale",
        "LARM service activity snapshot is outside its validity window",
        activity,
      );
    }
    return activity;
  }

  async allocate(request: AllocationRequestInput, options: RequestOptions = {}): Promise<PublicAllocation> {
    const normalized = allocationRequestSchema.parse(request);
    const response = await this.request("/v1/allocations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? this.createIdempotencyKey(),
      },
      body: JSON.stringify(normalized),
      signal: options.signal,
    }, options.management ?? normalized.deploymentPolicy === "allow-listed");
    return this.parseJson(response, publicAllocationSchema);
  }

  async getAllocation(id: string, signal?: AbortSignal): Promise<PublicAllocation> {
    return await this.getAllocationWithin(id, signal, this.timeoutMs);
  }

  private async getAllocationWithin(
    id: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<PublicAllocation> {
    const response = await this.request(
      `/v1/allocations/${encodeURIComponent(id)}`,
      { signal },
      false,
      timeoutMs,
    );
    return this.parseJson(response, publicAllocationSchema);
  }

  async waitUntilReady(
    allocation: PublicAllocation,
    options: { signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<PublicAllocation> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    this.validatePollingOptions(timeoutMs, pollIntervalMs);
    const deadline = Date.now() + timeoutMs;
    let current = allocation;
    while (current.status === "waiting" || current.status === "pending") {
      if (Date.now() >= deadline) {
        throw new LarmApiError(
          408,
          "allocation_timeout",
          `allocation ${current.id} did not become ready before the client deadline`,
          current,
        );
      }
      await this.delay(
        Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())),
        options.signal,
      );
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw this.allocationTimeout(current);
      }
      try {
        current = await this.getAllocationWithin(current.id, options.signal, remainingMs);
      } catch (error) {
        if (Date.now() >= deadline) throw this.allocationTimeout(current);
        throw error;
      }
    }
    if (current.status !== "ready") {
      throw new LarmApiError(409, current.error?.code ?? "allocation_not_ready", current.error?.message
        ?? `allocation ${current.id} ended as ${current.status}`, current);
    }
    return current;
  }

  async renew(id: string, ttlSeconds = 300, signal?: AbortSignal): Promise<PublicAllocation> {
    const response = await this.request(`/v1/allocations/${encodeURIComponent(id)}/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ttlSeconds }),
      signal,
    });
    return this.parseJson(response, publicAllocationSchema);
  }

  async release(id: string, signal?: AbortSignal): Promise<PublicAllocation> {
    const response = await this.request(`/v1/allocations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal,
    });
    return this.parseJson(response, publicAllocationSchema);
  }

  async getContextStatus(signal?: AbortSignal) {
    const response = await this.request("/v1/context-status", { signal });
    return this.parseJson(response, contextStatusSchema);
  }

  async registerContext(
    input: ContextRegistrationRequest,
    options: RequestOptions = {},
  ) {
    const request = contextRegistrationRequestSchema.parse(input);
    const response = await this.request("/v1/contexts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? this.createIdempotencyKey(),
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    return this.parseJson(response, publicContextDescriptorSchema);
  }

  async listContexts(options: { signal?: AbortSignal; cursor?: string; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const response = await this.request(`/v1/contexts${query.size > 0 ? `?${query}` : ""}`, {
      signal: options.signal,
    });
    return this.parseJson(response, contextListSchema);
  }

  async deleteContext(id: string, options: RequestOptions = {}): Promise<void> {
    const response = await this.request(`/v1/contexts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        "idempotency-key": options.idempotencyKey ?? this.createIdempotencyKey(),
      },
      signal: options.signal,
    });
    await response.body?.cancel().catch(() => undefined);
  }

  async createContextView(input: ContextViewRequest, options: RequestOptions = {}) {
    const request = contextViewRequestSchema.parse(input);
    const response = await this.request("/v1/context-views", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? this.createIdempotencyKey(),
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    return this.parseJson(response, publicContextViewSchema);
  }

  async getContextOperation(id: string, signal?: AbortSignal) {
    const response = await this.request(`/v1/context-operations/${encodeURIComponent(id)}`, { signal });
    return this.parseJson(response, publicContextOperationSchema);
  }

  async listAgentProfiles(signal?: AbortSignal) {
    const response = await this.request("/v2/agent-profiles", { signal });
    return this.parseJson(response, publicAgentProfileListSchema);
  }

  async listAgentProfilesV3(signal?: AbortSignal) {
    const response = await this.request("/v3/agent-profiles", { signal });
    return this.parseJson(response, publicAgentProfileListV3Schema);
  }

  async createAgentConnection(
    request: AgentConnectionRequestInput,
    options: RequestOptions = {},
  ): Promise<PublicAgentConnection> {
    const normalized = agentConnectionRequestSchema.parse(request);
    const response = await this.request("/v1/agent-connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? this.createIdempotencyKey(),
      },
      body: JSON.stringify(normalized),
      signal: options.signal,
    }, options.management ?? normalized.deploymentPolicy === "allow-listed");
    return this.parseJson(response, publicAgentConnectionSchema);
  }

  async getAgentConnection(id: string, signal?: AbortSignal): Promise<PublicAgentConnection> {
    return await this.getAgentConnectionWithin(id, signal, this.timeoutMs);
  }

  private async getAgentConnectionWithin(
    id: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<PublicAgentConnection> {
    const response = await this.request(
      `/v1/agent-connections/${encodeURIComponent(id)}`,
      { signal },
      false,
      timeoutMs,
    );
    return this.parseJson(response, publicAgentConnectionSchema);
  }

  async waitForAgentConnection(
    connection: PublicAgentConnection,
    options: { signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<PublicAgentConnection> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    this.validatePollingOptions(timeoutMs, pollIntervalMs);
    const deadline = Date.now() + timeoutMs;
    let current = publicAgentConnectionSchema.parse(connection);
    while (current.status === "pending" || current.status === "probing") {
      if (Date.now() >= deadline) {
        throw new LarmApiError(408, "connection_timeout", `connection ${current.id} did not become ready`, current);
      }
      await this.delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw this.connectionTimeout(current);
      try {
        current = await this.getAgentConnectionWithin(current.id, options.signal, remainingMs);
      } catch (error) {
        if (Date.now() >= deadline) throw this.connectionTimeout(current);
        throw error;
      }
    }
    if (current.status !== "ready") {
      throw new LarmApiError(
        409,
        current.error?.code ?? "connection_not_ready",
        current.error?.message ?? `connection ${current.id} ended as ${current.status}`,
        current,
      );
    }
    return current;
  }

  async getAgentConnectionHealth(
    id: string,
    signal?: AbortSignal,
  ): Promise<AgentConnectionHealth> {
    const response = await this.request(
      `/v1/agent-connections/${encodeURIComponent(id)}/health`,
      { signal },
      false,
      this.timeoutMs,
      [503],
    );
    return this.parseJson(response, agentConnectionHealthSchema);
  }

  async claimAgentConnection(
    id: string,
    formatOrSignal: AgentConnectionClaimRequest["format"] | AbortSignal = "openai-provider-v1",
    signal?: AbortSignal,
  ): Promise<AgentConnectionClaim> {
    const format = typeof formatOrSignal === "string" ? formatOrSignal : "openai-provider-v1";
    const requestSignal = typeof formatOrSignal === "string" ? signal : formatOrSignal;
    const body = agentConnectionClaimRequestSchema.parse({ format });
    const response = await this.request(`/v1/agent-connections/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    return this.parseJson(response, agentConnectionClaimSchema);
  }

  async renewAgentConnection(
    id: string,
    ttlSeconds = 300,
    options: RequestOptions = {},
  ): Promise<PublicAgentConnection> {
    const body = agentConnectionRenewRequestSchema.parse({ ttlSeconds });
    const response = await this.request(`/v1/agent-connections/${encodeURIComponent(id)}/renew`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? this.createIdempotencyKey(),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    return this.parseJson(response, publicAgentConnectionSchema);
  }

  async releaseAgentConnection(id: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`/v1/agent-connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal,
    });
    await response.body?.cancel().catch(() => undefined);
  }

  async withAgentConnection<T>(
    request: AgentConnectionRequestInput,
    handler: (
      connection: PublicAgentConnection,
      claim: AgentConnectionClaim,
      client: LarmClient,
    ) => Promise<T>,
    options: RequestOptions & {
      pollIntervalMs?: number;
      timeoutMs?: number;
      claimFormat?: AgentConnectionClaimRequest["format"];
    } = {},
  ): Promise<T> {
    const created = await this.createAgentConnection(request, options);
    const outcome: { ok: true; value: T } | { ok: false; error: unknown } = await (async () => {
      try {
        const ready = await this.waitForAgentConnection(created, options);
        const claim = await this.claimAgentConnection(
          ready.id,
          options.claimFormat,
          options.signal,
        );
        return { ok: true as const, value: await handler(ready, claim, this) };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();
    try {
      // Cleanup deliberately uses a fresh bounded request, even when the lifecycle signal was cancelled.
      await this.releaseAgentConnection(created.id);
    } catch (releaseError) {
      if (!outcome.ok) {
        throw new AggregateError(
          [outcome.error, releaseError],
          `agent connection ${created.id} failed and could not be released`,
        );
      }
      throw releaseError;
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async getOperation(id: string, signal?: AbortSignal) {
    return await this.getOperationWithin(id, signal, this.timeoutMs);
  }

  private async getOperationWithin(id: string, signal: AbortSignal | undefined, timeoutMs: number) {
    const response = await this.request(
      `/v1/operations/${encodeURIComponent(id)}`,
      { signal },
      false,
      timeoutMs,
    );
    return this.parseJson(response, controlOperationSchema);
  }

  async waitForOperation(
    operation: ControlOperation | string,
    options: { signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<ControlOperation> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    this.validatePollingOptions(timeoutMs, pollIntervalMs);
    const deadline = Date.now() + timeoutMs;
    let current: ControlOperation;
    if (typeof operation === "string") {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw this.operationTimeout(operation);
      try {
        current = await this.getOperationWithin(operation, options.signal, remainingMs);
      } catch (error) {
        if (Date.now() >= deadline) throw this.operationTimeout(operation);
        throw error;
      }
    } else {
      current = controlOperationSchema.parse(operation);
    }
    while (current.status === "pending" || current.status === "running") {
      if (Date.now() >= deadline) {
        throw this.operationTimeout(current.id, current);
      }
      await this.delay(
        Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())),
        options.signal,
      );
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw this.operationTimeout(current.id, current);
      try {
        current = await this.getOperationWithin(current.id, options.signal, remainingMs);
      } catch (error) {
        if (Date.now() >= deadline) throw this.operationTimeout(current.id, current);
        throw error;
      }
    }
    if (current.status !== "succeeded") {
      throw new LarmApiError(
        current.status === "timed_out" ? 408 : 409,
        current.error?.code ?? `operation_${current.status}`,
        current.error?.message ?? `operation ${current.id} ended as ${current.status}`,
        current,
      );
    }
    return current;
  }

  async withAllocation<T>(
    request: AllocationRequestInput,
    handler: (allocation: PublicAllocation, client: LarmClient) => Promise<T>,
    options: RequestOptions & { pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const allocated = await this.allocate(request, options);
    const outcome: { ok: true; value: T } | { ok: false; error: unknown } = await (async () => {
      try {
        const ready = await this.waitUntilReady(allocated, options);
        return { ok: true as const, value: await handler(ready, this) };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();
    try {
      await this.release(allocated.id);
    } catch (releaseError) {
      if (!outcome.ok) {
        throw new AggregateError(
          [outcome.error, releaseError],
          `allocation ${allocated.id} failed and could not be released`,
        );
      }
      throw releaseError;
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async listOpenAiModels(signal?: AbortSignal): Promise<OpenAiModelList> {
    const response = await this.request("/v1/models", { signal });
    return this.parseJson(response, openAiModelListSchema);
  }

  async embed(
    claimedProvider: EmbeddingAgentProvider,
    input: EmbeddingRequest,
    signal?: AbortSignal,
  ): Promise<EmbeddingResponse> {
    const provider = embeddingAgentProviderDescriptorSchema.parse(claimedProvider);
    const request = embeddingRequestSchema.parse(input);
    const abort = new AbortController();
    const onAbort = () => abort.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => abort.abort(new Error("LARM embedding client timeout")),
      this.timeoutMs,
    );
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(provider.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${provider.credential.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(request),
        redirect: "manual",
        signal: abort.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel(new Error("provider redirect is forbidden")).catch(() => undefined);
        throw new LarmApiError(502, "provider_redirect_forbidden", "embedding provider returned a redirect");
      }
      const bytes = await this.readResponseLimited(response, 2 * 1024 * 1024);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new LarmApiError(502, "embedding_response_invalid", "embedding provider returned invalid JSON");
      }
      if (!response.ok) {
        const parsed = errorResponseSchema.safeParse(value);
        throw new LarmApiError(
          response.status,
          parsed.success ? parsed.data.error.code : "embedding_http_error",
          parsed.success ? parsed.data.error.message : `embedding provider returned HTTP ${response.status}`,
        );
      }
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        throw new LarmApiError(502, "embedding_response_invalid", "embedding provider did not return JSON");
      }
      const inspected = inspectEmbeddingResponse({ value, request, space: provider.embeddingSpace });
      if (!inspected.ok) {
        throw new LarmApiError(
          502,
          `embedding_${inspected.reason}`,
          "embedding provider response does not match the claimed semantic space",
        );
      }
      return inspected.response;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  createChatCompletion(body: unknown, options: RequestOptions = {}): Promise<Response> {
    return this.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  async *streamChatCompletion(
    body: Record<string, unknown>,
    options: RequestOptions = {},
  ): AsyncGenerator<OpenAiChatCompletionSseChunk> {
    const response = await this.createChatCompletion({ ...body, stream: true }, options);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "text/event-stream") {
      await response.body?.cancel(new Error("stream content type mismatch")).catch(() => undefined);
      throw new LarmStreamProtocolError(
        "stream_content_type_invalid",
        "Chat Completions stream did not return text/event-stream",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new LarmStreamProtocolError("stream_body_missing", "Chat Completions stream has no body");
    }
    const pending: OpenAiChatCompletionSseChunk[] = [];
    const inspector = new OpenAiChatCompletionSseInspector((chunk) => pending.push(chunk));
    let completed = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const progress = inspector.push(next.value);
        if (!progress.ok) {
          throw new LarmStreamProtocolError(
            `stream_${progress.reason}`,
            `Chat Completions stream failed validation: ${progress.reason}`,
          );
        }
        while (pending.length > 0) yield pending.shift()!;
      }
      const inspected = inspector.finish();
      if (!inspected.ok) {
        throw new LarmStreamProtocolError(
          `stream_${inspected.reason}`,
          `Chat Completions stream failed validation: ${inspected.reason}`,
        );
      }
      while (pending.length > 0) yield pending.shift()!;
      completed = true;
    } finally {
      if (!completed) await reader.cancel(new Error("stream consumer stopped")).catch(() => undefined);
      reader.releaseLock();
    }
  }

  createAudioTranscription(
    body: RequestInit["body"],
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.request("/v1/audio/transcriptions", {
      method: "POST",
      body,
      signal: options.signal,
    });
  }

  createSpeech(body: unknown, options: RequestOptions = {}): Promise<Response> {
    return this.request("/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  chat(allocationId: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    return this.gateway("/v1/chat/completions", allocationId, body, options);
  }

  chatWithContext(
    allocationId: string,
    viewId: string,
    body: unknown,
    capability?: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-larm-allocation-id": allocationId,
        "x-larm-context-view-id": viewId,
        ...(capability ? { "x-larm-capability": capability } : {}),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  speech(allocationId: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    return this.gateway("/v1/audio/speech", allocationId, body, options);
  }

  transcribe(
    allocationId: string,
    body: RequestInit["body"],
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: { "x-larm-allocation-id": allocationId },
      body,
      signal: options.signal,
    });
  }

  voices(
    allocationId: string,
    capability?: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.request("/v1/audio/voices", {
      headers: {
        "x-larm-allocation-id": allocationId,
        ...(capability ? { "x-larm-capability": capability } : {}),
      },
      signal: options.signal,
    });
  }

  private gateway(
    path: string,
    allocationId: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-larm-allocation-id": allocationId,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  }

  private async request(
    path: string,
    init: RequestInit,
    management = false,
    timeoutMs = this.timeoutMs,
    acceptedStatuses: readonly number[] = [],
    sendApiToken = true,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (sendApiToken && this.options.apiToken) {
      headers.set("authorization", `Bearer ${this.options.apiToken}`);
    }
    if (management) {
      if (!this.options.managementToken) {
        throw new Error("LARM management token is required for this request");
      }
      headers.set("x-larm-management-token", this.options.managementToken);
    }
    const abort = new AbortController();
    const upstreamSignal = init.signal;
    const onAbort = () => abort.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) {
      onAbort();
    } else {
      upstreamSignal?.addEventListener("abort", onAbort, { once: true });
    }
    const timeout = setTimeout(
      () => abort.abort(new Error("LARM client timeout")),
      Math.max(0, timeoutMs),
    );
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: abort.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", onAbort);
      throw error;
    }
    try {
      this.observeIdentity(response);
    } catch (error) {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", onAbort);
      void response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      const body = await response.clone().json().catch(() => undefined);
      await response.body?.cancel().catch(() => undefined);
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", onAbort);
      const parsed = errorResponseSchema.safeParse(body);
      throw new LarmApiError(
        response.status,
        parsed.success ? parsed.data.error.code : "http_error",
        parsed.success ? parsed.data.error.message : `LARM returned HTTP ${response.status}`,
        body,
      );
    }
    if (!response.body) {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", onAbort);
      return response;
    }
    const reader = response.body.getReader();
    let cleaned = false;
    let managedController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let onManagedAbort: () => void = () => undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", onAbort);
      abort.signal.removeEventListener("abort", onManagedAbort);
    };
    onManagedAbort = () => {
      const reason = abort.signal.reason ?? new Error("LARM request aborted");
      void reader.cancel(reason).catch(() => undefined);
      cleanup();
      managedController?.error(reason);
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        managedController = controller;
        abort.signal.addEventListener("abort", onManagedAbort, { once: true });
        if (abort.signal.aborted) onManagedAbort();
      },
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            cleanup();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          cleanup();
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        abort.abort(reason);
        cleanup();
        await reader.cancel(reason).catch(() => undefined);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private observeIdentity(response: Response): void {
    const revision = response.headers.get("x-larm-config-revision");
    if (revision) this.configRevision = revision;
    const epoch = response.headers.get("x-larm-boot-epoch");
    if (!epoch) {
      return;
    }
    if (this.bootEpoch && this.bootEpoch !== epoch) {
      const previous = this.bootEpoch;
      this.bootEpoch = epoch;
      throw new LarmEpochChangedError(previous, epoch);
    }
    this.bootEpoch = epoch;
  }

  private async readResponseLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
      await response.body?.cancel(new Error("embedding response too large")).catch(() => undefined);
      throw new LarmApiError(502, "embedding_response_too_large", "embedding provider response is too large");
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
          throw new LarmApiError(502, "embedding_response_too_large", "embedding provider response is too large");
        }
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private async parseJson<T>(response: Response, schema: { parse(input: unknown): T }): Promise<T> {
    return schema.parse(await response.json());
  }

  private createIdempotencyKey(): string {
    return `client_${(this.options.random ?? (() => crypto.randomUUID()))()}`;
  }

  private allocationTimeout(allocation: PublicAllocation): LarmApiError {
    return new LarmApiError(
      408,
      "allocation_timeout",
      `allocation ${allocation.id} did not become ready before the client deadline`,
      allocation,
    );
  }

  private operationTimeout(id: string, operation?: ControlOperation): LarmApiError {
    return new LarmApiError(
      408,
      "operation_timeout",
      `operation ${id} did not complete before the client deadline`,
      operation,
    );
  }

  private connectionTimeout(connection: PublicAgentConnection): LarmApiError {
    return new LarmApiError(
      408,
      "connection_timeout",
      `connection ${connection.id} did not become ready before the client deadline`,
      connection,
    );
  }

  private validatePollingOptions(timeoutMs: number, pollIntervalMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("poll timeoutMs must be a nonnegative finite number");
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
      throw new RangeError("pollIntervalMs must be a nonnegative finite number");
    }
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
