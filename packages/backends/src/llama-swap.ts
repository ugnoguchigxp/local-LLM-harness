import type { LlamaSwapRuntimeDefinition, RuntimeDefinition, ServiceState } from "@larm/core";
import { isLlamaSwapRuntime } from "@larm/core";
import { LifecycleError, type RuntimeBackend, type RuntimeHealth } from "./types";

const HEALTH_OK = /"status"\s*:\s*"ok"/;

export type LlamaSwapHttpResponse = {
  ok: boolean;
  status: number;
  body: string;
};

export type LlamaSwapRequest = (
  url: string,
  init?: { method?: string; timeoutMs?: number },
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

  async health(runtimeId: string): Promise<RuntimeHealth> {
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

    const processes = await this.running(runtime.deployment.listen);
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
    const plain = await this.probeHealth(healthUrl, false);
    const slot = await this.probeHealth(healthUrl, true);
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

  async ensure(runtime: RuntimeDefinition): Promise<RuntimeHealth> {
    if (!isLlamaSwapRuntime(runtime)) {
      throw new LifecycleError("start_failed", `${runtime.id} is not a llama-swap runtime`);
    }
    this.assertControllable(runtime, "ensure");
    this.runtimes.set(runtime.id, runtime);
    await this.load(runtime);
    await this.waitHealthy(runtime);
    return this.health(runtime.id);
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

  private async load(runtime: LlamaSwapRuntimeDefinition): Promise<void> {
    const loadUrl = joinListen(
      runtime.deployment.listen,
      `/api/models/load/${encodeURIComponent(runtime.deployment.modelId)}`,
    );
    try {
      const response = await this.request(loadUrl, {
        method: "POST",
        timeoutMs: this.readyTimeoutMs,
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
      if (err instanceof LifecycleError) {
        throw err;
      }
    }

    const warmUrl = this.upstreamHealthUrl(runtime);
    try {
      await this.request(warmUrl, { timeoutMs: this.readyTimeoutMs });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new LifecycleError("start_failed", `failed to warm ${runtime.id}: ${detail}`);
    }
  }

  private async waitHealthy(runtime: LlamaSwapRuntimeDefinition): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      const probe = await this.health(runtime.id);
      if (probe.healthOk) {
        return;
      }
      await this.sleep(Math.min(2000, this.probeTimeoutMs));
    }
    throw new LifecycleError(
      "start_failed",
      `${runtime.id} did not become healthy within ${this.readyTimeoutMs}ms`,
    );
  }

  private async running(listen: string): Promise<LlamaSwapProcess[] | undefined> {
    try {
      const response = await this.request(joinListen(listen, "/running"), {
        timeoutMs: this.probeTimeoutMs,
      });
      if (!response.ok) {
        return undefined;
      }
      return parseRunning(response.body);
    } catch {
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
  ): Promise<{ ok: boolean; status?: number; detail?: string }> {
    const url = failOnNoSlot ? `${healthUrl}?fail_on_no_slot=true` : healthUrl;
    try {
      const response = await this.request(url, { timeoutMs: this.probeTimeoutMs });
      return {
        ok: response.ok && HEALTH_OK.test(response.body),
        status: response.status,
        detail: response.body.slice(0, 200),
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, detail };
    }
  }
}

async function defaultRequest(
  url: string,
  init: { method?: string; timeoutMs?: number } = {},
): Promise<LlamaSwapHttpResponse> {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    signal: AbortSignal.timeout(init.timeoutMs ?? 1500),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
  };
}
