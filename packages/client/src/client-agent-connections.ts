import {
  agentConnectionClaimRequestSchema,
  agentConnectionClaimSchema,
  agentConnectionHealthSchema,
  agentConnectionRenewRequestSchema,
  agentConnectionRequestSchema,
  agentProfileSelectorIdSchema,
  publicAgentConnectionSchema,
  publicAgentProfileListSchema,
  publicAgentProfileListV3Schema,
  type AgentConnectionClaim,
  type AgentConnectionClaimRequest,
  type AgentConnectionHealth,
  type AgentConnectionRequestInput,
  type AgentProfileSelectorId,
  type PublicAgentConnection,
} from "@larm/core";
import { z } from "zod";
import {
  connectionTimeout,
  createIdempotencyKey,
  delay,
  validatePollingOptions,
} from "./client-helpers";
import { LarmApiError } from "./errors";
import type { ClientRequestOptions } from "./client-context-api";

type JsonSchema<T> = { parse(input: unknown): T };
type Request = (
  path: string,
  init: RequestInit,
  management?: boolean,
  timeoutMs?: number,
  acceptedStatuses?: readonly number[],
  sendApiToken?: boolean,
) => Promise<Response>;

export type RefreshedAgentConnection = {
  connection: PublicAgentConnection;
  claim: AgentConnectionClaim;
};

export class ClientAgentConnections {
  constructor(private readonly deps: {
    request: Request;
    parseJson: <T>(response: Response, schema: JsonSchema<T>) => Promise<T>;
    random?: () => string;
    timeoutMs: number;
  }) {}

  /** @deprecated Use listAgentProfilesV3; the v2 route is a compatibility surface. */
  async listAgentProfiles(signal?: AbortSignal) {
    const response = await this.deps.request("/v2/agent-profiles", { signal });
    return this.deps.parseJson(response, publicAgentProfileListSchema);
  }

  async listAgentProfilesV3(signal?: AbortSignal): Promise<ReturnType<typeof publicAgentProfileListV3Schema.parse>>;
  async listAgentProfilesV3(
    profile: AgentProfileSelectorId,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof publicAgentProfileListV3Schema.parse>>;
  async listAgentProfilesV3(profileOrSignal?: string | AbortSignal, signal?: AbortSignal) {
    const profile = typeof profileOrSignal === "string"
      ? agentProfileSelectorIdSchema.parse(profileOrSignal)
      : undefined;
    const requestSignal = typeof profileOrSignal === "string" ? signal : profileOrSignal;
    const path = profile
      ? `/v3/agent-profiles?profile=${encodeURIComponent(profile)}`
      : "/v3/agent-profiles";
    const response = await this.deps.request(path, { signal: requestSignal });
    return this.deps.parseJson(response, publicAgentProfileListV3Schema);
  }

  async create(
    request: AgentConnectionRequestInput,
    options: ClientRequestOptions = {},
  ): Promise<PublicAgentConnection> {
    const normalized = agentConnectionRequestSchema.parse(request);
    const waitSeconds = options.waitSeconds === undefined
      ? undefined
      : z.number().int().min(1).max(300).parse(options.waitSeconds);
    const response = await this.deps.request("/v1/agent-connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? createIdempotencyKey(this.deps.random),
        ...(waitSeconds ? { prefer: `wait=${waitSeconds}` } : {}),
      },
      body: JSON.stringify(normalized),
      signal: options.signal,
    }, options.management ?? normalized.deploymentPolicy === "allow-listed", waitSeconds
      ? Math.max(this.deps.timeoutMs, waitSeconds * 1_000 + 5_000)
      : this.deps.timeoutMs);
    return this.deps.parseJson(response, publicAgentConnectionSchema);
  }

  async get(id: string, signal?: AbortSignal): Promise<PublicAgentConnection> {
    return this.getWithin(id, signal, this.deps.timeoutMs);
  }

  private async getWithin(
    id: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<PublicAgentConnection> {
    const response = await this.deps.request(
      `/v1/agent-connections/${encodeURIComponent(id)}`,
      { signal },
      false,
      timeoutMs,
    );
    return this.deps.parseJson(response, publicAgentConnectionSchema);
  }

  async waitUntilReady(
    connection: PublicAgentConnection,
    options: { signal?: AbortSignal; pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<PublicAgentConnection> {
    const timeoutMs = options.timeoutMs ?? this.deps.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    validatePollingOptions(timeoutMs, pollIntervalMs);
    const deadline = Date.now() + timeoutMs;
    let current = publicAgentConnectionSchema.parse(connection);
    while (current.status === "pending" || current.status === "probing") {
      if (Date.now() >= deadline) {
        throw new LarmApiError(408, "connection_timeout", `connection ${current.id} did not become ready`, current);
      }
      await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw connectionTimeout(current);
      try {
        current = await this.getWithin(current.id, options.signal, remainingMs);
      } catch (error) {
        if (Date.now() >= deadline) throw connectionTimeout(current);
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

  async getHealth(id: string, signal?: AbortSignal): Promise<AgentConnectionHealth> {
    const response = await this.deps.request(
      `/v1/agent-connections/${encodeURIComponent(id)}/health`,
      { signal },
      false,
      this.deps.timeoutMs,
      [503],
    );
    return this.deps.parseJson(response, agentConnectionHealthSchema);
  }

  async claim(
    id: string,
    formatOrSignal: AgentConnectionClaimRequest["format"] | AbortSignal = "openai-provider-v1",
    signal?: AbortSignal,
  ): Promise<AgentConnectionClaim> {
    const format = typeof formatOrSignal === "string" ? formatOrSignal : "openai-provider-v1";
    const requestSignal = typeof formatOrSignal === "string" ? signal : formatOrSignal;
    const body = agentConnectionClaimRequestSchema.parse({ format });
    const response = await this.deps.request(`/v1/agent-connections/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    return this.deps.parseJson(response, agentConnectionClaimSchema);
  }

  async renew(
    id: string,
    ttlSeconds = 300,
    options: ClientRequestOptions = {},
  ): Promise<PublicAgentConnection> {
    const body = agentConnectionRenewRequestSchema.parse({ ttlSeconds });
    const response = await this.deps.request(`/v1/agent-connections/${encodeURIComponent(id)}/renew`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": options.idempotencyKey ?? createIdempotencyKey(this.deps.random),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    return this.deps.parseJson(response, publicAgentConnectionSchema);
  }

  async refresh(
    id: string,
    options: ClientRequestOptions & {
      ttlSeconds?: number;
      claimFormat?: AgentConnectionClaimRequest["format"];
    } = {},
  ): Promise<RefreshedAgentConnection> {
    const connection = await this.renew(id, options.ttlSeconds, options);
    const claim = await this.claim(id, options.claimFormat, options.signal);
    if (
      claim.id !== connection.id
      || claim.allocationId !== connection.allocationId
      || claim.audience !== connection.audience
      || claim.expiresAt !== connection.expiresAt
    ) {
      throw new LarmApiError(
        502,
        "connection_refresh_mismatch",
        `renewed connection ${connection.id} did not match its refreshed claim`,
        { connection, claim },
      );
    }
    return { connection, claim };
  }

  async release(id: string, signal?: AbortSignal): Promise<void> {
    const response = await this.deps.request(`/v1/agent-connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal,
    });
    await response.body?.cancel().catch(() => undefined);
  }
}
