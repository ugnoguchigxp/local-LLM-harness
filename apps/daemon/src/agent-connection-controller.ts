import { createHash, randomUUID } from "node:crypto";
import {
  activeAllocation,
  agentProviderEndpoint,
  personalStateSubjectDigest,
  resolveAgentAudienceBaseUrl,
  type AgentAudience,
  type AgentConnectionCatalog,
  type AgentConnectionClaim,
  type AgentConnectionHealth,
  type AgentConnectionRequest,
  type AgentConnectionStatus,
  type AgentProfile,
  type AgentProfileSelectorId,
  type AgentProviderHealth,
  type PublicAgentConnection,
  type RuntimeProtocol,
} from "@larm/core";
import { AllocationLifecycleError } from "./allocation-lifecycle";
import type { ControlPlane } from "./controller";
import { ConnectionTokenCodec, ConnectionTokenError, type ConnectionTokenPayload } from "./connection-token";
import type { SemanticReadiness } from "./semantic-readiness";

const PERSONAL_STATE_SCOPES = [
  "context.source.provision",
  "context.measure",
  "context.view.create",
  "context.generate",
  "context.attempt.cancel",
  "context.forget",
  "context.operation.read",
] as const;

type ConnectionRecord = {
  id: string;
  allocationId: string;
  principal: string;
  bootEpoch: string;
  catalogRevision: string;
  selector: AgentConnectionCatalog["profileSelectors"][number];
  profile: AgentProfile;
  audience: AgentAudience;
  status: AgentConnectionStatus;
  createdAt: string;
  expiresAt: string;
  readyDeadline: number;
  generation: number;
  tokenIssuedAt: number;
  personalStateAuthorized: boolean;
  sessionScope: string;
  requestHash: string;
  readyAt?: string;
  lastForegroundActivityAt?: string;
  idleReleaseAt?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  activeRequests: Map<string, { foreground: boolean }>;
  releasedAt?: string;
  error?: { code: string; message: string };
};

export type AgentConnectionApiResult = {
  status: number;
  body: unknown;
  replay?: boolean;
  location?: string;
  retryAfterSeconds?: number;
};

export type VerifiedProviderToken = {
  record: ConnectionRecord;
  provider: AgentProfile["providers"][number];
  payload: ConnectionTokenPayload;
};

type IdempotencyEntry = {
  requestHash: string;
  result: Promise<AgentConnectionApiResult>;
  expiresAt: number;
  connectionId?: string;
};

