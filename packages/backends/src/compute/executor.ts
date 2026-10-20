import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ComputeJsonLines } from "./protocol";
import { assertComputeStorageIsolation } from "./paths";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  COMPUTE_LIMITS, ComputeError, computeCanonicalJson, computeEnvironmentSchema, computeErrorCodeSchema,
  computeProgressSchema, type ComputeEnvironment, type ComputeExecution, type ComputeExecutor, type ComputeRequest,
} from "@larm/core";

const artifactFrame = z.object({ kind: z.literal("artifact"), name: z.string().min(1).max(128),
  mime: z.enum(["image/png", "image/svg+xml", "text/csv", "application/json"]), data: z.string().max(7 * 1024 * 1024) }).strict();
const resultFrame = z.object({ kind: z.literal("result"), value: z.unknown(), stdout: z.string(), stderr: z.string(),
  stdoutTruncated: z.boolean(), stderrTruncated: z.boolean() }).strict();

/** No host Python fallback: all submitted code passes through bwrap and seccomp. */
export class LinuxCpuComputeExecutor implements ComputeExecutor {
  constructor(private readonly options: { runtimeRoot: string; runner: string; requirements: string; bwrap?: string; stateRoot?: string;
    launch?: (command: string, args: string[]) => ChildProcessWithoutNullStreams }) {
    if (![options.runtimeRoot, options.runner, options.requirements].every(isAbsolute)) throw new Error("compute paths must be absolute");
    if (options.stateRoot !== undefined) assertComputeStorageIsolation(options.stateRoot, options.runtimeRoot);
  }

