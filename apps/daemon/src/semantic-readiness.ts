import { createHash } from "node:crypto";
import {
  getRuntime,
  inspectEmbeddingResponse,
  inspectOpenAiChatCompletionJson,
  inspectOpenAiChatCompletionSse,
  type EmbeddingRequest,
  type AgentProviderHealth,
  type AgentProviderProfile,
  type Registry,
} from "@larm/core";
import type { ControlPlane } from "./controller";
import type { ExecutionGate } from "./execution-gate";
import type { FetchLike } from "./gateway";
import { withAbort } from "./http-body";

export type SemanticProbeInput = {
  allocationId: string;
  provider: AgentProviderProfile;
};

type CachedProbe = {
  health: AgentProviderHealth;
  expiresAt: number;
  successful: boolean;
};

const JSON_LIMIT = 65_536;
const AUDIO_LIMIT = 1_048_576;

type ProbeFormat = "json" | "sse" | "default" | "query" | "passage";

type EmbeddingCapacity = NonNullable<AgentProviderHealth["capacity"]>;

function cancelResponseBody(response: Response, reason: string): void {
  void response.body?.cancel(new Error(reason)).catch(() => undefined);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function responseBytes(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) {
    cancelResponseBody(response, "response_too_large");
    throw new Error("response_too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await withAbort(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw new Error("response_too_large");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function silenceWav(): Uint8Array {
  const dataBytes = 8_000;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function validWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 45) return false;
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") return size > 0 && offset + 8 + size <= bytes.byteLength;
    offset += 8 + size + (size % 2);
  }
  return false;
}

function validTranscription(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).text === "string"
    && ((value as Record<string, unknown>).text as string).length <= 4_096;
}

