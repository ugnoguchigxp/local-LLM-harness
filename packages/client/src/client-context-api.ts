import {
  canonicalMeasurementReceiptSchema,
  canonicalMeasurementRequestSchema,
  contextListSchema,
  contextRegistrationRequestSchema,
  contextStatusSchema,
  contextViewRequestSchema,
  forgetOperationSchema,
  forgetRequestSchema,
  generationAttemptSchema,
  personalStateCapabilitySchema,
  personalStateViewReceiptSchema,
  personalStateViewRequestSchema,
  publicContextDescriptorSchema,
  publicContextOperationSchema,
  publicContextViewSchema,
  sourceProvisionReceiptSchema,
  type CanonicalMeasurementRequest,
  type ContextRegistrationRequest,
  type ContextViewRequest,
  type ForgetRequestInput,
  type PersonalStateViewRequest,
} from "@larm/core";
import { createIdempotencyKey } from "./client-helpers";

export type ClientRequestOptions = {
  signal?: AbortSignal;
  idempotencyKey?: string;
  management?: boolean;
  waitSeconds?: number;
};

export type PersonalStateRequestOptions = ClientRequestOptions & {
  providerToken: string;
};

type JsonSchema<T> = { parse(input: unknown): T };
type Request = (
  path: string,
  init: RequestInit,
  management?: boolean,
  timeoutMs?: number,
  acceptedStatuses?: readonly number[],
  sendApiToken?: boolean,
) => Promise<Response>;

export class ClientContextApi {
  constructor(private readonly deps: {
    request: Request;
    parseJson: <T>(response: Response, schema: JsonSchema<T>) => Promise<T>;
    random?: () => string;
    timeoutMs: number;
  }) {}

  async getContextStatus(signal?: AbortSignal) {
    const response = await this.deps.request("/v1/context-status", { signal });
    return this.deps.parseJson(response, contextStatusSchema);
  }

  async registerContext(input: ContextRegistrationRequest, options: ClientRequestOptions = {}) {
    const request = contextRegistrationRequestSchema.parse(input);
    const response = await this.deps.request("/v1/contexts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? createIdempotencyKey(this.deps.random),
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    return this.deps.parseJson(response, publicContextDescriptorSchema);
  }

  async listContexts(options: { signal?: AbortSignal; cursor?: string; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const response = await this.deps.request(`/v1/contexts${query.size > 0 ? `?${query}` : ""}`, {
      signal: options.signal,
    });
    return this.deps.parseJson(response, contextListSchema);
  }

  async deleteContext(id: string, options: ClientRequestOptions = {}): Promise<void> {
    const response = await this.deps.request(`/v1/contexts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "idempotency-key": options.idempotencyKey ?? createIdempotencyKey(this.deps.random) },
      signal: options.signal,
    });
    await response.body?.cancel().catch(() => undefined);
  }

  async createContextView(input: ContextViewRequest, options: ClientRequestOptions = {}) {
    const request = contextViewRequestSchema.parse(input);
    const response = await this.deps.request("/v1/context-views", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? createIdempotencyKey(this.deps.random),
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    return this.deps.parseJson(response, publicContextViewSchema);
  }

  async getContextOperation(id: string, signal?: AbortSignal) {
    const response = await this.deps.request(`/v1/context-operations/${encodeURIComponent(id)}`, { signal });
    return this.deps.parseJson(response, publicContextOperationSchema);
  }

  async getPersonalStateCapability(
    allocationId: string,
    runtime: string,
    options: PersonalStateRequestOptions,
  ) {
    const response = await this.deps.request("/v1/personal-state/capability", {
      headers: {
        authorization: `Bearer ${options.providerToken}`,
        "x-larm-allocation-id": allocationId,
        "x-larm-runtime": runtime,
      },
      signal: options.signal,
    });
    return this.deps.parseJson(response, personalStateCapabilitySchema);
  }

  async provisionContextSource(input: {
    incarnation: string;
    allocationId: string;
    runtime: string;
    sourceDigest: string;
    content: string;
  }, options: PersonalStateRequestOptions) {
    const response = await this.deps.request("/v1/context-sources", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.providerToken}`,
        "content-type": "text/plain; charset=utf-8",
        "x-larm-source-incarnation": input.incarnation,
        "x-larm-allocation-id": input.allocationId,
        "x-larm-runtime": input.runtime,
        "x-larm-source-digest": input.sourceDigest,
      },
      body: input.content,
      signal: options.signal,
    });
    return this.deps.parseJson(response, sourceProvisionReceiptSchema);
  }

