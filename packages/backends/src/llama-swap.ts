import type { LlamaSwapRuntimeDefinition, RuntimeDefinition, ServiceState } from "@larm/core";
import { isLlamaSwapRuntime } from "@larm/core";
import { LifecycleError, type RuntimeBackend, type RuntimeHealth } from "./types";
import { responseTextLimited } from "./http";

const HEALTH_OK = /"status"\s*:\s*"ok"/;

export type LlamaSwapHttpResponse = {
  ok: boolean;
  status: number;
  body: string;
};

export type LlamaSwapRequest = (
  url: string,
  init?: { method?: string; timeoutMs?: number; signal?: AbortSignal },
) => Promise<LlamaSwapHttpResponse>;

export type LlamaSwapBackendOptions = {
  probeTimeoutMs?: number;
  readyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  request?: LlamaSwapRequest;
};

export type LlamaSwapProcess = {
  model: string;
  state: string;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("runtime start was cancelled");
  }
}

export function parseRunning(body: string): LlamaSwapProcess[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const record = parsed as { running?: unknown; model?: unknown; state?: unknown };
  if (Array.isArray(record.running)) {
    return record.running.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const row = item as { model?: unknown; state?: unknown };
      if (typeof row.model !== "string") {
        return [];
      }
      return [
        {
          model: row.model,
          state: typeof row.state === "string" ? row.state : "unknown",
        },
      ];
    });
  }
  if (typeof record.model === "string") {
    return [
      {
        model: record.model,
        state: typeof record.state === "string" ? record.state : "unknown",
      },
    ];
  }
  return [];
}

