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
export const containerServiceDefinitionSchema = z.object({
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
const processUnit = z.string().regex(/^larm-local-service-[a-z0-9-]+\.(service|target)$/);
const memberUnit = z.string().regex(/^larm-local-service-[a-z0-9-]+\.service$/);
const absolutePath = z.string().min(2).max(4096).refine(v => v.startsWith("/") && !v.split("/").some(p => p === ".." || p === ".") && !/[\s\x00]/.test(v), "canonical absolute path required");
export const processServiceDefinitionSchema = containerServiceDefinitionSchema.extend({
  backend: z.literal("systemd-process"),
  deployment: containerServiceDefinitionSchema.shape.deployment.extend({
    unit: processUnit,
    members: z.array(memberUnit).min(1).max(16).refine(v => new Set(v).size === v.length, "duplicate member"),
    observeUnit: memberUnit,
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/).refine(v => v !== "0".repeat(64), "prepared manifest required"),
  }).strict(),
  readiness: containerServiceDefinitionSchema.shape.readiness.extend({
    path: z.string().regex(/^\/[a-zA-Z0-9/_-]*$/),
    status: z.string().min(1).max(128),
    capabilities: z.record(z.string().min(1).max(128), z.boolean()),
  }).strict(),
  storage: z.object({
    dataRoot: absolutePath, mountPoint: absolutePath,
    filesystemUuid: z.string().regex(/^[a-f0-9-]{8,64}$/),
    minFreeBytes: z.number().int().positive().max(2 ** 50),
  }).strict(),
}).strict();
export const localServiceDefinitionSchema = z.discriminatedUnion("backend", [containerServiceDefinitionSchema, processServiceDefinitionSchema]);
export type LocalServiceDefinition = z.infer<typeof localServiceDefinitionSchema>;
export type ProcessServiceDefinition = z.infer<typeof processServiceDefinitionSchema>;
const serviceRecord = <T extends z.ZodType>(schema: T) => z.record(localServiceIdSchema, schema).refine(v => Object.keys(v).length <= 64, "at most 64 local services are supported");
export const localServicesFileSchema = z.discriminatedUnion("schemaVersion", [
  z.object({ schemaVersion: z.literal("larm.local-services.v1"), services: serviceRecord(containerServiceDefinitionSchema.omit({ id: true })) }).strict(),
  z.object({ schemaVersion: z.literal("larm.local-services.v2"), services: serviceRecord(z.discriminatedUnion("backend", [containerServiceDefinitionSchema.omit({ id: true }), processServiceDefinitionSchema.omit({ id: true })])) }).strict(),
]);
export function parseLocalServices(input: unknown, nodes: readonly string[]): LocalServiceDefinition[] {
  const file = localServicesFileSchema.parse(input);
  const result = Object.entries(file.services).map(([id, d]) => localServiceDefinitionSchema.parse({ id, ...d }));
  const units = new Set<string>(), ports = new Set<string>();
  for (const d of result) {
    if (!nodes.includes(d.node)) throw new Error(`unknown local service node: ${d.node}`);
    const ownedUnits = d.backend === "systemd-process" ? [d.deployment.unit, d.deployment.stopUnit, d.deployment.observeUnit, ...d.deployment.members.filter(u => u !== d.deployment.unit)] : [d.deployment.unit, d.deployment.stopUnit];
    const endpoint = new URL(d.deployment.endpoint);
    const port = endpoint.port || "80";
    if (new Set(ownedUnits).size !== ownedUnits.length || ownedUnits.some(u => units.has(u)) || ports.has(port)) throw new Error("duplicate local service deployment");
    if (d.activity.staleAfterSeconds <= d.activity.pollSeconds) throw new Error("activity freshness must exceed poll interval");
    if (d.backend === "systemd-process" && !d.storage.dataRoot.startsWith(`${d.storage.mountPoint}/`)) throw new Error("data root must be inside required mount");
    for (const unit of ownedUnits) units.add(unit);
    ports.add(port);
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
  stop(d: LocalServiceDefinition, expected?: LocalServiceStopExpectation): Promise<void>;
  observe(d: LocalServiceDefinition): Promise<{
    serviceId: string; release: string; manifestDigest: string; observedAt: string;
    state: "stopped" | "running" | "failed" | "unknown";
    /** Legacy adapter input only; process backends must supply instanceToken and stopConfirmed. */
    containerIds?: string[]; instanceToken?: string | null; stopConfirmed?: boolean;
    memoryUsageBytes: number; memory?: { anon: number; file: number; shmem: number; total: number }; error?: string;
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

export type LocalServiceStopExpectation = { instanceToken: string; appBootId: string; drainToken: string };
/** v1 journal migration only. Container identities become an opaque backend token. */
export function legacyServiceInstanceToken(ids: readonly string[]): string | null {
  return ids.length ? createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex") : null;
}
export function serviceInstanceToken(d: LocalServiceDefinition, observation: Awaited<ReturnType<LocalServiceBackend["observe"]>>): string | null {
  if (d.backend === "systemd-process") {
    if (observation.instanceToken === undefined || observation.stopConfirmed === undefined) throw new Error("process_observation_incomplete");
    return observation.instanceToken;
  }
  return observation.instanceToken ?? legacyServiceInstanceToken(observation.containerIds ?? []);
}
