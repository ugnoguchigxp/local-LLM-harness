import {
  controlOperationSchema,
  daemonHealthSchema,
  LARM_SERVICE_ACTIVITY_VALID_FOR_MS,
  openAiModelListSchema,
  publicAgentProfileListV3Schema,
  readinessSchema,
  releaseConvergenceStatusSchema,
  serviceActivitySchema,
  type AgentConnectionClaim,
  type AudioSpeechRequest,
  type AudioVoiceList,
  type AgentConnectionClaimRequest,
  type AgentConnectionHealth,
  type AgentConnectionRequestInput,
  type AgentProfileSelectorId,
  type AllocationRequestInput,
  type CanonicalMeasurementRequest,
  type ControlOperation,
  type ContextRegistrationRequest,
  type ContextViewRequest,
  type ForgetRequestInput,
  type PersonalStateViewRequest,
  type PublicAllocation,
  type PublicAgentConnection,
  type ServiceActivity,
  type OpenAiModelList,
  type OpenAiChatCompletionSseChunk,
  type ReleaseConvergenceStatus,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type SystemOneRequest,
  type SystemOneResponse,
} from "@larm/core";
import {
  delay,
  validatePollingOptions,
  waitForOperation as waitForControlOperation,
} from "./client-helpers";
import {
  LarmApiError,
  LarmClientConfigurationError,
  LarmEpochChangedError,
} from "./errors";
import { sendClientRequest } from "./client-transport";
import { ClientMedia } from "./client-media";
import { ClientAllocationApi } from "./client-allocation-api";
import { ClientContextApi } from "./client-context-api";
import type { ClientRequestOptions as RequestOptions, PersonalStateRequestOptions } from "./client-context-api";
export type { ClientRequestOptions as RequestOptions, PersonalStateRequestOptions } from "./client-context-api";
import { ClientAgentConnections, type RefreshedAgentConnection } from "./client-agent-connections";
export type { RefreshedAgentConnection } from "./client-agent-connections";
import {
  embedWithClaimedProvider,
  systemOneWithClaimedProvider,
  type EmbeddingAgentProvider,
  type SystemOneAgentProvider,
} from "./client-provider-protocols";

export type { EmbeddingAgentProvider, SystemOneAgentProvider } from "./client-provider-protocols";

export { LarmApiError, LarmClientConfigurationError, LarmEpochChangedError, LarmStreamProtocolError } from "./errors";

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

export type AgentConnectionRefreshOptions = RequestOptions & {
  ttlSeconds?: number;
  claimFormat?: AgentConnectionClaimRequest["format"];
};

