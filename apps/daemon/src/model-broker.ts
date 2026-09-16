import {
  allocationSchema,
  createOpenAiModelCatalog,
  getOpenAiModel,
  listOpenAiModels,
  type AgentConnectionCatalog,
  type Allocation,
  type AllocationBinding,
  type OpenAiModelBinding,
  type OpenAiModelList,
  type RuntimeProtocol,
} from "@larm/core";
import type { ControlEvent, ControlPlane } from "./controller";

export class ModelBrokerError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429 | 503,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ModelBrokerError";
  }
}

export type ModelBrokerLease = {
  publicModel: string;
  allocationId: string;
  capability: string;
  route: string;
  runtime: string;
  endpoint: string;
  release?: string;
  catalogRevision?: string;
  priority: number;
  lifecycleSignal?: AbortSignal;
  close(): Promise<void>;
};

export type ModelBrokerOptions = {
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  leaseTtlSeconds?: number;
  now?: () => number;
  onEvent?: (event: ControlEvent) => void;
};

type ResolvedModel = {
  allocation: Allocation;
  binding: AllocationBinding;
};

type SharedModelLease = {
  descriptor: OpenAiModelBinding;
  abort: AbortController;
  refs: number;
  allocationId?: string;
  ready: Promise<ResolvedModel>;
  closing?: Promise<void>;
};

function errorDetail(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return {};
  const detail = error as Record<string, unknown>;
  return {
    ...(typeof detail.code === "string" ? { code: detail.code } : {}),
    ...(typeof detail.message === "string" ? { message: detail.message } : {}),
  };
}

function brokerFailure(status: number, body: unknown): ModelBrokerError {
  const detail = errorDetail(body);
  const code = detail.code ?? "model_unavailable";
  if (code === "resource_exhausted" || code === "allocation_capacity") {
    return new ModelBrokerError(429, code, detail.message ?? "model capacity is exhausted", 1);
  }
  if (status === 404) {
    return new ModelBrokerError(404, code, detail.message ?? "model route was not found");
  }
  if (status === 400) {
    return new ModelBrokerError(400, code, detail.message ?? "model request is invalid");
  }
  if (status === 409) {
    return new ModelBrokerError(409, code, detail.message ?? "model cannot be acquired");
  }
  return new ModelBrokerError(503, code, detail.message ?? "model is unavailable", 1);
}

function abortError(): ModelBrokerError {
  return new ModelBrokerError(400, "request_cancelled", "client cancelled the request");
}

