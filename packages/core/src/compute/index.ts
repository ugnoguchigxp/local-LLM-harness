import { z } from "zod";

export const COMPUTE_LIMITS = Object.freeze({
  defaultTimeoutSec: 60, maxTimeoutSec: 60, maxQueueWaitSec: 300,
  maxCodeBytes: 64 * 1024, maxInputBytes: 256 * 1024, maxRequestBytes: 2 * 1024 * 1024,
  maxOutputBytes: 2 * 1024 * 1024, maxValueBytes: 1024 * 1024,
  maxStdoutBytes: 256 * 1024, maxStderrBytes: 256 * 1024,
  maxArtifacts: 10, maxArtifactBytes: 5 * 1024 * 1024,
  memoryMiB: 2048, workspaceMiB: 128, cpus: 1, concurrency: 1,
  maxQueuedJobs: 8, retentionSec: 86400, idempotencyRetentionSec: 7 * 86400,
  maxStoreBytes: 256 * 1024 * 1024,
});
export const COMPUTE_RESULT_RESERVATION = 53 * 1024 * 1024;
export const computeIdSchema = z.string().uuid();
export const computeErrorCodeSchema = z.enum([
  "timeout", "memory_exceeded", "runtime_error", "syntax_error", "limit_exceeded",
  "output_exceeded", "unavailable", "cancelled", "queue_timeout",
]);
export const computeRequestSchema = z.object({
  code: z.string().min(1), inputs: z.record(z.string(), z.unknown()).default({}),
  timeoutSec: z.number().int().min(1).max(COMPUTE_LIMITS.maxTimeoutSec).default(60),
  accelerator: z.enum(["auto", "cpu"]).default("auto"),
}).strict();
export type ComputeRequest = z.infer<typeof computeRequestSchema>;
export type ComputeRequestInput = z.input<typeof computeRequestSchema>;
export const computeProgressSchema = z.object({ message: z.string().max(1024), ratio: z.number().min(0).max(1).optional() }).strict();
export type ComputeProgress = z.infer<typeof computeProgressSchema>;
export const computeArtifactSchema = z.object({
  id: computeIdSchema, name: z.string().min(1).max(128),
  mime: z.enum(["image/png", "image/svg+xml", "text/csv", "application/json"]),
  bytes: z.number().int().nonnegative().max(COMPUTE_LIMITS.maxArtifactBytes),
}).strict();
export type ComputeArtifact = z.infer<typeof computeArtifactSchema>;
export const computeResultSchema = z.object({
  value: z.unknown(), stdout: z.string(), stderr: z.string(),
  stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(),
  artifacts: z.array(computeArtifactSchema).max(COMPUTE_LIMITS.maxArtifacts),
}).strict();
export const computeJobSchema = z.object({
  jobId: computeIdSchema,
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  stage: z.enum(["queued", "starting", "running", "collecting", "completed", "failed", "cancelled"]),
  queuedAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(), expiresAt: z.string().nullable(),
  resolvedAccelerator: z.literal("cpu"), environmentRevision: z.string(), cancelRequested: z.boolean(),
  progress: computeProgressSchema.optional(), result: computeResultSchema.optional(),
  error: z.object({ code: computeErrorCodeSchema, message: z.string() }).strict().optional(),
}).strict();
export type ComputeJob = z.infer<typeof computeJobSchema>;
export const computeReceiptSchema = z.object({ jobId: computeIdSchema }).strict();
export const computeEnvironmentSchema = z.object({
  protocol: z.literal("larm.compute.v1"), python: z.string(),
  packages: z.array(z.object({ name: z.string(), version: z.string() }).strict()),
  accelerators: z.array(z.object({ kind: z.literal("cpu"), name: z.string(), memoryMiB: z.number() }).strict()),
  limits: z.object(Object.fromEntries(Object.keys(COMPUTE_LIMITS).map(key => [key, z.number().nonnegative()]))),
  environmentRevision: z.string(),
  sandbox: z.object({ kind: z.literal("bubblewrap"), network: z.literal(false), gpu: z.literal(false),
    subprocesses: z.literal(false), userThreads: z.literal(false), memoryAccounting: z.literal("address_space") }).strict(),
}).strict();
export type ComputeEnvironment = z.infer<typeof computeEnvironmentSchema>;

export class ComputeError extends Error {
  constructor(readonly code: string, message = code, readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503 = 400,
    readonly executionUncertain = false) {
    super(message); this.name = "ComputeError";
  }
}

/** Bounded canonical JSON: no recursive schema walk over attacker-controlled depth. */
export function computeCanonicalJson(value: unknown): string {
  let nodes = 0;
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 20_000 || depth > 24) throw new ComputeError("limit_exceeded", "JSON structure exceeds limits");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    if (typeof item === "object" && item && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as Record<string, unknown>)[key], depth + 1)]));
    }
    throw new ComputeError("invalid_request", "Only finite JSON values are accepted");
  }
  return JSON.stringify(visit(value, 0));
}
export function parseComputeRequest(body: unknown): ComputeRequest {
  const parsed = computeRequestSchema.safeParse(body);
  if (!parsed.success) {
    if (body && typeof body === "object" && "accelerator" in body && body.accelerator === "gpu") {
      throw new ComputeError("unavailable", "This service supports CPU only", 503);
    }
    throw new ComputeError("invalid_request", "Invalid compute request; timeoutSec must be 1–60 and accelerator auto or cpu");
  }
  if (new TextEncoder().encode(parsed.data.code).length > COMPUTE_LIMITS.maxCodeBytes
    || new TextEncoder().encode(computeCanonicalJson(parsed.data.inputs)).length > COMPUTE_LIMITS.maxInputBytes) {
    throw new ComputeError("limit_exceeded", "Code or inputs exceed byte limits");
  }
  return parsed.data;
}

export type ComputeExecution = Omit<z.infer<typeof computeResultSchema>, "artifacts"> & {
  artifacts: Array<{ name: string; mime: ComputeArtifact["mime"]; data: Uint8Array }>;
};
export interface ComputeExecutor {
  environment(signal?: AbortSignal): Promise<ComputeEnvironment>;
  execute(request: ComputeRequest, context: { signal: AbortSignal; progress: (value: ComputeProgress) => void; stage?: (value: "running" | "collecting") => void }): Promise<ComputeExecution>;
}
export const computeServiceSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), capability: z.literal("compute.python.execute"), protocol: z.literal("larm.compute.v1"),
  endpoint: z.literal("/v1/compute"), url: z.string().url(), description: z.string(),
}).strict();
export function computeService(origin: string) {
  return computeServiceSchema.parse({ name: "compute", capability: "compute.python.execute", protocol: "larm.compute.v1",
    endpoint: "/v1/compute", url: new URL("/v1/compute", origin).toString(),
    description: "CPU Python: numpy/scipy/sympy/pandas/matplotlib/scikit-learn/statsmodels; 1 job, 60s, 2GiB address space. No network, GPU, subprocesses or user threads. Results retained 24h. See environment for limits." });
}
