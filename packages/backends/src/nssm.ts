import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { NssmRuntimeDefinition, RuntimeDefinition, ServiceState } from "@larm/core";
import { isNssmRuntime } from "@larm/core";
import { LifecycleError, type RuntimeBackend, type RuntimeHealth } from "./types";

const HEALTH_OK = /"status"\s*:\s*"ok"/;

export type ServiceControl = {
  start: (name: string) => Promise<void>;
  stop: (name: string) => Promise<void>;
};

export type NssmBackendOptions = {
  probeTimeoutMs?: number;
  readyTimeoutMs?: number;
  queryService?: (service: string) => Promise<ServiceState>;
  control?: ServiceControl;
  nssmPath?: string;
  sleep?: (ms: number) => Promise<void>;
};

export class NssmBackend implements RuntimeBackend {
  private readonly runtimes: Map<string, NssmRuntimeDefinition>;
  private readonly probeTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly queryService: (service: string) => Promise<ServiceState>;
  private readonly control: ServiceControl;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(runtimes: RuntimeDefinition[], options: NssmBackendOptions = {}) {
    this.runtimes = new Map(
      runtimes.filter(isNssmRuntime).map((runtime) => [runtime.id, runtime]),
    );
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1500;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 300_000;
    this.queryService = options.queryService ?? queryWindowsService;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.control =
      options.control ?? createNssmControl(options.nssmPath ?? defaultNssmPath());
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

    const port = runtime.deployment.healthPort;
    const service = await this.queryService(runtime.deployment.service);
    const listening = await isListening(port, this.probeTimeoutMs);

    if (!listening) {
      return {
        runtimeId,
        service,
        listening: false,
        healthOk: false,
        busy: false,
      };
    }

    const plain = await probeHealth(port, false, this.probeTimeoutMs);
    const slot = await probeHealth(port, true, this.probeTimeoutMs);

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
    if (!isNssmRuntime(runtime)) {
      throw new LifecycleError("start_failed", `${runtime.id} is not an nssm runtime`);
    }
    this.assertControllable(runtime, "ensure");
    this.runtimes.set(runtime.id, runtime);
    await this.control.start(runtime.deployment.service);
    await this.waitHealthy(runtime);
    if (runtime.deployment.proxyService) {
      await this.control.start(runtime.deployment.proxyService);
    }
    return this.health(runtime.id);
  }

  async stop(runtimeId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      throw new LifecycleError("stop_failed", `runtime ${runtimeId} is not registered`);
    }
    this.assertControllable(runtime, "stop");
    if (runtime.deployment.proxyService) {
      await this.control.stop(runtime.deployment.proxyService);
    }
    await this.control.stop(runtime.deployment.service);
  }

  private assertControllable(runtime: RuntimeDefinition, action: string): void {
    if (runtime.policy.class === "resident") {
      throw new LifecycleError(
        "resident_protected",
        `refusing to ${action} resident runtime ${runtime.id}`,
      );
    }
  }

  private async waitHealthy(runtime: NssmRuntimeDefinition): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      const probe = await probeHealth(
        runtime.deployment.healthPort,
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

function defaultNssmPath(): string {
  return process.env.LARM_NSSM ?? join(import.meta.dir, "../../../bin/nssm.exe");
}

function createNssmControl(nssmPath: string): ServiceControl {
  return {
    start: (name) => runNssm(nssmPath, ["start", name], "start_failed"),
    stop: (name) => runNssm(nssmPath, ["stop", name], "stop_failed"),
  };
}

function runNssm(
  nssmPath: string,
  args: string[],
  failCode: "start_failed" | "stop_failed",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(nssmPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new LifecycleError(failCode, `nssm ${args.join(" ")} timed out`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += decodeNssm(chunk as Buffer);
    });
    child.stderr.on("data", (chunk) => {
      stderr += decodeNssm(chunk as Buffer);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new LifecycleError(failCode, err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = `${stdout}\n${stderr}`;
      if (/access is denied/i.test(text) || /can't open service/i.test(text) || code === 5) {
        reject(new LifecycleError("access_denied", `nssm ${args.join(" ")}: access denied`));
        return;
      }
      if (code !== 0) {
        reject(
          new LifecycleError(failCode, `nssm ${args.join(" ")} exited ${code}: ${text.trim()}`),
        );
        return;
      }
      resolve();
    });
  });
}

function decodeNssm(chunk: Buffer): string {
  if (chunk.length >= 2 && chunk[1] === 0) {
    return chunk.toString("utf16le");
  }
  return chunk.toString("utf8");
}

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
  failOnNoSlot: boolean,
  timeoutMs: number,
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const url = failOnNoSlot
    ? `http://127.0.0.1:${port}/health?fail_on_no_slot=true`
    : `http://127.0.0.1:${port}/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    return {
      ok: response.ok && HEALTH_OK.test(body),
      status: response.status,
      detail: body.slice(0, 200),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail };
  }
}

export function parseScQuery(stdout: string, stderr: string, exitCode: number): ServiceState {
  const text = `${stdout}\n${stderr}`;
  if (exitCode === 1060 || /does not exist/i.test(text)) {
    return "NotFound";
  }
  if (/\bRUNNING\b/.test(stdout) || /\bSTART_PENDING\b/.test(stdout)) {
    return "Running";
  }
  if (/\bSTOPPED\b/.test(stdout) || /\bSTOP_PENDING\b/.test(stdout)) {
    return "Stopped";
  }
  if (exitCode !== 0) {
    return "Unknown";
  }
  return "Unknown";
}

function queryWindowsService(service: string): Promise<ServiceState> {
  if (process.platform !== "win32") {
    return Promise.resolve("Unknown");
  }
  return new Promise((resolve) => {
    const child = spawn("sc.exe", ["query", service], { windowsHide: true });
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
      resolve(parseScQuery(stdout, stderr, code ?? 1));
    });
  });
}