export function joinListen(listen: string, path: string): string {
  const base = listen.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function mapProcessState(state: string | undefined): {
  service: ServiceState;
  listening: boolean;
} {
  if (state === undefined) {
    return { service: "Stopped", listening: false };
  }
  switch (state) {
    case "ready":
    case "starting":
      return { service: "Running", listening: true };
    case "stopping":
    case "stopped":
    case "shutdown":
      return { service: "Stopped", listening: false };
    default:
      return { service: "Unknown", listening: false };
  }
}

export class LlamaSwapBackend implements RuntimeBackend {
  private readonly runtimes: Map<string, LlamaSwapRuntimeDefinition>;
  private readonly probeTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly request: LlamaSwapRequest;

  constructor(runtimes: RuntimeDefinition[], options: LlamaSwapBackendOptions = {}) {
    this.runtimes = new Map(
      runtimes.filter(isLlamaSwapRuntime).map((runtime) => [runtime.id, runtime]),
    );
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1500;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 300_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.request = options.request ?? defaultRequest;
  }

  async list(): Promise<RuntimeHealth[]> {
    return Promise.all([...this.runtimes.keys()].map((id) => this.health(id)));
  }

  async health(runtimeId: string, signal?: AbortSignal): Promise<RuntimeHealth> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      return {
        runtimeId,
        service: "NotFound",
        listening: false,
        healthOk: false,
        busy: false,
        detail: "runtime is not registered with this backend",
      };
    }

    const processes = await this.running(runtime.deployment.listen, signal);
    throwIfAborted(signal);
    if (processes === undefined) {
      return {
        runtimeId,
        service: "Unknown",
        listening: false,
        healthOk: false,
        busy: false,
        detail: "llama-swap is unreachable",
      };
    }

    const process = processes.find((item) => item.model === runtime.deployment.modelId);
    const mapped = mapProcessState(process?.state);
    if (process?.state !== "ready") {
      return {
        runtimeId,
        service: mapped.service,
        listening: mapped.listening,
        healthOk: false,
        busy: false,
        detail: process ? `llama-swap state ${process.state}` : "model is not running",
      };
    }

    const healthUrl = this.upstreamHealthUrl(runtime);
    const [plain, slot] = await Promise.all([
      this.probeHealth(healthUrl, false, signal),
      this.probeHealth(healthUrl, true, signal),
    ]);
    return {
      runtimeId,
      service: "Running",
      listening: true,
      healthOk: plain.ok,
      busy: slot.status === 503,
      httpStatus: plain.status,
      detail: plain.detail,
    };
  }

  async ensure(runtime: RuntimeDefinition, signal?: AbortSignal): Promise<RuntimeHealth> {
    if (!isLlamaSwapRuntime(runtime)) {
      throw new LifecycleError("start_failed", `${runtime.id} is not a llama-swap runtime`);
    }
    this.assertControllable(runtime, "ensure");
    throwIfAborted(signal);
    this.runtimes.set(runtime.id, runtime);
    await this.load(runtime, signal);
    await this.waitHealthy(runtime, signal);
    throwIfAborted(signal);
    return this.health(runtime.id, signal);
  }

  async stop(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      throw new LifecycleError("stop_failed", `runtime ${runtimeId} is not registered`);
    }
    this.assertControllable(runtime, "stop");
    const url = joinListen(
      runtime.deployment.listen,
      `/api/models/unload/${encodeURIComponent(runtime.deployment.modelId)}`,
    );
    try {
      const response = await this.request(url, {
        method: "POST",
        timeoutMs: this.readyTimeoutMs,
      });
      if (!response.ok && response.status !== 404) {
        throw new LifecycleError(
          "stop_failed",
          `llama-swap unload ${runtime.deployment.modelId} returned ${response.status}: ${response.body.slice(0, 200)}`,
        );
      }
    } catch (err) {
      if (err instanceof LifecycleError) {
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new LifecycleError("stop_failed", detail);
    }
  }

  private assertControllable(runtime: RuntimeDefinition, action: string): void {
    if (runtime.policy.class === "resident") {
      throw new LifecycleError(
        "resident_protected",
        `refusing to ${action} resident runtime ${runtime.id}`,
      );
    }
  }

  private async load(runtime: LlamaSwapRuntimeDefinition, signal?: AbortSignal): Promise<void> {
    const loadUrl = joinListen(
      runtime.deployment.listen,
      `/api/models/load/${encodeURIComponent(runtime.deployment.modelId)}`,
    );
    try {
      const response = await this.request(loadUrl, {
        method: "POST",
        timeoutMs: this.readyTimeoutMs,
        signal,
      });
      if (response.ok) {
        return;
      }
      if (response.status !== 404 && response.status !== 405) {
        throw new LifecycleError(
          "start_failed",
          `llama-swap load ${runtime.deployment.modelId} returned ${response.status}: ${response.body.slice(0, 200)}`,
        );
      }
    } catch (err) {
      throwIfAborted(signal);
      if (err instanceof LifecycleError) {
        throw err;
      }
    }

    const warmUrl = this.upstreamHealthUrl(runtime);
    try {
      await this.request(warmUrl, { timeoutMs: this.readyTimeoutMs, signal });
    } catch (err) {
      throwIfAborted(signal);
      const detail = err instanceof Error ? err.message : String(err);
      throw new LifecycleError("start_failed", `failed to warm ${runtime.id}: ${detail}`);
    }
  }

  private async waitHealthy(
    runtime: LlamaSwapRuntimeDefinition,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const probe = await this.health(runtime.id, signal);
      if (probe.healthOk) {
        return;
      }
      await this.sleep(Math.min(2000, this.probeTimeoutMs));
      throwIfAborted(signal);
    }
    throw new LifecycleError(
      "start_failed",
      `${runtime.id} did not become healthy within ${this.readyTimeoutMs}ms`,
    );
  }

  private async running(
    listen: string,
    signal?: AbortSignal,
  ): Promise<LlamaSwapProcess[] | undefined> {
    try {
      const response = await this.request(joinListen(listen, "/running"), {
        timeoutMs: this.probeTimeoutMs,
        signal,
      });
      if (!response.ok) {
        return undefined;
      }
      return parseRunning(response.body);
    } catch {
      throwIfAborted(signal);
      return undefined;
    }
  }

  private upstreamHealthUrl(runtime: LlamaSwapRuntimeDefinition): string {
    if (runtime.deployment.backendEndpoint) {
      return joinListen(runtime.deployment.backendEndpoint, "/health");
    }
    return joinListen(
      runtime.deployment.listen,
      `/upstream/${encodeURIComponent(runtime.deployment.modelId)}/health`,
    );
  }

  private async probeHealth(
    healthUrl: string,
    failOnNoSlot: boolean,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; status?: number; detail?: string }> {
    const separator = healthUrl.includes("?") ? "&" : "?";
    const url = failOnNoSlot ? `${healthUrl}${separator}fail_on_no_slot=true` : healthUrl;
    try {
      const response = await this.request(url, {
        timeoutMs: this.probeTimeoutMs,
        signal,
      });
      return {
        ok: response.ok && HEALTH_OK.test(response.body),
        status: response.status,
        detail: response.body.slice(0, 200),
      };
    } catch (err) {
      throwIfAborted(signal);
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, detail };
    }
  }
}

async function defaultRequest(
  url: string,
  init: { method?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<LlamaSwapHttpResponse> {
  const timeoutSignal = AbortSignal.timeout(init.timeoutMs ?? 1500);
  const response = await fetch(url, {
    method: init.method ?? "GET",
    signal: init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal,
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await responseTextLimited(response),
  };
}
