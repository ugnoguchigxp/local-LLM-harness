import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { RuntimeDefinition, ServiceState, SystemdRuntimeDefinition } from "@larm/core";
import { isSystemdRuntime } from "@larm/core";
import { LifecycleError, type RuntimeBackend, type RuntimeHealth } from "./types";
import { responseTextLimited } from "./http";

const HEALTH_OK = /(?:"status"\s*:\s*"(?:ok|healthy)"|"ready"\s*:\s*true)/i;
const MAX_COMMAND_OUTPUT = 64 * 1024;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("runtime start was cancelled");
  }
}

function appendOutput(current: string, chunk: unknown): string {
  const combined = current + String(chunk);
  return combined.length > MAX_COMMAND_OUTPUT
    ? combined.slice(combined.length - MAX_COMMAND_OUTPUT)
    : combined;
}

export type SystemdServiceControl = {
  start: (name: string, signal?: AbortSignal) => Promise<void>;
  stop: (name: string) => Promise<void>;
};

export type SystemdBackendOptions = {
  probeTimeoutMs?: number;
  readyTimeoutMs?: number;
  queryService?: (service: string) => Promise<ServiceState>;
  control?: SystemdServiceControl;
  systemctlPath?: string;
  sleep?: (ms: number) => Promise<void>;
};

export class SystemdBackend implements RuntimeBackend {
  private readonly runtimes: Map<string, SystemdRuntimeDefinition>;
  private readonly probeTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly queryService: (service: string) => Promise<ServiceState>;
  private readonly control: SystemdServiceControl;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(runtimes: RuntimeDefinition[], options: SystemdBackendOptions = {}) {
    this.runtimes = new Map(
      runtimes.filter(isSystemdRuntime).map((runtime) => [runtime.id, runtime]),
    );
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1500;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 300_000;
    this.queryService =
      options.queryService ?? createSystemdQuery(options.systemctlPath ?? "systemctl");
    this.control =
      options.control ?? createSystemdControl(options.systemctlPath ?? "systemctl");
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async list(): Promise<RuntimeHealth[]> {
    return Promise.all([...this.runtimes.keys()].map((id) => this.health(id)));
  }

  async health(runtimeId: string): Promise<RuntimeHealth> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      return missing(runtimeId);
    }

    const [service, listening] = await Promise.all([
      this.queryService(runtime.deployment.service),
      isListening(runtime.deployment.healthPort, this.probeTimeoutMs),
    ]);
    if (!listening) {
      return {
        runtimeId,
        service,
        listening: false,
        healthOk: false,
        busy: false,
      };
    }