function mediaType(response: Response): string | undefined {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

function rejectResponseBody(response: Response, reason: string): false {
  cancelResponseBody(response, reason);
  return false;
}

export class SemanticReadiness {
  private readonly cache = new Map<string, CachedProbe>();
  private readonly inFlight = new Map<string, Promise<AgentProviderHealth>>();

  constructor(private readonly options: {
    control: ControlPlane;
    getRegistry: () => Registry;
    executionGate: ExecutionGate;
    timeoutMs: number;
    fetchImpl?: FetchLike;
    now?: () => number;
  }) {}

  peek(input: SemanticProbeInput): AgentProviderHealth | undefined {
    const resolved = this.resolve(input);
    if (!resolved.ok) return undefined;
    const cached = this.cache.get(resolved.key);
    if (!cached || cached.expiresAt <= this.now()) return undefined;
    return this.withExecutionCapacity(
      { ...cached.health, probe: cached.health.probe ? { ...cached.health.probe, cached: true } : undefined },
      resolved.runtime!,
    );
  }

  async check(input: SemanticProbeInput): Promise<AgentProviderHealth> {
    const resolved = this.resolve(input);
    if (!resolved.ok) return resolved.health;
    const cached = this.cache.get(resolved.key);
    if (cached && cached.expiresAt > this.now()) {
      if (resolved.busy && cached.successful) {
        return this.withExecutionCapacity({
          ...cached.health,
          acceptingRequests: false,
          probe: cached.health.probe ? { ...cached.health.probe, cached: true } : undefined,
        }, resolved.runtime!);
      }
      if (resolved.busy) {
        return this.failure(input.provider, "provider_busy");
      }
      return this.withExecutionCapacity({
        ...cached.health,
        probe: cached.health.probe ? { ...cached.health.probe, cached: true } : undefined,
      }, resolved.runtime!);
    }
    if (resolved.busy) {
      return this.remember(resolved.key, this.failure(input.provider, "provider_busy"), false);
    }
    const pending = this.inFlight.get(resolved.key);
    if (pending) return await pending;
    const task = this.probe(input, resolved).finally(() => this.inFlight.delete(resolved.key));
    this.inFlight.set(resolved.key, task);
    return await task;
  }

  private resolve(input: SemanticProbeInput):
    | { ok: true; key: string; endpoint: string; runtime: ReturnType<typeof getRuntime>; release?: string; busy: boolean }
    | { ok: false; health: AgentProviderHealth } {
    const result = this.options.control.resolveAllocation(input.allocationId, input.provider.capability);
    if (result.status !== 200) {
      const error = result.body as { error?: { code?: string } };
      const reason = error.error?.code === "stale_state" ? "stale_state" : "allocation_inactive";
      return { ok: false, health: this.failure(input.provider, reason) };
    }
    const binding = result.body;
    if (binding.route !== input.provider.route) {
      return { ok: false, health: this.failure(input.provider, "binding_changed") };
    }
    const runtime = getRuntime(this.options.getRegistry(), binding.runtime);
    if (!runtime || runtime.protocol !== input.provider.protocol) {
      return { ok: false, health: this.failure(input.provider, "binding_changed") };
    }
    const key = digest({
      epoch: this.options.control.getBootEpoch(),
      runtime: runtime.id,
      release: binding.release ?? "",
      runtimeContract: digest(runtime),
      protocol: input.provider.protocol,
      publicModel: input.provider.publicModel,
      bindingRevision: digest({
        capability: binding.capability,
        route: binding.route,
        runtime: binding.runtime,
        node: binding.node,
        endpoint: binding.endpoint,
        candidateRank: binding.candidateRank,
        fallback: binding.fallback,
        selectionReason: binding.selectionReason,
        release: binding.release ?? "",
      }),
    });
    return {
      ok: true,
      key,
      endpoint: binding.endpoint,
      runtime,
      release: binding.release,
      busy: binding.status === "BUSY",
    };
  }

  private async probe(
    input: SemanticProbeInput,
    resolved: Extract<ReturnType<SemanticReadiness["resolve"]>, { ok: true }>,
  ): Promise<AgentProviderHealth> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error("semantic probe timeout")), this.options.timeoutMs);
    timeout.unref?.();
    const release = this.options.executionGate.tryAcquire(
      resolved.runtime!.id,
      resolved.runtime!.resources,
      abort.signal,
    );
    if (!release) {
      clearTimeout(timeout);
      const previous = this.cache.get(resolved.key);
      if (resolved.busy && previous?.successful && previous.expiresAt > this.now()) {
        return {
          ...previous.health,
          acceptingRequests: false,
          probe: previous.health.probe ? { ...previous.health.probe, cached: true } : undefined,
        };
      }
      return this.remember(resolved.key, this.failure(input.provider, "provider_busy"), false);
    }
    const startedAt = this.now();
    try {
      const upstreamCapacity = input.provider.protocol === "larm.embedding.v1"
        ? await this.embeddingCapacity(resolved.endpoint, resolved.runtime!, abort.signal)
        : undefined;
      if (input.provider.protocol === "larm.embedding.v1" && !upstreamCapacity) {
        return this.remember(resolved.key, this.failure(input.provider, "invalid_response"), false);
      }
      const formats = input.provider.protocol === "openai.chat-completions.v1"
        ? ["json", "sse"] as const
        : input.provider.protocol === "larm.embedding.v1"
          ? ["query", "passage"] as const
        : ["default"] as const;
      for (const format of formats) {
        const response = await withAbort(
          this.send(input.provider, resolved.endpoint, abort.signal, format),
          abort.signal,
        );
        if (!response.ok) {
          cancelResponseBody(response, "semantic probe upstream status");
          const reason = [400, 404, 405, 422].includes(response.status)
            ? "provider_contract_mismatch"
            : "upstream_status";
          return this.remember(resolved.key, this.failure(input.provider, reason), false);
        }
        const valid = await this.validate(input.provider, response, abort.signal, format);
        if (!valid) {
          return this.remember(resolved.key, this.failure(input.provider, "invalid_response"), false);
        }
      }
      const observedAt = new Date(this.now()).toISOString();
      const health = this.withExecutionCapacity({
        name: input.provider.name,
        capability: input.provider.capability,
        ready: true,
        acceptingRequests: !resolved.busy,
        probe: {
          kind: "semantic-inference",
          protocol: input.provider.protocol,
          ...(resolved.release ? { release: resolved.release } : {}),
          latencyMs: Math.max(0, this.now() - startedAt),
          validated: true,
          cached: false,
          observedAt,
        },
      }, resolved.runtime!, 1);
      return this.remember(resolved.key, health, true);
    } catch (error) {
      const reason = abort.signal.aborted ? "probe_timeout" : "invalid_response";
      return this.remember(resolved.key, this.failure(input.provider, reason), false);
    } finally {
      clearTimeout(timeout);
      release();
    }
  }

  private withExecutionCapacity(
    health: AgentProviderHealth,
    runtime: NonNullable<ReturnType<typeof getRuntime>>,
    excludeActive = 0,
  ): AgentProviderHealth {
    if (!health.ready) return health;
    const snapshot = this.options.executionGate.snapshot(runtime.id);
    const activeRequests = Math.max(0, snapshot.active - excludeActive);
    const queueDepth = snapshot.queued;
    const saturated = activeRequests >= runtime.resources.maxConcurrentRequests
      && queueDepth >= runtime.resources.maxQueuedRequests;
    return {
      ...health,
      acceptingRequests: health.acceptingRequests && !saturated,
      capacity: {
        ready: true,
        activeRequests,
        maxConcurrentRequests: runtime.resources.maxConcurrentRequests,
        queueDepth,
        maxQueuedRequests: runtime.resources.maxQueuedRequests,
        queueTimeoutMs: runtime.resources.queueTimeoutMs,
        retryAfterMs: saturated ? runtime.resources.queueTimeoutMs : 0,
        completionGuaranteed: false,
      },
    };
  }

  private async send(
    provider: AgentProviderProfile,
    endpoint: string,
    signal: AbortSignal,
    format: ProbeFormat,
  ): Promise<Response> {
    const base = endpoint.replace(/\/+$/, "");
    if (provider.protocol === "openai.chat-completions.v1") {
      const stream = format === "sse";
      return await (this.options.fetchImpl ?? fetch)(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify({
          model: provider.publicModel,
          messages: [{ role: "user", content: "0" }],
          temperature: 0,
          max_tokens: 1,
          stream,
        }),
        signal,
        redirect: "manual",
      });
    }
    if (provider.protocol === "openai.audio-transcriptions.v1") {
      const form = new FormData();
      form.append("model", provider.publicModel);
      form.append("file", new Blob([silenceWav()], { type: "audio/wav" }), "probe.wav");
      return await (this.options.fetchImpl ?? fetch)(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { accept: "application/json" },
        body: form,
        signal,
        redirect: "manual",
      });
    }
    if (provider.protocol === "larm.embedding.v1") {
      const request: EmbeddingRequest = {
        texts: [format === "passage" ? "readiness passage" : "readiness query"],
        type: format === "passage" ? "passage" : "query",
        normalize: true,
        priority: "low",
      };
      return await (this.options.fetchImpl ?? fetch)(`${base}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(request),
        signal,
        redirect: "manual",
      });
    }
    return await (this.options.fetchImpl ?? fetch)(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/wav" },
      body: JSON.stringify({ model: provider.publicModel, input: "a", response_format: "wav" }),
      signal,
      redirect: "manual",
    });
  }

  private async validate(
    provider: AgentProviderProfile,
    response: Response,
    signal: AbortSignal,
    format: ProbeFormat,
  ): Promise<boolean> {
    if (provider.protocol === "openai.audio-speech.v1") {
      if (mediaType(response) !== "audio/wav") {
        return rejectResponseBody(response, "semantic probe content type mismatch");
      }
      return validWav(await responseBytes(response, AUDIO_LIMIT, signal));
    }
    if (provider.protocol === "openai.chat-completions.v1" && format === "sse") {
      if (mediaType(response) !== "text/event-stream") {
        return rejectResponseBody(response, "semantic probe content type mismatch");
      }
      const inspected = inspectOpenAiChatCompletionSse(await responseBytes(response, JSON_LIMIT, signal));
      return inspected.ok;
    }
    if (mediaType(response) !== "application/json") {
      return rejectResponseBody(response, "semantic probe content type mismatch");
    }
    const bytes = await responseBytes(response, JSON_LIMIT, signal);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return false;
    }
    if (provider.protocol === "larm.embedding.v1") {
      if (!provider.embeddingSpace || (format !== "query" && format !== "passage")) return false;
      const request: EmbeddingRequest = {
        texts: [format === "passage" ? "readiness passage" : "readiness query"],
        type: format,
        normalize: true,
        priority: "low",
      };
      return inspectEmbeddingResponse({ value, request, space: provider.embeddingSpace }).ok;
    }
    if (provider.protocol !== "openai.chat-completions.v1") return validTranscription(value);
    const inspected = inspectOpenAiChatCompletionJson(value);
    return inspected.ok
      && inspected.textChoices > 0
      && inspected.completionTokens === 1;
  }

  private failure(provider: AgentProviderProfile, reason: AgentProviderHealth["reason"]): AgentProviderHealth {
    return {
      name: provider.name,
      capability: provider.capability,
      ready: false,
      acceptingRequests: false,
      reason,
    };
  }

  private async embeddingCapacity(
    endpoint: string,
    runtime: NonNullable<ReturnType<typeof getRuntime>>,
    signal: AbortSignal,
  ): Promise<EmbeddingCapacity | undefined> {
    const response = await withAbort((this.options.fetchImpl ?? fetch)(`${endpoint.replace(/\/+$/, "")}/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
      redirect: "manual",
    }), signal);
    if (!response.ok || mediaType(response) !== "application/json") {
      cancelResponseBody(response, "embedding health contract failed");
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        await responseBytes(response, JSON_LIMIT, signal),
      )) as unknown;
    } catch {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const health = value as Record<string, unknown>;
    if (
      health.ready !== true
      || health.modelLoaded !== true
      || health.service !== "embeddingd"
      || !Number.isInteger(health.activeRequests)
      || Number(health.activeRequests) < 0
      || Number(health.activeRequests) > 100_000
      || !Number.isInteger(health.queueDepth)
      || Number(health.queueDepth) < 0
      || Number(health.queueDepth) > 100_000
    ) return undefined;
    const activeRequests = Number(health.activeRequests);
    const queueDepth = Number(health.queueDepth);
    const saturated = activeRequests >= runtime.resources.maxConcurrentRequests
      && queueDepth >= runtime.resources.maxQueuedRequests;
    return {
      ready: true,
      activeRequests,
      maxConcurrentRequests: runtime.resources.maxConcurrentRequests,
      queueDepth,
      maxQueuedRequests: runtime.resources.maxQueuedRequests,
      queueTimeoutMs: runtime.resources.queueTimeoutMs,
      retryAfterMs: saturated ? runtime.resources.queueTimeoutMs : 0,
      completionGuaranteed: false,
    };
  }

  private remember(key: string, health: AgentProviderHealth, successful: boolean): AgentProviderHealth {
    this.cache.set(key, { health, successful, expiresAt: this.now() + (successful ? 10_000 : 1_000) });
    return health;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
