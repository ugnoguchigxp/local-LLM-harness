import { createHash } from "node:crypto";
import {
  type ActiveContextView,
  type Allocation,
  type ClusterState,
  type ContextDescriptor,
  type ContextOperation,
  type ContextRegistrationRequest,
  type ContextViewOmission,
  type ContextViewRequest,
  type ContextPlanItem,
  type Registry,
  type RuntimeReleaseDefinition,
} from "@larm/core";
import type {
  ContextSourceProvider,
  ContextTokenizerIdentity,
  LocalContextMetadataStore,
} from "@larm/backends";
import type { ControlEvent } from "./controller";
import { ContextControllerError } from "./context-controller-errors";
import { measureCanonicalRequest as measureCanonicalRequestDomain } from "./context-request-measurement";
import { commitContextOperation } from "./context-operation-commit";
import { expireContextView, invalidateReadyContextViews } from "./context-view-lifecycle";
import { ContextRuntimeReadiness } from "./context-runtime-readiness";
import { ContextRuntimeEligibility, type ContextProductRuntimeBinding } from "./context-runtime-eligibility";
import { ContextChatRequestLifecycle } from "./context-chat-request-lifecycle";
import { ContextViewCreationLifecycle } from "./context-view-creation-lifecycle";
import { publicContextView } from "./context-projection";
import { ContextSourceRegistryLifecycle } from "./context-source-registration";
import { ContextPersonalStateCoordinator } from "./context-personal-state-coordinator";
import type { ContextRuntimeStatus } from "./context-controller-types";

export { ContextControllerError } from "./context-controller-errors";
export { publicContextView } from "./context-projection";
export type { ContextRuntimeStatus } from "./context-controller-types";