  private argv(environment: boolean): string[] {
    const { runtimeRoot, runner } = this.options;
    const python = join(runtimeRoot, "bin/python3");
    if (!existsSync(python) || !existsSync(join(runtimeRoot, "pyvenv.cfg"))) throw new ComputeError("unavailable", "CPU Python environment is not installed", 503);
    const args = ["--unshare-all", "--unshare-user", "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64", "--dir", "/etc", "--dir", "/proc", "--dev", "/dev",
      "--size", String(16 * 1024 * 1024), "--tmpfs", "/dev/shm",
      "--size", String(COMPUTE_LIMITS.workspaceMiB * 1024 * 1024), "--tmpfs", "/work",
      "--symlink", "/work/tmp", "/tmp", "--ro-bind", runtimeRoot, runtimeRoot,
      "--ro-bind", runner, "/opt/larm/runner.py", "--chdir", "/work"];
    for (const path of ["/etc/ld.so.cache", "/etc/fonts"]) if (existsSync(path)) args.push("--ro-bind", path, path);
    const env = { PATH: `${runtimeRoot}/bin:/usr/bin`, HOME: "/work", TMPDIR: "/work/tmp", MPLCONFIGDIR: "/work/matplotlib",
      MPLBACKEND: "Agg", PYTHONDONTWRITEBYTECODE: "1", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1",
      MKL_NUM_THREADS: "1", NUMEXPR_NUM_THREADS: "1", VECLIB_MAXIMUM_THREADS: "1", PYTHONHASHSEED: "0", LANG: "C.UTF-8" };
    for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value);
    args.push("--remount-ro", "/dev", "--remount-ro", "/", "--", python, "-I", "-B", "/opt/larm/runner.py");
    if (environment) args.push("--environment");
    return args;
  }

  private async run(environment: boolean, request: ComputeRequest | undefined, signal: AbortSignal,
    frame: (data: unknown) => void): Promise<void> {
    signal.throwIfAborted();
    const args = this.argv(environment);
    await new Promise<void>((resolve, reject) => {
      const launch = this.options.launch ?? ((command, argv) => spawn(command, argv, {
        env: { PATH: "/usr/bin:/bin" }, detached: true, stdio: ["pipe", "pipe", "pipe"],
      }));
      const child = launch(this.options.bwrap ?? "/usr/bin/bwrap", args);
      const decoder = new ComputeJsonLines();
      let failure: unknown, exited = false, processExited = false, settled = false, executionStarted = false;
      let stopping: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); if (stopping) clearTimeout(stopping);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const kill = () => {
        if (exited || settled) return;
        if (child.pid && !processExited) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Close may already be pending. */ }
        stopping ??= setTimeout(() => {
          child.unref(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          settle(new ComputeError("unavailable", "Calculation termination could not be confirmed", 503, true));
        }, 2000);
      };
      const abort = () => { failure ??= signal.reason instanceof ComputeError ? signal.reason : new ComputeError("cancelled", "Calculation cancelled"); kill(); };
      const timer = setTimeout(() => { failure ??= new ComputeError("timeout", "Calculation exceeded its wall time limit"); kill(); }, (request?.timeoutSec ?? 10) * 1000);
      signal.addEventListener("abort", abort, { once: true });
      child.stderr.on("data", () => { /* Drain bootstrap diagnostics without logging code or paths. */ });
      const ioFailure = () => { if (!settled && !exited) { failure ??= new ComputeError("unavailable", "CPU sandbox communication failed", 503); kill(); } };
      child.stdout.on("error", ioFailure); child.stderr.on("error", ioFailure);
      child.stdin.on("error", () => { /* Exit status is the authority. */ });
      child.stdout.on("data", (part: Buffer) => {
        if (failure || settled) return;
        try {
          decoder.push(part, value => {
            if (failure || settled) return;
            frame(value);
            if (value && typeof value === "object" && "kind" in value && value.kind === "ready") executionStarted = true;
          });
        } catch (error) { failure = error instanceof ComputeError ? error : new ComputeError("output_exceeded", "Invalid calculation output"); kill(); }
      });
      child.on("error", () => { failure = new ComputeError("unavailable", "CPU sandbox could not start", 503); kill(); });
      child.once("exit", () => { processExited = true; });
      child.on("close", code => {
        exited = true;
        if (failure) settle(failure);
        else if (code !== 0) settle(executionStarted
          ? new ComputeError("runtime_error", "Calculation process exited unexpectedly")
          : new ComputeError("unavailable", "CPU sandbox exited unexpectedly", 503));
        else { try { decoder.end(); settle(); } catch (error) { settle(error); } }
      });
      if (signal.aborted) abort();
      child.stdin.end(request ? JSON.stringify(request) : undefined);
    });
  }

  async environment(signal = new AbortController().signal): Promise<ComputeEnvironment> {
    let metadata: { python: string; packages: Array<{ name: string; version: string }> } | undefined;
    await this.run(true, undefined, signal, raw => {
      const parsed = z.object({ kind: z.literal("environment"), python: z.string(),
        packages: z.array(z.object({ name: z.string(), version: z.string() }).strict()) }).strict().parse(raw);
      if (metadata) throw new ComputeError("unavailable");
      const { kind: _, ...value } = parsed; metadata = value;
    });
    if (!metadata) throw new ComputeError("unavailable", "CPU environment probe failed", 503);
    const revision = createHash("sha256").update(readFileSync(this.options.runner)).update(readFileSync(this.options.requirements))
      .update(JSON.stringify(metadata)).digest("hex");
    return computeEnvironmentSchema.parse({ protocol: "larm.compute.v1", ...metadata,
      accelerators: [{ kind: "cpu", name: "single-process CPU Python", memoryMiB: COMPUTE_LIMITS.memoryMiB }],
      limits: COMPUTE_LIMITS, environmentRevision: revision,
      sandbox: { kind: "bubblewrap", network: false, gpu: false, subprocesses: false, userThreads: false, memoryAccounting: "address_space" } });
  }

  async execute(request: ComputeRequest, context: Parameters<ComputeExecutor["execute"]>[1]): Promise<ComputeExecution> {
    const artifacts: ComputeExecution["artifacts"] = [];
    let result: Omit<ComputeExecution, "artifacts"> | undefined, reportedError: ComputeError | undefined;
    let lastProgress = 0, frames = 0, ready = false;
    await this.run(false, request, context.signal, raw => {
      if (++frames > 10_000 || !raw || typeof raw !== "object" || !("kind" in raw)) throw new ComputeError("output_exceeded");
      const data = raw as Record<string, unknown>;
      if (reportedError || result) throw new ComputeError("output_exceeded", "Output after terminal record");
      if (data.kind === "ready" && !ready) { ready = true; context.stage?.("running"); return; }
      if (data.kind === "error") {
        const parsed = z.object({ kind: z.literal("error"), code: computeErrorCodeSchema, message: z.string() }).strict().parse(data);
        reportedError = new ComputeError(parsed.code === "unavailable" && ready ? "runtime_error" : parsed.code,
          Buffer.from(parsed.message).subarray(-8192).toString("utf8")); return;
      }
      if (!ready) throw new ComputeError("unavailable", "Sandbox was not initialized", 503);
      if (data.kind === "progress") {
        const progress = computeProgressSchema.parse({ message: data.message, ...(data.ratio === undefined ? {} : { ratio: data.ratio }) });
        if (Buffer.byteLength(progress.message) > 1024) throw new ComputeError("output_exceeded");
        if (Date.now() - lastProgress >= 500) { lastProgress = Date.now(); context.progress(progress); } return;
      }
      if (data.kind === "collecting") { context.stage?.("collecting"); return; }
      if (data.kind === "artifact") {
        const parsed = artifactFrame.parse(data);
        if (artifacts.length >= COMPUTE_LIMITS.maxArtifacts || !/^[^/\\\x00-\x1f]+$/.test(parsed.name)) throw new ComputeError("limit_exceeded");
        const bytes = Buffer.from(parsed.data, "base64");
        if (bytes.toString("base64") !== parsed.data) throw new ComputeError("output_exceeded");
        if (bytes.length > COMPUTE_LIMITS.maxArtifactBytes) throw new ComputeError("limit_exceeded");
        if (parsed.mime === "image/png") {
          if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
            || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)
            || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_777_216) throw new ComputeError("limit_exceeded", "PNG artifact dimensions exceed limits");
        }
        if (parsed.mime !== "image/png") {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (parsed.mime === "application/json") computeCanonicalJson(JSON.parse(text));
        }
        artifacts.push({ name: parsed.name, mime: parsed.mime, data: bytes }); return;
      }
      const parsed = resultFrame.parse(data);
      if (Buffer.byteLength(parsed.stdout) > COMPUTE_LIMITS.maxStdoutBytes || Buffer.byteLength(parsed.stderr) > COMPUTE_LIMITS.maxStderrBytes
        || Buffer.byteLength(computeCanonicalJson(parsed.value)) > COMPUTE_LIMITS.maxValueBytes
        || Buffer.byteLength(JSON.stringify(parsed)) > COMPUTE_LIMITS.maxOutputBytes) throw new ComputeError("output_exceeded");
      const { kind: _, ...value } = parsed; result = value;
    });
    if (reportedError) throw reportedError;
    if (!result) throw new ComputeError("runtime_error", "Calculation ended without a result");
    return { ...result, artifacts };
  }
}