async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw abortError();
  let rejectAbort: ((error: ModelBrokerError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ModelBroker {
  private readonly catalog;
  private readonly shared = new Map<string, SharedModelLease>();
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly leaseTtlSeconds: number;
  private readonly now: () => number;

  constructor(
    private readonly control: ControlPlane,
    catalog: AgentConnectionCatalog,
    private readonly options: ModelBrokerOptions = {},
  ) {
    this.catalog = createOpenAiModelCatalog(catalog);
    this.startupTimeoutMs = options.startupTimeoutMs ?? 300_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.leaseTtlSeconds = options.leaseTtlSeconds ?? 900;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.startupTimeoutMs) || this.startupTimeoutMs <= 0) {
      throw new RangeError("Model Broker startup timeout must be positive");
    }
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new RangeError("Model Broker poll interval must be positive");
    }
    if (!Number.isInteger(this.leaseTtlSeconds) || this.leaseTtlSeconds < 1 || this.leaseTtlSeconds > 86_400) {
      throw new RangeError("Model Broker lease TTL must be an integer from 1 to 86400 seconds");
    }
  }

  listModels(): OpenAiModelList {
    return listOpenAiModels(this.catalog);
  }

  async acquire(
    model: string,
    protocol: RuntimeProtocol,
    signal?: AbortSignal,
  ): Promise<ModelBrokerLease> {
    const descriptor = getOpenAiModel(this.catalog, model, protocol);
    if (!descriptor) {
      throw new ModelBrokerError(404, "model_not_found", `model ${model} is not available`);
    }

    let entry = this.shared.get(model);
    if (entry?.closing) {
      await waitWithSignal(entry.closing, signal);
      return await this.acquire(model, protocol, signal);
    }
    if (!entry) {
      const abort = new AbortController();
      entry = {
        descriptor,
        abort,
        refs: 0,
        ready: Promise.resolve(undefined as never),
      };
      entry.ready = this.prepare(entry);
      this.shared.set(model, entry);
    }
    entry.refs += 1;
    let resolved: ResolvedModel;
    try {
      resolved = await waitWithSignal(entry.ready, signal);
    } catch (error) {
      await this.releaseReference(model, entry);
      throw error;
    }

    let closed = false;
    return {
      publicModel: descriptor.id,
      allocationId: resolved.allocation.id,
      capability: descriptor.capability,
      route: descriptor.route,
      runtime: resolved.binding.runtime,
      endpoint: resolved.binding.endpoint,
      ...(resolved.binding.release ? { release: resolved.binding.release } : {}),
      ...(resolved.allocation.catalogRevision
        ? { catalogRevision: resolved.allocation.catalogRevision }
        : {}),
      priority: resolved.allocation.priority ?? descriptor.schedulingPriority,
      lifecycleSignal: this.control.getAllocationSignal(resolved.allocation.id),
      close: async () => {
        if (closed) return;
        closed = true;
        await this.releaseReference(model, entry!);
      },
    };
  }

  private async prepare(entry: SharedModelLease): Promise<ResolvedModel> {
    const startedAt = this.now();
    this.options.onEvent?.({
      name: "model_broker_prepare_started",
      labels: { model: entry.descriptor.id, route: entry.descriptor.route },
    });
    const result = await this.control.allocate({
      requirements: [{
        capability: entry.descriptor.capability,
        route: entry.descriptor.route,
      }],
      client: "openai-http",
      allowFallback: false,
      ttlSeconds: this.leaseTtlSeconds,
      deploymentPolicy: "existing-only",
      priority: entry.descriptor.schedulingPriority,
      capacityPolicy: "wait",
    });
    if (result.status !== 200 && result.status !== 202) {
      throw brokerFailure(result.status, result.body);
    }
    const parsed = allocationSchema.safeParse(result.body);
    if (!parsed.success) {
      throw new ModelBrokerError(503, "invalid_allocation", "control plane returned an invalid allocation");
    }
    entry.allocationId = parsed.data.id;
    const deadline = startedAt + this.startupTimeoutMs;
    while (true) {
      if (entry.abort.signal.aborted) throw abortError();
      const allocation = this.control.getAllocation(parsed.data.id);
      if (!allocation) {
        throw new ModelBrokerError(503, "allocation_lost", "model allocation disappeared while preparing");
      }
      if (allocation.status === "ready") {
        const resolved = this.control.resolveAllocation(allocation.id, entry.descriptor.capability);
        if (resolved.status !== 200 || !("endpoint" in resolved.body)) {
          throw brokerFailure(resolved.status, resolved.body);
        }
        const binding = allocation.bindings.find((candidate) =>
          candidate.capability === entry.descriptor.capability
        );
        if (!binding || binding.runtime !== resolved.body.runtime || binding.endpoint !== resolved.body.endpoint) {
          throw new ModelBrokerError(503, "binding_mismatch", "model allocation binding changed while preparing");
        }
        this.options.onEvent?.({
          name: "model_broker_prepare_completed",
          labels: {
            model: entry.descriptor.id,
            route: entry.descriptor.route,
            runtime: binding.runtime,
          },
          value: Math.max(0, (this.now() - startedAt) / 1_000),
        });
        return { allocation, binding };
      }
      if (allocation.status !== "pending" && allocation.status !== "waiting") {
        throw brokerFailure(503, allocation.error ? { error: allocation.error } : undefined);
      }
      if (this.now() >= deadline) {
        throw new ModelBrokerError(503, "model_loading_timeout", `model ${entry.descriptor.id} did not become ready`, 1);
      }
      await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - this.now())), entry.abort.signal);
    }
  }

  private async releaseReference(model: string, entry: SharedModelLease): Promise<void> {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (!entry.closing) {
      entry.abort.abort(new Error("model lease is no longer referenced"));
      entry.closing = (async () => {
        await entry.ready.catch(() => undefined);
        if (entry.allocationId) {
          const released = await this.control.releaseAllocation(entry.allocationId);
          if (released.status !== 200 && released.status !== 404) {
            const detail = errorDetail(released.body);
            this.options.onEvent?.({
              name: "model_broker_release_failed",
              labels: {
                model,
                reason: detail.code ?? `http_${released.status}`,
              },
            });
          }
        }
      })().finally(() => {
        if (this.shared.get(model) === entry) this.shared.delete(model);
      });
    }
    await entry.closing;
  }
}