type ContextControllerOptions = {
  enabled: boolean;
  registry: Registry;
  releases: RuntimeReleaseDefinition[];
  metadataStore: LocalContextMetadataStore;
  sourceProvider: ContextSourceProvider;
  tokenizer: {
    identity(endpoint: string, signal?: AbortSignal): Promise<ContextTokenizerIdentity>;
    countChatTokens(
      endpoint: string,
      request: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<number>;
  };
  getState: () => ClusterState;
  getAllocation: (id: string) => Allocation | undefined;
  getActiveRelease: (runtime: string) => string | undefined;
  isDraining: () => boolean;
  stateMaxAgeMs: number;
  sourceMaxBytes: number;
  sourceMaxTotalBytes: number;
  materializedMaxBytes: number;
  idempotencyTtlMs: number;
  idempotencyLimit: number;
  now?: () => number;
  random?: () => string;
  onEvent?: (event: ControlEvent) => void;
};

type IdempotencyEntry<T> = {
  requestHash: string;
  result: T;
  expiresAt: number;
};

function descriptorKey(principal: string, id: string, version: string): string {
  return `${principal}\0${id}\0${version}`;
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function publicContextOperation(
  operation: ContextOperation,
): Omit<ContextOperation, "principal" | "idempotencyKeyDigest"> {
  const { principal: _principal, idempotencyKeyDigest: _key, ...result } = operation;
  return result;
}

export class ContextController {
  private readonly releases: Map<string, RuntimeReleaseDefinition>;
  private readonly descriptors = new Map<string, ContextDescriptor>();
  private readonly views = new Map<string, ActiveContextView>();
  private readonly operations = new Map<string, ContextOperation>();
  private readonly materializingViews = new Set<string>();
  private readonly runtimeReadiness: ContextRuntimeReadiness;
  private readonly runtimeEligibility: ContextRuntimeEligibility;
  private readonly chatRequestLifecycle: ContextChatRequestLifecycle;
  private readonly viewCreationLifecycle: ContextViewCreationLifecycle;
  private readonly sourceRegistryLifecycle: ContextSourceRegistryLifecycle;
  private readonly personalStateCoordinator: ContextPersonalStateCoordinator;
  private readonly idempotency = new Map<string, IdempotencyEntry<unknown>>();
  private mutationChain = Promise.resolve();
  private initialized = false;

  constructor(private readonly options: ContextControllerOptions) {
    this.releases = new Map(options.releases.map((release) => [release.id, release]));
    this.runtimeReadiness = new ContextRuntimeReadiness({
      enabled: options.enabled,
      registry: options.registry,
      releases: this.releases,
      getState: options.getState,
      getActiveRelease: options.getActiveRelease,
      identity: (endpoint, signal) => options.tokenizer.identity(endpoint, signal),
      isDraining: options.isDraining,
      stateMaxAgeMs: options.stateMaxAgeMs,
      now: () => this.now(),
      onProbe: (runtime, release, ok) => this.emit("context_probe", {
        runtime,
        release,
        outcome: ok ? "ok" : "failed",
      }),
    });
    this.runtimeEligibility = new ContextRuntimeEligibility({
      enabled: options.enabled,
      registry: options.registry,
      releases: this.releases,
      getAllocation: options.getAllocation,
      getActivation: (runtime) => this.activation(runtime),
      materializedMaxBytes: options.materializedMaxBytes,
    });
    this.chatRequestLifecycle = new ContextChatRequestLifecycle({
      registry: options.registry,
      views: this.views,
      operations: this.operations,
      materializingViews: this.materializingViews,
      initialize: () => this.initialize(),
      prune: () => this.prune(),
      now: () => this.now(),
      getActivation: (runtime) => this.activation(runtime),
      getDescriptor: (principal, contextId, version) => this.descriptors.get(
        descriptorKey(principal, contextId, version),
      ),
      sourceProvider: options.sourceProvider,
      sourceMaxBytes: options.sourceMaxBytes,
      materializedMaxBytes: options.materializedMaxBytes,
      countChatTokens: (endpoint, request, signal) => options.tokenizer.countChatTokens(endpoint, request, signal),
      setProbe: (runtime, release, ok, reason) => this.runtimeReadiness.setProbe(runtime, release, ok, reason),
      updateOperation: (id, state, outcome) => this.updateOperation(id, state, outcome),
      emit: (name, labels, value) => this.emit(name, labels, value),
    });
    this.viewCreationLifecycle = new ContextViewCreationLifecycle({
      registry: options.registry,
      descriptors: this.descriptors,
      views: this.views,
      operations: this.operations,
      getAllocation: options.getAllocation,
      getRelease: (release) => this.releases.get(release),
      getActivation: (runtime) => this.activation(runtime),
      now: () => this.now(),
      isoNow: () => this.isoNow(),
      createViewId: () => this.uniqueViewId(),
      createOperationId: () => this.uniqueOperationId(),
      hash: (value) => this.hash(value),
      replay: (principal, scope, key, requestHash) => this.replay(principal, scope, key, requestHash),
      assertIdempotencyCapacity: () => this.assertIdempotencyCapacity(),
      remember: (principal, scope, key, requestHash, result) =>
        this.remember(principal, scope, key, requestHash, result),
      emit: (runtime) => this.emit("context_view_created", { runtime, mode: "source-rebuild" }),
    });
    this.sourceRegistryLifecycle = new ContextSourceRegistryLifecycle({
      registry: options.registry,
      sourceProvider: options.sourceProvider,
      sourceMaxBytes: options.sourceMaxBytes,
      sourceMaxTotalBytes: options.sourceMaxTotalBytes,
      descriptors: this.descriptors,
      views: this.views,
      descriptorKey,
      hash: (value) => this.hash(value),
      replay: (principal, scope, key, requestHash) => this.replay(principal, scope, key, requestHash),
      remember: (principal, scope, key, requestHash, result) =>
        this.remember(principal, scope, key, requestHash, result),
      assertIdempotencyCapacity: () => this.assertIdempotencyCapacity(),
      persist: () => this.persist(),
      now: () => this.now(),
      isoNow: () => this.isoNow(),
      prune: () => this.prune(),
      emit: (name, labels, value) => this.emit(name, labels, value),
    });
    this.personalStateCoordinator = new ContextPersonalStateCoordinator({
      descriptors: this.descriptors,
      views: this.views,
      materializingViews: this.materializingViews,
      initialize: () => this.initialize(),
      serialized: (operation) => this.serialized(operation),
      persist: () => this.persist(),
      updateOperation: (operationId, state, outcome) => this.updateOperation(operationId, state, outcome),
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const descriptors = await this.options.metadataStore.load();
    for (const descriptor of descriptors) {
      this.descriptors.set(
        descriptorKey(descriptor.principal, descriptor.id, descriptor.version),
        descriptor,
      );
    }
    this.initialized = true;
  }

  beginDrain(): void {
    this.runtimeReadiness.beginDrain();
    invalidateReadyContextViews(this.views.values(), {
      operationOutcome: "daemon_draining",
      updateOperation: (operationId, state, outcome) =>
        this.updateOperation(operationId, state, outcome),
    });
  }

  async refreshRuntimeProbes(): Promise<void> {
    await this.runtimeReadiness.refresh();
  }

  statuses(principal?: string): {
    enabled: boolean;
    state: ContextRuntimeStatus["state"];
    runtimes: ContextRuntimeStatus[];
  } {
    this.prune();
    const runtimes = this.options.registry.runtimes.map((runtime) => {
      const activation = this.activation(runtime.id);
      if (runtime.context?.class !== "managed-context") return activation;
      const release = activation.release ? this.releases.get(activation.release) : undefined;
      const descriptors = principal
        ? [...this.descriptors.values()].filter((item) =>
          item.principal === principal
          && item.state === "active"
          && (!release?.contextCertification
            || item.tokenizerDigest === release.contextCertification.tokenizerDigest)
        )
        : [];
      return {
        ...activation,
        quota: {
          sourceTokensUsed: descriptors.reduce((total, item) => total + item.tokenCount, 0),
          sourceTokensLimit: runtime.context.sourceTokenLimit,
          sourceBytesUsed: descriptors.reduce((total, item) => total + item.byteCount, 0),
          sourceBytesLimit: this.options.sourceMaxTotalBytes,
          filesystemFreeFloorBytes: runtime.context.filesystemFreeFloorBytes,
        },
      };
    });
    const managed = runtimes.filter((runtime) => runtime.state !== "DISABLED");
    const state = managed.some((runtime) => runtime.state === "ACTIVE")
      ? "ACTIVE"
      : managed.some((runtime) => runtime.state === "BUSY")
      ? "BUSY"
      : (["DRAINING", "DEGRADED", "STARTING", "STANDBY", "INELIGIBLE"] as const)
        .find((candidate) => managed.some((runtime) => runtime.state === candidate)) ?? "DISABLED";
    return {
      enabled: this.options.enabled,
      state,
      runtimes,
    };
  }

  async register(
    request: ContextRegistrationRequest,
    principal: string,
    idempotencyKey: string,
  ): Promise<{ descriptor: Omit<ContextDescriptor, "principal">; replay: boolean }> {
    if (!this.options.enabled) {
      throw new ContextControllerError(503, "context_subsystem_degraded", "managed context is not enabled");
    }
    await this.initialize();
    return await this.serialized(() => this.sourceRegistryLifecycle.register(request, principal, idempotencyKey));
  }

  list(
    principal: string,
    options: { cursor?: string; limit?: number } = {},
  ): { contexts: Array<Omit<ContextDescriptor, "principal">>; nextCursor?: string } {
    return this.sourceRegistryLifecycle.list(principal, options);
  }

  async delete(
    principal: string,
    id: string,
    idempotencyKey: string,
  ): Promise<{ deleted: number; replay: boolean }> {
    await this.initialize();
    return await this.serialized(() => this.sourceRegistryLifecycle.delete(principal, id, idempotencyKey));
  }

  async createView(
    request: ContextViewRequest,
    principal: string,
    idempotencyKey: string,
  ): Promise<{ view: ReturnType<typeof publicContextView>; replay: boolean }> {
    if (!this.options.enabled) {
      throw new ContextControllerError(503, "context_subsystem_degraded", "managed context is not enabled");
    }
    await this.initialize();
    return await this.serialized(async () => {
      this.prune();
      return this.viewCreationLifecycle.create(request, principal, idempotencyKey);
    });
  }

  async measureCanonicalRequest(input: {
    principal: string;
    allocationId: string;
    runtime: string;
    request: Record<string, unknown>;
    items?: ContextPlanItem[];
    signal?: AbortSignal;
  }): Promise<{
    inputTokens: number;
    inputBudgetTokens: number;
    release: string;
    leaseEpoch: number;
    tokenizerDigest: string;
    chatTemplateDigest: string;
    sourceDigests: string[];
  }> {
    if (!this.options.enabled) {
      throw new ContextControllerError(503, "context_subsystem_degraded", "managed context is not enabled");
    }
    await this.initialize();
    return await measureCanonicalRequestDomain(input, {
      enabled: this.options.enabled,
      registry: this.options.registry,
      getAllocation: this.options.getAllocation,
      getActivation: (runtime) => this.activation(runtime),
      getRelease: (release) => this.releases.get(release),
      getDescriptor: (principal, contextId, version) => this.descriptors.get(
        descriptorKey(principal, contextId, version),
      ),
      sourceProvider: this.options.sourceProvider,
      sourceMaxBytes: this.options.sourceMaxBytes,
      materializedMaxBytes: this.options.materializedMaxBytes,
      countChatTokens: (endpoint, request, signal) => this.options.tokenizer.countChatTokens(endpoint, request, signal),
      now: () => this.now(),
    });
  }

  productRuntimeBinding(allocationId: string, runtimeId: string): ContextProductRuntimeBinding {
    return this.runtimeEligibility.productRuntimeBinding(allocationId, runtimeId);
  }

  personalStateCleanupEndpoint(runtimeId: string): string | undefined {
    return this.runtimeEligibility.personalStateCleanupEndpoint(runtimeId);
  }

  async bindPersonalStateView(input: {
    principal: string;
    viewId: string;
    requestDigest: string;
    dataEpoch: number;
    actualInputTokens: number;
    selectedItems: ContextPlanItem[];
    omitted: ContextViewOmission[];
  }): Promise<ReturnType<typeof publicContextView>> {
    return await this.personalStateCoordinator.bindView(input);
  }

  viewPersonalStateBinding(principal: string, viewId: string): {
    requestDigest: string;
    dataEpoch: number;
    sourceDigests: string[];
  } | undefined {
    return this.personalStateCoordinator.viewBinding(principal, viewId);
  }

  getView(principal: string, viewId: string): ReturnType<typeof publicContextView> | undefined {
    return this.personalStateCoordinator.getView(principal, viewId);
  }

  async invalidatePersonalState(input: {
    principal: string;
    contextIds: string[];
    sourceHandles: string[];
    sourceDigests?: string[];
    viewIds?: string[];
    attemptIds?: string[];
  }, onPlanned?: (plan: {
    descriptors: ContextDescriptor[];
    viewIds: string[];
    sourceDigests: string[];
  }) => Promise<{ viewIds?: string[] } | void>): Promise<{
    descriptors: ContextDescriptor[];
    viewIds: string[];
    sourceDigests: string[];
  }> {
    return await this.personalStateCoordinator.invalidate(input, onPlanned);
  }

  async prepareChatRequest(input: {
    viewId: string;
    principal: string;
    allocationId: string;
    runtime: string;
    release: string;
    attemptId?: string;
    requestBody: Uint8Array;
    signal?: AbortSignal;
  }): Promise<Uint8Array> {
    if (!this.options.enabled) {
      throw new ContextControllerError(503, "context_subsystem_degraded", "managed context is not enabled");
    }
    return await this.chatRequestLifecycle.prepare(input);
  }

  getOperation(
    principal: string,
    id: string,
  ): Omit<ContextOperation, "principal" | "idempotencyKeyDigest"> {
    this.prune();
    const operation = this.operations.get(id);
    if (!operation || operation.principal !== principal) {
      throw new ContextControllerError(404, "context_not_found", "context operation was not found");
    }
    return publicContextOperation(operation);
  }

  private activation(runtimeId: string): ContextRuntimeStatus {
    return this.runtimeReadiness.activation(runtimeId);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, view] of this.views) {
      if (Date.parse(view.expiresAt) <= now) {
        expireContextView(id, view, {
          updateOperation: (operationId, state, outcome) =>
            this.updateOperation(operationId, state, outcome),
          clearMaterializing: (viewId) => this.materializingViews.delete(viewId),
          removeView: (viewId) => this.views.delete(viewId),
        });
      }
    }
    for (const [key, entry] of this.idempotency) {
      if (entry.expiresAt <= now) this.idempotency.delete(key);
    }
    for (const [id, operation] of this.operations) {
      if (
        operation.state !== "pending"
        && operation.state !== "running"
        && Date.parse(operation.updatedAt) + this.options.idempotencyTtlMs <= now
      ) this.operations.delete(id);
    }
  }

  private replay<T>(principal: string, scope: string, key: string, requestHash: string): T | undefined {
    this.prune();
    const entry = this.idempotency.get(`${principal}\0${scope}\0${key}`);
    if (!entry) return undefined;
    if (entry.requestHash !== requestHash) {
      throw new ContextControllerError(
        409,
        "idempotency_conflict",
        "Idempotency-Key was already used for a different context request",
      );
    }
    return entry.result as T;
  }

  private remember(
    principal: string,
    scope: string,
    key: string,
    requestHash: string,
    result: unknown,
  ): void {
    this.prune();
    this.idempotency.set(`${principal}\0${scope}\0${key}`, {
      requestHash,
      result,
      expiresAt: this.now() + this.options.idempotencyTtlMs,
    });
  }

  private assertIdempotencyCapacity(): void {
    this.prune();
    if (this.idempotency.size >= this.options.idempotencyLimit) {
      throw new ContextControllerError(
        503,
        "context_subsystem_degraded",
        "context idempotency capacity is exhausted",
      );
    }
  }

  private async persist(): Promise<void> {
    await this.options.metadataStore.save(
      [...this.descriptors.values()].sort((left, right) =>
        compareCanonicalText(left.principal, right.principal)
        || compareCanonicalText(left.id, right.id)
        || compareCanonicalText(left.version, right.version)
      ),
    );
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation, operation);
    this.mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private uniqueViewId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = this.options.random?.() ?? crypto.randomUUID();
      const id = `view_${suffix}`;
      if (!this.views.has(id)) return id;
    }
    throw new ContextControllerError(503, "context_subsystem_degraded", "could not allocate a view ID");
  }

  private uniqueOperationId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = this.options.random?.() ?? crypto.randomUUID();
      const id = `ctxop_${suffix}`;
      if (!this.operations.has(id)) return id;
    }
    throw new ContextControllerError(503, "context_subsystem_degraded", "could not allocate an operation ID");
  }

  private updateOperation(
    id: string,
    state: ContextOperation["state"],
    outcome?: string,
  ): void {
    commitContextOperation({
      operations: this.operations,
      id,
      state,
      outcome,
      now: this.now(),
      emit: (name, labels, value) => this.emit(name, labels, value),
    });
  }

  private hash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private emit(name: string, labels: Record<string, string>, value?: number): void {
    this.options.onEvent?.({ name, labels, value });
  }
}