    const path = runtime.deployment.healthPath ?? "/health";
    const [plain, slot] = await Promise.all([
      probeHealth(runtime.deployment.healthPort, path, false, this.probeTimeoutMs),
      probeHealth(runtime.deployment.healthPort, path, true, this.probeTimeoutMs),
    ]);
    return {
      runtimeId,
      service,
      listening: true,
      healthOk: plain.ok,
      busy: slot.status === 503,
      httpStatus: plain.status,
      detail: plain.detail,
    };
  }

  async ensure(runtime: RuntimeDefinition, signal?: AbortSignal): Promise<RuntimeHealth> {
    if (!isSystemdRuntime(runtime)) {
      throw new LifecycleError("start_failed", `${runtime.id} is not a systemd runtime`);
    }
    this.assertControllable(runtime, "ensure");
    throwIfAborted(signal);
    this.runtimes.set(runtime.id, runtime);
    await this.control.start(runtime.deployment.service, signal);
    throwIfAborted(signal);
    await this.waitHealthy(runtime, signal);
    throwIfAborted(signal);
    const health = await this.health(runtime.id);
    throwIfAborted(signal);
    return health;
  }

  async stop(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      throw new LifecycleError("stop_failed", `runtime ${runtimeId} is not registered`);
    }
    this.assertControllable(runtime, "stop");
    await this.control.stop(runtime.deployment.service);
  }

  private assertControllable(runtime: SystemdRuntimeDefinition, action: string): void {
    if (runtime.policy.class === "resident") {
      throw new LifecycleError(
        "resident_protected",
        `refusing to ${action} resident runtime ${runtime.id}`,
      );
    }
  }

  private async waitHealthy(
    runtime: SystemdRuntimeDefinition,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const probe = await probeHealth(
        runtime.deployment.healthPort,
        runtime.deployment.healthPath ?? "/health",
        false,
        this.probeTimeoutMs,
        signal,
      );
      if (probe.ok) {
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
}

const missing = (runtimeId: string): RuntimeHealth => ({
  runtimeId,
  service: "NotFound",
  listening: false,
  healthOk: false,
  busy: false,
  detail: "runtime is not registered with this backend",
});

function isListening(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function probeHealth(
  port: number,
  path: string,
  failOnNoSlot: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const separator = path.includes("?") ? "&" : "?";
  const suffix = failOnNoSlot ? `${separator}fail_on_no_slot=true` : "";
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}${suffix}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    const body = await responseTextLimited(response);
    return {
      ok: response.ok && HEALTH_OK.test(body),
      status: response.status,
      detail: body.slice(0, 200),
    };
  } catch (error) {
    throwIfAborted(signal);
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail };
  }
}

export function parseSystemctlState(stdout: string, stderr: string, exitCode: number): ServiceState {
  const state = stdout.trim().toLowerCase();
  const detail = `${stdout}\n${stderr}`;
  if (state === "active" || state === "activating" || state === "reloading") {
    return "Running";
  }
  if (state === "inactive" || state === "deactivating" || state === "failed") {
    return "Stopped";
  }
  if (exitCode === 4 || /not[- ]found|could not be found|no such file/i.test(detail)) {
    return "NotFound";
  }
  return "Unknown";
}

function createSystemdQuery(systemctlPath: string) {
  return (service: string): Promise<ServiceState> =>
    new Promise((resolve) => {
      const child = spawn(systemctlPath, ["is-active", service]);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (state: ServiceState) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(state);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish("Unknown");
      }, 1500);
      child.stdout.on("data", (chunk) => {
        stdout = appendOutput(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendOutput(stderr, chunk);
      });
      child.on("error", () => {
        finish("Unknown");
      });
      child.on("close", (code) => {
        finish(parseSystemctlState(stdout, stderr, code ?? 1));
      });
    });
}

function createSystemdControl(systemctlPath: string): SystemdServiceControl {
  return {
    start: (name, signal) =>
      runSystemctl(systemctlPath, "start", name, "start_failed", signal),
    stop: (name) => runSystemctl(systemctlPath, "stop", name, "stop_failed"),
  };
}

function runSystemctl(
  systemctlPath: string,
  action: "start" | "stop",
  service: string,
  failCode: "start_failed" | "stop_failed",
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(systemctlPath, [action, service]);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abortStart);
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const abortStart = () => {
      child.kill();
      fail(signal?.reason instanceof Error ? signal.reason : new Error("runtime start was cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(new LifecycleError(failCode, `systemctl ${action} ${service} timed out`));
    }, 30_000);
    if (signal?.aborted) {
      abortStart();
    } else {
      signal?.addEventListener("abort", abortStart, { once: true });
    }
    child.stdout.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      fail(new LifecycleError(failCode, error.message));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      const detail = `${stdout}\n${stderr}`.trim();
      if (code === 0) {
        succeed();
        return;
      }
      if (/access denied|authentication is required|permission denied/i.test(detail)) {
        fail(new LifecycleError("access_denied", `systemctl ${action} ${service}: ${detail}`));
        return;
      }
      fail(
        new LifecycleError(
          failCode,
          `systemctl ${action} ${service} exited ${code}: ${detail}`,
        ),
      );
    });
  });
}