function error(code: string, message: string, status: number): AgentConnectionApiResult {
  return { status, body: { error: { code, message } } };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isTerminal(status: AgentConnectionStatus): boolean {
  return status === "failed" || status === "released" || status === "expired";
}

export function agentPrincipal(apiToken: string): string {
  return hash(apiToken);
}

export class AgentConnectionController {
  private readonly records = new Map<string, ConnectionRecord>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly background = new Set<string>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private sequence = 0;

  constructor(private readonly options: {
    control: ControlPlane;
    getCatalog: () => AgentConnectionCatalog | undefined;
    getCatalogRevision: () => string;
    semantic: SemanticReadiness;
    tokenCodec: ConnectionTokenCodec;
    readyTimeoutMs: number;
    pollIntervalMs: number;
    idempotencyTtlMs: number;
    idempotencyLimit: number;
    historyLimit?: number;
    personalStateAvailable?: boolean;
    onEvent?: (event: { name: string; labels: Record<string, string> }) => void;
    now?: () => number;
    random?: () => string;
  }) {}

  listProfilesV1(): AgentConnectionApiResult {
    const catalog = this.options.getCatalog();
    if (!catalog) return error("agent_connections_not_configured", "agent connection catalog is unavailable", 503);
    return {
      status: 200,
      body: {
        contractVersion: "agent-connection.v1",
        catalogRevision: this.options.getCatalogRevision(),
        profiles: this.legacyProfiles(catalog).map((profile) => ({
          id: profile.id,
          description: profile.description,
          providers: profile.providers.map((provider) => ({
            name: provider.name,
            capability: provider.capability,
            protocol: provider.protocol,
            model: provider.publicModel,
          })),
        })),
        audiences: catalog.audiences.map((audience) => audience.id),
      },
    };
  }

  listProfilesV2(): AgentConnectionApiResult {
    const catalog = this.options.getCatalog();
    if (!catalog) return error("agent_connections_not_configured", "agent connection catalog is unavailable", 503);
    return {
      status: 200,
      body: {
        contractVersion: "agent-connection.v2",
        catalogRevision: this.options.getCatalogRevision(),
        defaultAgentProfile: catalog.defaultAgentProfile,
        profiles: this.legacyProfiles(catalog).map((profile) => ({
          id: profile.id,
          canonicalProfile: profile.canonicalProfile,
          description: profile.description,
          selectionPolicy: profile.selectionPolicy,
          deprecated: profile.deprecated,
          schedulingPriority: profile.schedulingPriority ?? 0,
          ...(profile.idleRelease ? { idleRelease: structuredClone(profile.idleRelease) } : {}),
          providers: profile.providers.map((provider) => ({
            name: provider.name,
            capability: provider.capability,
            supportedCapabilities: provider.supportedCapabilities,
            protocol: provider.protocol,
            model: provider.publicModel,
          })),
        })),
        audiences: catalog.audiences.map((audience) => audience.id),
      },
    };
  }

  listProfilesV3(profileId?: string): AgentConnectionApiResult {
    const catalog = this.options.getCatalog();
    if (!catalog) return error("agent_connections_not_configured", "agent connection catalog is unavailable", 503);
    const selector = profileId
      ? catalog.profileSelectors.find((candidate) => candidate.id === profileId)
      : undefined;
    const selectedProfileId = selector?.agentProfile ?? profileId;
    const profiles = selectedProfileId
      ? catalog.profiles.filter((profile) => profile.id === selectedProfileId)
      : catalog.profiles;
    if (profileId && profiles.length === 0) {
      return error("unknown_agent_profile", `agent profile ${profileId} does not exist`, 404);
    }
    return {
      status: 200,
      body: {
        contractVersion: "agent-connection.v3",
        catalogRevision: this.options.getCatalogRevision(),
        defaultAgentProfile: catalog.defaultAgentProfile,
        ...(profileId ? { requestedProfile: profileId } : {}),
        profiles: profiles.map((profile) => ({
          id: profile.id,
          canonicalProfile: profile.canonicalProfile,
          description: profile.description,
          selectionPolicy: profile.selectionPolicy,
          deprecated: profile.deprecated,
          schedulingPriority: profile.schedulingPriority ?? 0,
          ...(profile.idleRelease ? { idleRelease: structuredClone(profile.idleRelease) } : {}),
          providers: profile.providers.map((provider) => ({
            name: provider.name,
            capability: provider.capability,
            supportedCapabilities: provider.supportedCapabilities,
            protocol: provider.protocol,
            endpoint: agentProviderEndpoint(provider.protocol),
            model: provider.publicModel,
            ...(provider.embeddingSpace ? { embeddingSpace: provider.embeddingSpace } : {}),
            ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
          })),
          services: selector?.services ?? [],
        })),
        audiences: catalog.audiences.map((audience) => audience.id),
      },
    };
  }

  async create(
    request: AgentConnectionRequest,
    principal: string,
    idempotencyKey: string,
    requestUrl: string,
    personalStateAuthorized = false,
    waitMs = 0,
  ): Promise<AgentConnectionApiResult> {
    const catalog = this.options.getCatalog();
    if (!catalog) return error("agent_connections_not_configured", "agent connection catalog is unavailable", 503);
    const selector = catalog.profileSelectors.find((item) => item.id === request.profile);
    if (!selector) return error("unknown_profile_selector", `profile selector ${request.profile} does not exist`, 404);
    const profile = catalog.profiles.find((item) => item.id === selector.agentProfile);
    if (!profile) return error("profile_resolution_failed", `profile selector ${request.profile} cannot be resolved`, 503);
    const configuredAudience = catalog.audiences.find((item) => item.id === request.audience);
    if (!configuredAudience) return error(
      "connection_audience_unavailable",
      `agent audience ${request.audience} is unavailable`,
      409,
    );
    const advertisedBaseUrl = resolveAgentAudienceBaseUrl(configuredAudience, requestUrl);
    if (!advertisedBaseUrl) return error(
      "connection_audience_unavailable",
      `agent audience ${request.audience} cannot use the request origin`,
      409,
    );
    const audience = { ...structuredClone(configuredAudience), baseUrl: advertisedBaseUrl };
    const normalizedRequest = {
      profile: request.profile,
      ...(request.expectedCatalogRevision
        ? { expectedCatalogRevision: request.expectedCatalogRevision }
        : {}),
      audience: request.audience,
      ...(request.client ? { client: request.client } : {}),
      ttlSeconds: request.ttlSeconds,
      allowFallback: request.allowFallback,
      deploymentPolicy: request.deploymentPolicy,
    };
    const requestHash = hash(JSON.stringify({
      request: normalizedRequest,
      advertisedBaseUrl,
      personalStateAuthorized,
    }));
    const sessionScope = `${principal}:${request.profile}:${request.audience}:${request.client ?? "(anonymous)"}`;
    return await this.idempotent(
      `${principal}:POST:/v1/agent-connections:${idempotencyKey}`,
      requestHash,
      async () => await this.withSessionLock(sessionScope, async () => {
        const reusable = [...this.records.values()].find((record) => {
          this.refreshLifecycle(record);
          return record.sessionScope === sessionScope && !isTerminal(record.status);
        });
        if (reusable) {
          if (reusable.requestHash !== requestHash) {
            return error(
              "connection_session_conflict",
              "an active connection already exists for this client session with different options",
              409,
            );
          }
          return {
            status: reusable.status === "ready" ? 201 : 202,
            body: this.public(reusable),
            location: `/v1/agent-connections/${reusable.id}`,
            replay: true,
          };
        }
        if (
          request.profile === "contextStill"
          && [...this.records.values()].some((record) => {
            this.refreshLifecycle(record);
            return record.selector.id.startsWith("SAAA") && !isTerminal(record.status);
          })
        ) {
          return {
            ...error(
              "provider_conflict",
              "ContextStill cannot be provided while an SAAA connection is active",
              409,
            ),
            retryAfterSeconds: 1,
          };
        }
        const catalogRevision = this.options.getCatalogRevision();
        if (
          request.expectedCatalogRevision
          && request.expectedCatalogRevision !== catalogRevision
        ) {
          return error(
            "catalog_revision_mismatch",
            "expectedCatalogRevision does not match the active catalog",
            409,
          );
        }
        if (request.profile.startsWith("SAAA")) {
          const conflict = await this.preemptContextStillConnections(profile.schedulingPriority ?? 0);
          if (conflict) return conflict;
        }
        const allocated = await this.options.control.allocate({
          requirements: profile.providers.map((provider) => ({
            capability: provider.capability,
            route: provider.route,
          })),
          ...(request.client ? { client: request.client } : {}),
          ttlSeconds: request.ttlSeconds,
          allowFallback: request.allowFallback,
          deploymentPolicy: request.deploymentPolicy,
          priority: profile.schedulingPriority ?? 0,
          capacityPolicy: "wait",
        });
        if (allocated.status !== 200 && allocated.status !== 202) {
          return { status: allocated.status, body: allocated.body };
        }
        const allocation = allocated.body;
        const now = this.now();
        const record: ConnectionRecord = {
          id: this.createId(),
          allocationId: allocation.id,
          principal,
          bootEpoch: this.options.control.getBootEpoch(),
          catalogRevision: allocation.catalogRevision ?? this.options.getCatalogRevision(),
          selector: structuredClone(selector),
          profile: structuredClone(profile),
          audience,
          status: allocation.status === "ready" ? "probing" : "pending",
          createdAt: new Date(now).toISOString(),
          expiresAt: allocation.expiresAt,
          readyDeadline: Math.min(Date.parse(allocation.expiresAt), now + this.options.readyTimeoutMs),
          generation: 1,
          tokenIssuedAt: Math.floor(now / 1_000),
          personalStateAuthorized,
          sessionScope,
          requestHash,
          activeRequests: new Map(),
        };
        this.records.set(record.id, record);
        let complete = false;
        if (record.status === "probing") complete = await this.probeInitial(record);
        if (!complete && !isTerminal(record.status) && waitMs > 0) {
          complete = await this.waitForReadiness(record, waitMs);
        }
        if (!complete && !isTerminal(record.status)) this.startBackground(record);
        return {
          status: record.status === "ready" ? 201 : isTerminal(record.status) ? 503 : 202,
          body: this.public(record),
          location: `/v1/agent-connections/${record.id}`,
        };
      }),
    );
  }

  get(id: string, principal: string): AgentConnectionApiResult {
    const found = this.owned(id, principal);
    if ("body" in found) return found;
    this.refreshLifecycle(found);
    return { status: 200, body: this.public(found) };
  }

  async health(id: string, principal: string): Promise<AgentConnectionApiResult> {
    const found = this.owned(id, principal);
    if ("body" in found) return found;
    this.refreshLifecycle(found);
    if (found.status === "expired") return error("connection_expired", `connection ${id} has expired`, 410);
    if (found.status === "released" || found.status === "failed") {
      return error("connection_inactive", `connection ${id} is ${found.status}`, 409);
    }
    return await this.healthRecord(found);
  }

  async providerHealth(
    id: string,
    providerName: string,
    principal?: string,
  ): Promise<AgentConnectionApiResult> {
    const found = principal ? this.owned(id, principal) : this.records.get(id) ?? this.lookupError(id);
    if ("body" in found) return found;
    const record = found;
    this.refreshLifecycle(record);
    if (record.status === "expired") return error("connection_expired", `connection ${id} has expired`, 410);
    if (record.status === "released" || record.status === "failed") {
      return error("connection_inactive", `connection ${id} is ${record.status}`, 409);
    }
    const provider = record.profile.providers.find((item) => item.name === providerName);
    if (!provider) return error(
      "connection_provider_not_found",
      `provider ${providerName} does not exist`,
      404,
    );
    const health = isTerminal(record.status) || record.status === "pending"
      ? this.notReadyHealth(provider.name, provider.capability)
      : await this.options.semantic.check({ allocationId: record.allocationId, provider });
    return { status: health.ready ? 200 : 503, body: health };
  }

  async claim(
    id: string,
    principal: string,
    format: "openai-provider-v1" | "larm-embedding-provider-v1",
    personalStateAuthorized = false,
  ): Promise<AgentConnectionApiResult> {
    const found = this.owned(id, principal);
    if ("body" in found) return found;
    if (found.personalStateAuthorized && !personalStateAuthorized) {
      return error(
        "connection_auth_required",
        "standard bearer authentication is required to claim Personal State scopes",
        401,
      );
    }
    this.refreshLifecycle(found);
    if (found.status === "pending" || found.status === "probing") {
      return error("connection_not_ready", `connection ${id} is ${found.status}`, 409);
    }
    if (found.status !== "ready") {
      if (found.status === "expired") {
        return error("connection_expired", `connection ${id} has expired`, 410);
      }
      return error("connection_inactive", `connection ${id} is ${found.status}`, 409);
    }
    const embeddingOnly = found.profile.providers.every(
      (provider) => provider.protocol === "larm.embedding.v1",
    );
    const expectedFormat = embeddingOnly ? "larm-embedding-provider-v1" : "openai-provider-v1";
    if (format !== expectedFormat) {
      return error(
        "claim_format_mismatch",
        `connection ${id} requires claim format ${expectedFormat}`,
        409,
      );
    }
    const current = await this.healthRecord(found);
    if (current.status !== 200) {
      return error("provider_semantic_not_ready", "one or more providers are not semantically ready", 503);
    }
    const base = new URL(found.audience.baseUrl);
    const scheme: "http" | "https" = base.protocol === "https:" ? "https" : "http";
    const port = base.port ? Number(base.port) : scheme === "https" ? 443 : 80;
    const health = (current.body as AgentConnectionHealth).providers;
    const embeddingUnavailable = found.profile.providers
      .filter((provider) => provider.protocol === "larm.embedding.v1")
      .some((provider) =>
        !provider.embeddingSpace
        || !health.find((item) => item.name === provider.name)?.capacity
      );
    if (embeddingUnavailable) {
      return error("provider_capacity_unavailable", "embedding provider capacity is unavailable", 503);
    }
    const providers = found.profile.providers.map((provider) => {
      const providerHealth = health.find((item) => item.name === provider.name);
      if (provider.protocol === "larm.embedding.v1") {
        const embeddingSpace = provider.embeddingSpace!;
        const capacity = providerHealth!.capacity!;
        return {
          name: provider.name,
          capability: provider.capability,
          apiStyle: "larm-embedding" as const,
          protocol: "larm.embedding.v1" as const,
          scheme,
          host: base.hostname,
          port,
          baseUrl: found.audience.baseUrl,
          endpoint: `${base.origin}/v1/embed`,
          model: provider.publicModel,
          embeddingSpace,
          capacity: {
            ...capacity,
            ready: true as const,
          },
          health: {
            url: `${found.audience.baseUrl}/agent-connections/${found.id}/providers/${provider.name}/health`,
            kind: "semantic-inference" as const,
            maxAgeMs: 10_000 as const,
          },
          credential: {
            type: "bearer" as const,
            token: this.providerToken(found, provider.name, provider.capability),
            expiresAt: found.expiresAt,
          },
          configuration: {
            kind: "larm-embedding-provider-v1" as const,
            fields: {
              daemonURL: found.audience.baseUrl,
              model: provider.publicModel,
              dimension: embeddingSpace.dimension,
            },
            secretFields: { accessToken: "credential.token" as const },
          },
        };
      }
      return {
        name: provider.name,
        capability: provider.capability,
        apiStyle: "openai" as const,
        protocol: provider.protocol,
        scheme,
        host: base.hostname,
        port,
        baseUrl: found.audience.baseUrl,
        model: provider.publicModel,
        ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
        health: {
          url: `${found.audience.baseUrl}/agent-connections/${found.id}/providers/${provider.name}/health`,
          kind: "semantic-inference" as const,
          maxAgeMs: 10_000 as const,
        },
        credential: {
          type: "bearer" as const,
          token: this.providerToken(found, provider.name, provider.capability),
          expiresAt: found.expiresAt,
        },
        configuration: {
          kind: "openai-provider-v1" as const,
          fields: { baseURL: found.audience.baseUrl, model: provider.publicModel },
          secretFields: { apiKey: "credential.token" as const },
        },
      };
    });
    const body: AgentConnectionClaim = {
      id: found.id,
      allocationId: found.allocationId,
      status: "ready",
      audience: found.audience.id,
      providers,
      ...(this.personalStateAuthorized(found) ? {
        contextControl: {
          contractVersion: "larm-personal-state.v1" as const,
          subjectDigest: personalStateSubjectDigest(found.principal),
          scopes: [...PERSONAL_STATE_SCOPES],
        },
      } : {}),
      expiresAt: found.expiresAt,
    };
    return { status: 200, body };
  }

  async renew(
    id: string,
    ttlSeconds: number,
    principal: string,
    idempotencyKey: string,
  ): Promise<AgentConnectionApiResult> {
    return await this.idempotent(
      `${principal}:POST:/v1/agent-connections/${id}/renew:${idempotencyKey}`,
      hash(JSON.stringify({ ttlSeconds })),
      async () => {
        const found = this.owned(id, principal);
        if ("body" in found) return found;
        this.refreshLifecycle(found);
        if (found.status === "expired") {
          return error("connection_expired", `connection ${id} has expired`, 410);
        }
        if (isTerminal(found.status)) return error("connection_inactive", `connection ${id} is ${found.status}`, 409);
        const renewed = this.options.control.renewAllocation(found.allocationId, ttlSeconds);
        if (renewed.status !== 200) return { status: renewed.status, body: renewed.body };
        found.expiresAt = renewed.body.expiresAt;
        found.generation += 1;
        found.tokenIssuedAt = Math.floor(this.now() / 1_000);
        return { status: 200, body: this.public(found) };
      },
    );
  }

  async release(id: string, principal: string): Promise<AgentConnectionApiResult> {
    const found = this.owned(id, principal);
    if ("body" in found) return found;
    if (isTerminal(found.status)) return { status: 204, body: undefined };
    await this.options.control.releaseAllocation(found.allocationId);
    this.clearIdleTimer(found);
    found.status = "released";
    found.releasedAt = new Date(this.now()).toISOString();
    this.pruneHistory();
    return { status: 204, body: undefined };
  }

  verifyProviderToken(token: string): VerifiedProviderToken {
    if (token.length > 4_096) throw new ConnectionTokenError("invalid_token", "provider bearer token is too long");
    const payload = this.options.tokenCodec.verify(token);
    const record = this.records.get(payload.connection);
    if (!record || record.bootEpoch !== this.options.control.getBootEpoch()) {
      throw new ConnectionTokenError("invalid_token", "provider bearer token does not name an active connection");
    }
    this.refreshLifecycle(record);
    if (record.error?.code === "foreground_idle_timeout") {
      throw new ConnectionTokenError(
        "connection_idle_released",
        "provider bearer token belongs to an idle-released connection",
      );
    }
    const provider = record.profile.providers.find((item) => item.name === payload.provider);
    const binding = this.options.control.getAllocation(record.allocationId)?.bindings.find(
      (item) => item.capability === provider?.capability,
    );
    if (
      record.status !== "ready"
      || !provider
      || payload.epoch !== record.bootEpoch
      || payload.allocation !== record.allocationId
      || payload.capability !== provider.capability
      || payload.audience !== record.audience.id
      || payload.generation !== record.generation
      || payload.iat !== record.tokenIssuedAt
      || payload.exp !== Math.floor(Date.parse(record.expiresAt) / 1_000)
      || payload.providerRevision !== binding?.providerRevision
      || payload.instanceId !== binding?.instanceId
      || payload.instanceGeneration !== binding?.instanceGeneration
    ) {
      throw new ConnectionTokenError("invalid_token", "provider bearer token is no longer valid");
    }
    return { record, provider, payload };
  }

  beginProviderRequest(
    connectionId: string,
    requestId: string,
    protocol: RuntimeProtocol,
    countsAsForegroundActivity = true,
  ): boolean {
    const record = this.records.get(connectionId);
    if (!record) return false;
    this.refreshLifecycle(record);
    if (record.status !== "ready" || record.activeRequests.has(requestId)) return false;
    const foreground = countsAsForegroundActivity
      && record.profile.idleRelease?.enabled === true
      && record.profile.idleRelease.activityProtocols.some((candidate) => candidate === protocol);
    record.activeRequests.set(requestId, { foreground });
    if (foreground) this.clearIdleTimer(record);
    return true;
  }

  finishProviderRequest(connectionId: string, requestId: string): void {
    const record = this.records.get(connectionId);
    const active = record?.activeRequests.get(requestId);
    if (!record || !active) return;
    record.activeRequests.delete(requestId);
    if (active.foreground && record.status === "ready") {
      record.lastForegroundActivityAt = new Date(this.now()).toISOString();
    }
    this.scheduleIdleRelease(record);
  }

  private async healthRecord(record: ConnectionRecord): Promise<AgentConnectionApiResult> {
    this.refreshLifecycle(record);
    const providers: AgentProviderHealth[] = [];
    if (isTerminal(record.status) || record.status === "pending") {
      for (const provider of record.profile.providers) {
        providers.push(this.notReadyHealth(provider.name, provider.capability));
      }
    } else {
      for (const provider of record.profile.providers) {
        providers.push(await this.options.semantic.check({ allocationId: record.allocationId, provider }));
      }
    }
    const ready = providers.every((provider) => provider.ready);
    const acceptingRequests = ready && providers.every((provider) => provider.acceptingRequests);
    if (ready && record.status === "probing") this.markReady(record);
    const body: AgentConnectionHealth = {
      id: record.id,
      status: record.status,
      ready,
      acceptingRequests,
      checkedAt: new Date(this.now()).toISOString(),
      providers,
    };
    return { status: ready ? 200 : 503, body };
  }

  private async preemptContextStillConnections(
    preemptingPriority: number,
  ): Promise<AgentConnectionApiResult | undefined> {
    for (const record of this.records.values()) {
      this.refreshLifecycle(record);
      if (record.selector.id !== "contextStill" || isTerminal(record.status)) continue;
      const released = await this.options.control.preemptAllocation(
        record.allocationId,
        preemptingPriority,
      );
      if (released.status !== 200) {
        return error(
          "provider_conflict",
          "ContextStill could not be preempted by the SAAA connection",
          409,
        );
      }
      record.status = "failed";
      record.releasedAt = new Date(this.now()).toISOString();
      record.error = {
        code: "foreground_preempted",
        message: "request stopped because a higher-priority foreground task requires the provider",
      };
    }
    this.pruneHistory();
    return undefined;
  }

  private notReadyHealth(name: string, capability: string): AgentProviderHealth {
    return { name, capability, ready: false, acceptingRequests: false, reason: "connection_not_ready" };
  }

  private async probeInitial(record: ConnectionRecord): Promise<boolean> {
    const health = await this.healthRecord(record);
    if (health.status === 200) {
      this.markReady(record);
      return true;
    }
    const providers = (health.body as AgentConnectionHealth).providers;
    const mismatch = providers.find((provider) => provider.reason === "provider_contract_mismatch");
    if (mismatch) {
      record.status = "failed";
      this.clearIdleTimer(record);
      record.error = {
        code: "provider_contract_mismatch",
        message: `provider ${mismatch.name} rejected its fixed readiness contract`,
      };
      await this.options.control.releaseAllocation(record.allocationId);
      this.pruneHistory();
      return true;
    }
    return false;
  }

  private startBackground(record: ConnectionRecord): void {
    if (this.background.has(record.id)) return;
    this.background.add(record.id);
    void this.runBackground(record).finally(() => this.background.delete(record.id));
  }

  private async waitForReadiness(record: ConnectionRecord, waitMs: number): Promise<boolean> {
    const deadline = Math.min(record.readyDeadline, this.now() + waitMs);
    while (!isTerminal(record.status) && this.now() < deadline) {
      this.refreshLifecycle(record);
      if (isTerminal(record.status)) return true;
      const allocation = this.options.control.getAllocation(record.allocationId);
      if (allocation?.status === "ready") {
        record.status = "probing";
        if (await this.probeInitial(record)) return true;
      }
      const remaining = deadline - this.now();
      if (remaining > 0) {
        await this.sleep(Math.min(Math.max(1, remaining), Math.max(1_000, this.options.pollIntervalMs)));
      }
    }
    return isTerminal(record.status) || record.status === "ready";
  }

  private async runBackground(record: ConnectionRecord): Promise<void> {
    while (!isTerminal(record.status) && this.now() < record.readyDeadline) {
      this.refreshLifecycle(record);
      if (isTerminal(record.status)) return;
      const allocation = this.options.control.getAllocation(record.allocationId);
      if (allocation?.status === "ready") {
        record.status = "probing";
        if (await this.probeInitial(record)) return;
      }
      await this.sleep(Math.max(1_000, this.options.pollIntervalMs));
    }
    if (!isTerminal(record.status)) {
      record.status = "failed";
      this.clearIdleTimer(record);
      record.error = {
        code: "connection_ready_timeout",
        message: "connection did not become semantically ready before its deadline",
      };
      await this.options.control.releaseAllocation(record.allocationId);
      this.pruneHistory();
    }
  }

  private refreshLifecycle(record: ConnectionRecord): void {
    if (isTerminal(record.status)) return;
    const allocation = this.options.control.getAllocation(record.allocationId);
    if (!allocation) {
      record.status = "failed";
      this.clearIdleTimer(record);
      record.error = { code: "allocation_missing", message: "owned allocation is unavailable" };
      this.pruneHistory();
      return;
    }
    record.expiresAt = allocation.expiresAt;
    if (allocation.status === "expired") {
      record.status = "expired";
      this.clearIdleTimer(record);
      this.pruneHistory();
      return;
    }
    if (allocation.status === "released") {
      record.status = "failed";
      this.clearIdleTimer(record);
      record.error = allocation.error
        ?? { code: "allocation_released", message: "owned allocation was released unexpectedly" };
      this.pruneHistory();
      return;
    }
    if (allocation.status === "failed") {
      record.status = "failed";
      this.clearIdleTimer(record);
      record.error = allocation.error ?? { code: "allocation_failed", message: "owned allocation failed" };
      this.pruneHistory();
    }
  }

  private public(record: ConnectionRecord): PublicAgentConnection {
    const allocation = this.options.control.getAllocation(record.allocationId);
    const phase = isTerminal(record.status)
      ? "terminal" as const
      : record.status === "ready"
      ? "ready" as const
      : record.status === "probing"
      ? "probing" as const
      : allocation?.status === "waiting"
      ? "waiting-capacity" as const
      : "deploying" as const;
    const providerReadiness = record.status === "ready"
      ? "ready" as const
      : isTerminal(record.status)
      ? "failed" as const
      : record.status === "probing"
      ? "probing" as const
      : allocation?.status === "waiting"
      ? "waiting" as const
      : "deploying" as const;
    return {
      id: record.id,
      allocationId: record.allocationId,
      bootEpoch: record.bootEpoch,
      catalogRevision: record.catalogRevision,
      profile: record.selector.id as AgentProfileSelectorId,
      agentProfile: record.profile.id,
      profileRevision: record.profile.revision,
      audience: record.audience.id,
      audienceRevision: record.audience.revision,
      status: record.status,
      phase,
      providers: record.profile.providers.map((provider) => ({
        name: provider.name,
        capability: provider.capability,
        supportedCapabilities: provider.supportedCapabilities,
        protocol: provider.protocol,
        endpoint: agentProviderEndpoint(provider.protocol),
        model: provider.publicModel,
        ...(provider.embeddingSpace ? { embeddingSpace: provider.embeddingSpace } : {}),
        ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
        readiness: providerReadiness,
        claimable: record.status === "ready"
          && this.options.semantic.peek({ allocationId: record.allocationId, provider })?.ready === true,
      })),
      services: structuredClone(record.selector.services),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      readyDeadline: new Date(record.readyDeadline).toISOString(),
      ...(record.lastForegroundActivityAt
        ? { lastForegroundActivityAt: record.lastForegroundActivityAt }
        : {}),
      ...(record.idleReleaseAt ? { idleReleaseAt: record.idleReleaseAt } : {}),
      ...(record.releasedAt ? { releasedAt: record.releasedAt } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private providerToken(record: ConnectionRecord, provider: string, capability: string): string {
    const binding = this.options.control.getAllocation(record.allocationId)?.bindings.find(
      (item) => item.capability === capability,
    );
    return this.options.tokenCodec.sign({
      v: 1,
      epoch: record.bootEpoch,
      connection: record.id,
      allocation: record.allocationId,
      provider,
      capability,
      audience: record.audience.id,
      generation: record.generation,
      iat: record.tokenIssuedAt,
      exp: Math.floor(Date.parse(record.expiresAt) / 1_000),
      ...(binding?.providerRevision ? { providerRevision: binding.providerRevision } : {}),
      ...(binding?.instanceId ? { instanceId: binding.instanceId } : {}),
      ...(binding?.instanceGeneration
        ? { instanceGeneration: binding.instanceGeneration }
        : {}),
      ...(this.personalStateAuthorized(record, provider) ? {
        subject: personalStateSubjectDigest(record.principal),
        scopes: [...PERSONAL_STATE_SCOPES],
      } : {}),
    });
  }

  private personalStateAuthorized(record: ConnectionRecord, providerName?: string): boolean {
    if (!this.options.personalStateAvailable || !record.personalStateAuthorized) return false;
    const providers = providerName === undefined
      ? record.profile.providers
      : record.profile.providers.filter((provider) => provider.name === providerName);
    return providers.some((provider) => provider.protocol === "openai.chat-completions.v1");
  }

  private owned(id: string, principal: string): ConnectionRecord | AgentConnectionApiResult {
    const record = this.records.get(id);
    if (!record) return this.lookupError(id);
    if (record.principal !== principal) {
      return error("connection_forbidden", "connection belongs to another principal", 403);
    }
    return record;
  }

  private lookupError(id: string): AgentConnectionApiResult {
    if (!/^aconn_[a-zA-Z0-9._-]{1,185}$/.test(id)) {
      return error("invalid_request", "connection id is invalid", 400);
    }
    if (id.startsWith("aconn_") && !id.startsWith(`aconn_${this.options.control.getBootEpoch()}_`)) {
      return error("connection_epoch_expired", `connection ${id} belongs to a previous daemon boot epoch`, 410);
    }
    return error("connection_not_found", `connection ${id} does not exist`, 404);
  }

  private async idempotent(
    scope: string,
    requestHash: string,
    operation: () => Promise<AgentConnectionApiResult>,
  ): Promise<AgentConnectionApiResult> {
    this.pruneIdempotency();
    const existing = this.idempotency.get(scope);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return error("idempotency_conflict", "Idempotency-Key was already used for a different request", 409);
      }
      return { ...(await existing.result), replay: true };
    }
    if (this.idempotency.size >= this.options.idempotencyLimit) {
      return error("idempotency_capacity", "idempotency result capacity is temporarily exhausted", 503);
    }
    const entry: IdempotencyEntry = {
      requestHash,
      result: Promise.resolve().then(operation),
      expiresAt: this.now() + this.options.idempotencyTtlMs,
    };
    this.idempotency.set(scope, entry);
    const result = await entry.result;
    if (result.status < 200 || result.status >= 300) {
      this.idempotency.delete(scope);
    } else if (typeof result.body === "object" && result.body !== null && "id" in result.body) {
      entry.connectionId = String((result.body as { id: unknown }).id);
    }
    return result;
  }

  private pruneIdempotency(): void {
    const now = this.now();
    for (const [key, entry] of this.idempotency) {
      const record = entry.connectionId ? this.records.get(entry.connectionId) : undefined;
      if (entry.expiresAt <= now && (!record || isTerminal(record.status))) this.idempotency.delete(key);
    }
  }

  private createId(): string {
    this.sequence += 1;
    const source = (this.options.random ?? randomUUID)();
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(source)
      ? source.toLowerCase()
      : this.deterministicUuid(`${source}\0${this.sequence}`);
    return `aconn_${this.options.control.getBootEpoch()}_${uuid}`;
  }

  private deterministicUuid(source: string): string {
    const value = hash(source).slice(0, 32).split("");
    value[12] = "4";
    value[16] = ["8", "9", "a", "b"][Number.parseInt(value[16]!, 16) % 4]!;
    const compact = value.join("");
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }

  private pruneHistory(): void {
    const limit = Math.max(1, this.options.historyLimit ?? 1_000);
    const terminal = [...this.records.values()]
      .filter((record) => isTerminal(record.status))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    for (const record of terminal.slice(0, Math.max(0, terminal.length - limit))) {
      this.clearIdleTimer(record);
      this.records.delete(record.id);
    }
  }

  private markReady(record: ConnectionRecord): void {
    record.status = "ready";
    record.readyAt ??= new Date(this.now()).toISOString();
    this.scheduleIdleRelease(record);
  }

  private scheduleIdleRelease(record: ConnectionRecord): void {
    this.clearIdleTimer(record);
    const policy = record.profile.idleRelease;
    if (!policy?.enabled || record.status !== "ready" || record.activeRequests.size > 0) return;
    const baseline = Date.parse(record.lastForegroundActivityAt ?? record.readyAt ?? record.createdAt);
    const deadline = baseline + policy.idleSeconds * 1_000;
    record.idleReleaseAt = new Date(deadline).toISOString();
    const timer = setTimeout(() => {
      if (record.idleTimer !== timer) return;
      record.idleTimer = undefined;
      void this.releaseIdleConnection(record.id, deadline);
    }, Math.max(0, deadline - this.now()));
    timer.unref?.();
    record.idleTimer = timer;
  }

  private clearIdleTimer(record: ConnectionRecord): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = undefined;
    record.idleReleaseAt = undefined;
  }

  private async releaseIdleConnection(id: string, deadline: number): Promise<void> {
    const record = this.records.get(id);
    const policy = record?.profile.idleRelease;
    if (!record || !policy?.enabled || record.status !== "ready") return;
    const baseline = Date.parse(record.lastForegroundActivityAt ?? record.readyAt ?? record.createdAt);
    const currentDeadline = baseline + policy.idleSeconds * 1_000;
    if (currentDeadline !== deadline || record.activeRequests.size > 0 || this.now() < currentDeadline) {
      this.scheduleIdleRelease(record);
      return;
    }
    const reason = new AllocationLifecycleError(
      "foreground_idle_timeout",
      `connection released after ${policy.idleSeconds} seconds without LLM, ASR, or TTS activity`,
    );
    record.status = "released";
    record.releasedAt = new Date(this.now()).toISOString();
    record.error = { code: reason.code, message: reason.message };
    record.generation += 1;
    record.idleReleaseAt = undefined;
    await this.options.control.releaseAllocation(record.allocationId, "released", reason);
    this.options.onEvent?.({
      name: "agent_connection_idle_released",
      labels: {
        connection: record.id,
        profile: record.selector.id,
        idleSeconds: String(policy.idleSeconds),
      },
    });
    this.pruneHistory();
  }

  private async withSessionLock<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.sessionLocks.get(scope) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = prior.then(() => current);
    this.sessionLocks.set(scope, tail);
    await prior;
    try {
      return await operation();
    } finally {
      unlock();
      if (this.sessionLocks.get(scope) === tail) this.sessionLocks.delete(scope);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private legacyProfiles(catalog: AgentConnectionCatalog): AgentProfile[] {
    return catalog.profiles.filter((profile) =>
      profile.providers.every((provider) => provider.protocol !== "larm.embedding.v1")
    );
  }
}
