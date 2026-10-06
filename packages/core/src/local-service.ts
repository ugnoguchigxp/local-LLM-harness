import { createHash } from "node:crypto";
import { z } from "zod";

export const localServiceIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const count = z.number().int().nonnegative();
const loopbackUrl = z.string().url().refine((v) => {
  const u = new URL(v);
  return u.protocol === "http:" && u.hostname === "127.0.0.1" && !u.username && !u.password && !u.search && !u.hash;
}, "private service endpoint must be loopback HTTP");
const publicUrl = z.string().url().refine((v) => {
  const u = new URL(v);
  return (u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "127.0.0.1"))
    && !u.username && !u.password && !u.search && !u.hash;
}, "public endpoint requires HTTPS or host-local HTTP");
export const localServiceDefinitionSchema = z.object({
  id: localServiceIdSchema,
  node: localServiceIdSchema,
  backend: z.literal("systemd-container-group"),
  deployment: z.object({
    unit: z.string().regex(/^larm-local-service-[a-z0-9-]+\.service$/),
    stopUnit: z.string().regex(/^larm-local-service-[a-z0-9-]+-stop\.service$/),
    release: localServiceIdSchema,
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    endpoint: loopbackUrl,
    publicEndpoint: publicUrl,
  }).strict(),
  readiness: z.object({ timeoutSeconds: z.number().int().min(1).max(600) }).strict(),
  activity: z.object({
    secretRef: localServiceIdSchema,
    pollSeconds: z.number().int().min(1).max(60),
    staleAfterSeconds: z.number().int().min(1).max(300),
  }).strict(),
  lifecycle: z.object({
    minInstances: z.literal(0), idleSeconds: z.number().int().min(0).max(86400),
    leaseSeconds: z.number().int().min(10).max(3600),
    gracefulStopSeconds: z.number().int().min(1).max(300),
    restartPolicy: z.literal("on-next-ensure"),
  }).strict(),
  resources: z.object({
    startupReservationBytes: z.number().int().positive().max(2 ** 50),
    cpuMaxCores: z.number().positive().max(256), maxInstances: z.literal(1), gpuAccess: z.literal(false),
  }).strict(),
}).strict();
export type LocalServiceDefinition = z.infer<typeof localServiceDefinitionSchema>;
export const localServicesFileSchema = z.object({
  schemaVersion: z.literal("larm.local-services.v1"),
  services: z.record(localServiceIdSchema, localServiceDefinitionSchema.omit({ id: true })).refine(v => Object.keys(v).length <= 64, "at most 64 local services are supported"),
}).strict();
export function parseLocalServices(input: unknown, nodes: readonly string[]): LocalServiceDefinition[] {
  const file = localServicesFileSchema.parse(input);
  const result = Object.entries(file.services).map(([id, d]) => localServiceDefinitionSchema.parse({ id, ...d }));
  const units = new Set<string>(), endpoints = new Set<string>();
  for (const d of result) {
    if (!nodes.includes(d.node)) throw new Error(`unknown local service node: ${d.node}`);
    if (d.deployment.unit === d.deployment.stopUnit || units.has(d.deployment.unit) || units.has(d.deployment.stopUnit) || endpoints.has(d.deployment.endpoint)) throw new Error("duplicate local service deployment");
    if (d.activity.staleAfterSeconds <= d.activity.pollSeconds) throw new Error("activity freshness must exceed poll interval");
    units.add(d.deployment.unit); units.add(d.deployment.stopUnit); endpoints.add(d.deployment.endpoint);
  }
  return result;
}
export function localServiceRevision(d: LocalServiceDefinition): string {
  // Parsed schema supplies canonical property order; definitions never come from request bodies.
  return createHash("sha256").update(JSON.stringify(localServiceDefinitionSchema.parse(d))).digest("hex");
}
export const localServiceActivitySchema = z.object({
  contractVersion: z.literal("larm.local-service-activity.v1"),
  bootId: localServiceIdSchema, sequence: count, observedAt: z.string().datetime(),
  queuedJobs: count, runningJobs: count, activeRequests: count, processorActiveJobs: count,
  draining: z.boolean(), drainToken: z.string().min(1).max(128).nullable(),
}).strict().refine(v => v.draining === (v.drainToken !== null), "drain token must match draining state");
export type LocalServiceActivity = z.infer<typeof localServiceActivitySchema>;
export function localServiceIdle(a: LocalServiceActivity): boolean {
  return a.queuedJobs === 0 && a.runningJobs === 0 && a.activeRequests === 0 && a.processorActiveJobs === 0;
}
export const localServiceLeaseRequestSchema = z.object({
  ttlSeconds: z.number().int().min(10).max(3600).optional(),
  catalogRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const localServiceRenewSchema = z.object({
  ttlSeconds: z.number().int().min(10).max(3600).optional(),
  generation: z.number().int().positive(), bootEpoch: z.string().min(1).max(128),
}).strict();
export const localServiceLeaseSchema = z.object({
  id: localServiceIdSchema, serviceId: localServiceIdSchema, revision: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.number().int().positive(), bootEpoch: z.string().min(1).max(128), expiresAt: z.string().datetime(),
  status: z.enum(["starting", "ready", "failed", "released", "expired"]),
  endpoint: publicUrl.optional(), error: z.string().max(128).optional(),
}).strict().refine(v => (v.status === "ready") === (v.endpoint !== undefined), "endpoint is available only for a ready lease");
export type LocalServiceLease = z.infer<typeof localServiceLeaseSchema>;
export type ServiceMemoryReservation = { node: string; bytes: number; pendingBytes: number };

export const localServiceStatusSchema = z.object({
  id: localServiceIdSchema, revision: z.string(), generation: z.number().int().nonnegative(),
  state: z.enum(["stopped", "starting", "ready", "draining", "stopping", "failed"]),
  busy: z.boolean().nullable(), activityFresh: z.boolean(), error: z.string().optional(),
}).strict();
export const localServiceListSchema = z.object({ services: z.array(localServiceStatusSchema) }).strict();

/** Host operations and persistence are injected into the portable lifecycle. */
export interface LocalServiceBackend {
  start(d: LocalServiceDefinition): Promise<void>;
  stop(d: LocalServiceDefinition): Promise<void>;
  observe(d: LocalServiceDefinition): Promise<{
    serviceId: string; release: string; manifestDigest: string; observedAt: string;
    state: "stopped" | "running" | "failed" | "unknown";
    containerIds: string[]; memoryUsageBytes: number; error?: string;
  }>;
  ready(d: LocalServiceDefinition): Promise<boolean>;
  activity(d: LocalServiceDefinition): Promise<LocalServiceActivity>;
  drain(d: LocalServiceDefinition): Promise<LocalServiceActivity>;
  resume(d: LocalServiceDefinition, token: string): Promise<void>;
}
export interface LocalServiceJournal {
  load(): Promise<unknown | undefined>;
  save(value: unknown): Promise<void>;
}