  async getContextSourceOperation(incarnation: string, options: PersonalStateRequestOptions) {
    const response = await this.deps.request(
      `/v1/context-source-operations/${encodeURIComponent(incarnation)}`,
      { headers: { authorization: `Bearer ${options.providerToken}` }, signal: options.signal },
    );
    return this.deps.parseJson(response, sourceProvisionReceiptSchema);
  }

  async registerPersonalStateContext(
    input: ContextRegistrationRequest,
    options: PersonalStateRequestOptions,
  ) {
    const request = contextRegistrationRequestSchema.parse(input);
    const response = await this.deps.request("/v1/contexts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.providerToken}`,
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? createIdempotencyKey(this.deps.random),
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    return this.deps.parseJson(response, publicContextDescriptorSchema);
  }

  async createContextMeasurement(
    input: CanonicalMeasurementRequest,
    options: PersonalStateRequestOptions,
  ) {
    const request = canonicalMeasurementRequestSchema.parse(input);
    const response = await this.deps.request("/v1/context-measurements", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.providerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    return this.deps.parseJson(response, canonicalMeasurementReceiptSchema);
  }

  async getContextMeasurement(id: string, options: PersonalStateRequestOptions) {
    const response = await this.deps.request(`/v1/context-measurements/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${options.providerToken}` },
      signal: options.signal,
    });
    return this.deps.parseJson(response, canonicalMeasurementReceiptSchema);
  }

  async createPersonalStateView(
    input: PersonalStateViewRequest,
    options: PersonalStateRequestOptions,
  ) {
    const request = personalStateViewRequestSchema.parse(input);
    const response = await this.deps.request("/v2/context-views", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.providerToken}`,
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? createIdempotencyKey(this.deps.random),
      },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    return this.deps.parseJson(response, publicContextViewSchema);
  }

  async getPersonalStateViewReceipt(id: string, options: PersonalStateRequestOptions) {
    const response = await this.deps.request(`/v2/context-views/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${options.providerToken}` },
      signal: options.signal,
    });
    return this.deps.parseJson(response, personalStateViewReceiptSchema);
  }

  chatPersonalState(input: {
    allocationId: string;
    attemptId: string;
    viewId?: string;
    body: unknown;
  }, options: PersonalStateRequestOptions): Promise<Response> {
    return this.deps.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.providerToken}`,
        "content-type": "application/json",
        "x-larm-allocation-id": input.allocationId,
        "x-larm-attempt-id": input.attemptId,
        ...(input.viewId ? { "x-larm-context-view-id": input.viewId } : {}),
      },
      body: JSON.stringify(input.body),
      signal: options.signal,
    });
  }

  async getGenerationAttempt(id: string, options: PersonalStateRequestOptions) {
    const response = await this.deps.request(`/v1/generation-attempts/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${options.providerToken}` },
      signal: options.signal,
    });
    return this.deps.parseJson(response, generationAttemptSchema);
  }

  async cancelGenerationAttempt(id: string, options: PersonalStateRequestOptions) {
    const response = await this.deps.request(`/v1/generation-attempts/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.providerToken}` },
      signal: options.signal,
    });
    return this.deps.parseJson(response, generationAttemptSchema);
  }

  async forgetPersonalState(input: ForgetRequestInput, options: PersonalStateRequestOptions) {
    const request = forgetRequestSchema.parse(input);
    const response = await this.deps.request("/v1/context-forget-operations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.providerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: options.signal,
    }, false, this.deps.timeoutMs, [202]);
    return this.deps.parseJson(response, forgetOperationSchema);
  }

  async getForgetOperation(id: string, options: PersonalStateRequestOptions) {
    const response = await this.deps.request(`/v1/context-forget-operations/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${options.providerToken}` },
      signal: options.signal,
    });
    return this.deps.parseJson(response, forgetOperationSchema);
  }
}
