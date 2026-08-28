import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { RuntimeDefinition, ServiceState, SystemdRuntimeDefinition } from "@larm/core";
import { isSystemdRuntime } from "@larm/core";
import { LifecycleError, type RuntimeBackend, type RuntimeHealth } from "./types";

const HEALTH_OK = /"status"\s*:\s*"(?:ok|healthy)"/i;

export type SystemdServiceControl = {
  start: (name: string) => Promise<void>;
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

    const service = await this.queryService(runtime.deployment.service);
    const listening = await isListening(runtime.deployment.healthPort, this.probeTimeoutMs);
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
    const plain = await probeHealth(
      runtime.deployment.healthPort,
      path,
      false,
      this.probeTimeoutMs,
    );
    const slot = await probeHealth(
      runtime.deployment.healthPort,
      path,
      true,
      this.probeTimeoutMs,
    );
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

  async ensure(runtime: RuntimeDefinition): Promise<RuntimeHealth> {
    if (!isSystemdRuntime(runtime)) {
      throw new LifecycleError("start_failed", `${runtime.id} is not a systemd runtime`);
    }
    this.assertControllable(runtime, "ensure");
    this.runtimes.set(runtime.id, runtime);
    await this.control.start(runtime.deployment.service);
    await this.waitHealthy(runtime);
    return this.health(runtime.id);
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

  private async waitHealthy(runtime: SystemdRuntimeDefinition): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      const probe = await probeHealth(
        runtime.deployment.healthPort,
        runtime.deployment.healthPath ?? "/health",
        false,
        this.probeTimeoutMs,
      );
      if (probe.ok) {
        return;
      }
      await this.sleep(Math.min(2000, this.probeTimeoutMs));
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
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const separator = path.includes("?") ? "&" : "?";
  const suffix = failOnNoSlot ? `${separator}fail_on_no_slot=true` : "";
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}${suffix}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    return {
      ok: response.ok && HEALTH_OK.test(body),
      status: response.status,
      detail: body.slice(0, 200),
    };
  } catch (error) {
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
      const timer = setTimeout(() => {
        child.kill();
        resolve("Unknown");
      }, 1500);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve("Unknown");
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(parseSystemctlState(stdout, stderr, code ?? 1));
      });
    });
}

function createSystemdControl(systemctlPath: string): SystemdServiceControl {
  return {
    start: (name) => runSystemctl(systemctlPath, "start", name, "start_failed"),
    stop: (name) => runSystemctl(systemctlPath, "stop", name, "stop_failed"),
  };
}

function runSystemctl(
  systemctlPath: string,
  action: "start" | "stop",
  service: string,
  failCode: "start_failed" | "stop_failed",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(systemctlPath, [action, service]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new LifecycleError(failCode, `systemctl ${action} ${service} timed out`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new LifecycleError(failCode, error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const detail = `${stdout}\n${stderr}`.trim();
      if (code === 0) {
        resolve();
        return;
      }
      if (/access denied|authentication is required|permission denied/i.test(detail)) {
        reject(new LifecycleError("access_denied", `systemctl ${action} ${service}: ${detail}`));
        return;
      }
      reject(
        new LifecycleError(
          failCode,
          `systemctl ${action} ${service} exited ${code}: ${detail}`,
        ),
      );
    });
  });
}