export class LarmClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly media: ClientMedia;
  private readonly allocationApi: ClientAllocationApi;
  private readonly contextApi: ClientContextApi;
  private readonly agentConnections: ClientAgentConnections;
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
    this.media = new ClientMedia((path, init) => this.request(path, init));
    this.allocationApi = new ClientAllocationApi({
      request: (path, init, management, timeoutMs) => this.request(path, init, management, timeoutMs),
      parseJson: (response, schema) => this.parseJson(response, schema),
      random: options.random,
      timeoutMs: this.timeoutMs,
    });
    this.contextApi = new ClientContextApi({
      request: (path, init, management, timeoutMs, acceptedStatuses, sendApiToken) => this.request(
        path,
        init,
        management,
        timeoutMs,
        acceptedStatuses,
        sendApiToken,
      ),
      parseJson: (response, schema) => this.parseJson(response, schema),
      random: options.random,
      timeoutMs: this.timeoutMs,
    });
    this.agentConnections = new ClientAgentConnections({
      request: (path, init, management, timeoutMs, acceptedStatuses, sendApiToken) => this.request(
        path,
        init,
        management,
        timeoutMs,
        acceptedStatuses,
        sendApiToken,
      ),
      parseJson: (response, schema) => this.parseJson(response, schema),
      random: options.random,
      timeoutMs: this.timeoutMs,
    });
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
    return this.allocationApi.allocate(request, options);
  }

  async getAllocation(id: string, signal?: AbortSignal): Promise<PublicAllocation> {
    return this.allocationApi.getAllocation(id, signal);
  }

  async waitUntilReady(
    allocation: PublicAllocation,
    options: { signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<PublicAllocation> {
    return this.allocationApi.waitUntilReady(allocation, options);
  }

  async renew(id: string, ttlSeconds = 300, signal?: AbortSignal): Promise<PublicAllocation> {
    return this.allocationApi.renew(id, ttlSeconds, signal);
  }

  async release(id: string, signal?: AbortSignal): Promise<PublicAllocation> {
    return this.allocationApi.release(id, signal);
  }

  async getContextStatus(signal?: AbortSignal) {
    return this.contextApi.getContextStatus(signal);
  }

  async registerContext(
    input: ContextRegistrationRequest,
    options: RequestOptions = {},
  ) {
    return this.contextApi.registerContext(input, options);
  }

  async listContexts(options: { signal?: AbortSignal; cursor?: string; limit?: number } = {}) {
    return this.contextApi.listContexts(options);
  }

  async deleteContext(id: string, options: RequestOptions = {}): Promise<void> {
    return this.contextApi.deleteContext(id, options);
  }

  async createContextView(input: ContextViewRequest, options: RequestOptions = {}) {
    return this.contextApi.createContextView(input, options);
  }

  async getContextOperation(id: string, signal?: AbortSignal) {
    return this.contextApi.getContextOperation(id, signal);
  }

  async getPersonalStateCapability(
    allocationId: string,
    runtime: string,
    options: PersonalStateRequestOptions,
  ) {
    return this.contextApi.getPersonalStateCapability(allocationId, runtime, options);
  }

  async provisionContextSource(input: {
    incarnation: string;
    allocationId: string;
    runtime: string;
    sourceDigest: string;
    content: string;
  }, options: PersonalStateRequestOptions) {
    return this.contextApi.provisionContextSource(input, options);
  }

  async getContextSourceOperation(
    incarnation: string,
    options: PersonalStateRequestOptions,
  ) {
    return this.contextApi.getContextSourceOperation(incarnation, options);
  }

  async registerPersonalStateContext(
    input: ContextRegistrationRequest,
    options: PersonalStateRequestOptions,
  ) {
    return this.contextApi.registerPersonalStateContext(input, options);
  }

  async createContextMeasurement(
    input: CanonicalMeasurementRequest,
    options: PersonalStateRequestOptions,
  ) {
    return this.contextApi.createContextMeasurement(input, options);
  }

  async getContextMeasurement(id: string, options: PersonalStateRequestOptions) {
    return this.contextApi.getContextMeasurement(id, options);
  }

  async createPersonalStateView(
    input: PersonalStateViewRequest,
    options: PersonalStateRequestOptions,
  ) {
    return this.contextApi.createPersonalStateView(input, options);
  }

  async getPersonalStateViewReceipt(id: string, options: PersonalStateRequestOptions) {
    return this.contextApi.getPersonalStateViewReceipt(id, options);
  }

  chatPersonalState(input: {
    allocationId: string;
    attemptId: string;
    viewId?: string;
    body: unknown;
  }, options: PersonalStateRequestOptions): Promise<Response> {
    return this.contextApi.chatPersonalState(input, options);
  }

  async getGenerationAttempt(id: string, options: PersonalStateRequestOptions) {
    return this.contextApi.getGenerationAttempt(id, options);
  }

  async cancelGenerationAttempt(id: string, options: PersonalStateRequestOptions) {
    return this.contextApi.cancelGenerationAttempt(id, options);
  }

  async forgetPersonalState(input: ForgetRequestInput, options: PersonalStateRequestOptions) {
    return this.contextApi.forgetPersonalState(input, options);
  }

  async getForgetOperation(id: string, options: PersonalStateRequestOptions) {
    return this.contextApi.getForgetOperation(id, options);
  }

  /** @deprecated Use listAgentProfilesV3; the v2 route is a compatibility surface. */
  async listAgentProfiles(signal?: AbortSignal) {
    return this.agentConnections.listAgentProfiles(signal);
  }

  async listAgentProfilesV3(signal?: AbortSignal): Promise<ReturnType<typeof publicAgentProfileListV3Schema.parse>>;
  async listAgentProfilesV3(
    profile: AgentProfileSelectorId,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof publicAgentProfileListV3Schema.parse>>;
  async listAgentProfilesV3(profileOrSignal?: string | AbortSignal, signal?: AbortSignal) {
    return typeof profileOrSignal === "string"
      ? this.agentConnections.listAgentProfilesV3(profileOrSignal as AgentProfileSelectorId, signal)
      : this.agentConnections.listAgentProfilesV3(profileOrSignal);
  }

  async createAgentConnection(
    request: AgentConnectionRequestInput,
    options: RequestOptions = {},
  ): Promise<PublicAgentConnection> {
    return this.agentConnections.create(request, options);
  }

  async getAgentConnection(id: string, signal?: AbortSignal): Promise<PublicAgentConnection> {
    return this.agentConnections.get(id, signal);
  }

  async waitForAgentConnection(
    connection: PublicAgentConnection,
    options: { signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<PublicAgentConnection> {
    return this.agentConnections.waitUntilReady(connection, options);
  }

  async getAgentConnectionHealth(
    id: string,
    signal?: AbortSignal,
  ): Promise<AgentConnectionHealth> {
    return this.agentConnections.getHealth(id, signal);
  }

  async claimAgentConnection(
    id: string,
    formatOrSignal: AgentConnectionClaimRequest["format"] | AbortSignal = "openai-provider-v1",
    signal?: AbortSignal,
  ): Promise<AgentConnectionClaim> {
    return this.agentConnections.claim(id, formatOrSignal, signal);
  }

  async renewAgentConnection(
    id: string,
    ttlSeconds = 300,
    options: RequestOptions = {},
  ): Promise<PublicAgentConnection> {
    return this.agentConnections.renew(id, ttlSeconds, options);
  }

  async refreshAgentConnection(
    id: string,
    options: AgentConnectionRefreshOptions = {},
  ): Promise<RefreshedAgentConnection> {
    return this.agentConnections.refresh(id, options);
  }

  async releaseAgentConnection(id: string, signal?: AbortSignal): Promise<void> {
    return this.agentConnections.release(id, signal);
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
    return await waitForControlOperation({
      operation: typeof operation === "string" ? operation : controlOperationSchema.parse(operation),
      signal: options.signal,
      pollIntervalMs: options.pollIntervalMs ?? 250,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      getOperation: (id, signal, timeoutMs) => this.getOperationWithin(id, signal, timeoutMs),
    });
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
    return await embedWithClaimedProvider({
      fetch: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      claimedProvider,
      requestInput: input,
      signal,
    });
  }

  async systemOne(
    claimedProvider: SystemOneAgentProvider,
    input: SystemOneRequest,
    signal?: AbortSignal,
  ): Promise<SystemOneResponse> {
    return await systemOneWithClaimedProvider({
      fetch: this.fetchImpl,
      claimedProvider,
      requestInput: input,
      signal,
    });
  }

  createChatCompletion(body: unknown, options: RequestOptions = {}): Promise<Response> {
    return this.media.createChatCompletion(body, options);
  }

  async *streamChatCompletion(
    body: Record<string, unknown>,
    options: RequestOptions = {},
  ): AsyncGenerator<OpenAiChatCompletionSseChunk> {
    yield* this.media.streamChatCompletion(body, options);
  }

  createAudioTranscription(
    body: RequestInit["body"],
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.media.createAudioTranscription(body, options);
  }

  createSpeech(body: AudioSpeechRequest, options: RequestOptions = {}): Promise<Response> {
    return this.media.createSpeech(body, options);
  }

  listVoices(model: string, options: RequestOptions = {}): Promise<Response> {
    return this.media.listVoices(model, options);
  }

  getVoicevoxCatalog(options: RequestOptions = {}): Promise<AudioVoiceList> {
    return this.media.getVoicevoxCatalog(options);
  }

  chat(allocationId: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    return this.media.chat(allocationId, body, options);
  }

  chatWithContext(
    allocationId: string,
    viewId: string,
    body: unknown,
    capability?: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.media.chatWithContext(allocationId, viewId, body, capability, options);
  }

  speech(allocationId: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    return this.media.speech(allocationId, body, options);
  }

  transcribe(
    allocationId: string,
    body: RequestInit["body"],
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.media.transcribe(allocationId, body, options);
  }

  voices(
    allocationId: string,
    capability?: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    return this.media.voices(allocationId, capability, options);
  }

  private async request(
    path: string,
    init: RequestInit,
    management = false,
    timeoutMs = this.timeoutMs,
    acceptedStatuses: readonly number[] = [],
    sendApiToken = true,
  ): Promise<Response> {
    return sendClientRequest({
      baseUrl: this.baseUrl,
      fetch: this.fetchImpl,
      apiToken: this.options.apiToken,
      managementToken: this.options.managementToken,
      path,
      init,
      management,
      timeoutMs,
      acceptedStatuses,
      sendApiToken,
      observeIdentity: (response) => this.observeIdentity(response),
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

  private async parseJson<T>(response: Response, schema: { parse(input: unknown): T }): Promise<T> {
    return schema.parse(await response.json());
  }

}
export { ClientLocalServices } from "./client-local-services";
