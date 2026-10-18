import { z } from "zod";

export const MONITORING_VERSION = "larm-monitoring.v1" as const;
export const MONITORING_RETENTION_MS = 600_000;
export const monitoringIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/);
const time = z.string().datetime().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const monitoringIntervalSchema = z.object({ startAt: time, endAt: time, durationMs: z.number().positive().finite() }).strict();
export const monitoringAttemptSchema = z.object({
  at: time, status: z.enum(["ok", "unsupported", "permission_denied", "error", "unavailable"]),
  reasonCode: monitoringIdSchema.nullable(),
}).strict();
export type MonitoringAttempt = z.infer<typeof monitoringAttemptSchema>;
export type MonitoringInterval = z.infer<typeof monitoringIntervalSchema>;
export type MonitoringObservation<T> = {
  status: MonitoringAttempt["status"] | "stale";
  source: string; unit: string; kind: "gauge" | "counter";
  observedAt: string | null; interval: MonitoringInterval | null; counterEpoch: string | null;
  maxAgeMs: number; lastAttempt: MonitoringAttempt; value?: T;
};

export function monitoringObservationSchema<T extends z.ZodType>(value: T, unit: string, kind: "gauge" | "counter" = "gauge", intervalRequired = false) {
  return z.object({
    status: z.enum(["ok", "stale", "unsupported", "permission_denied", "error", "unavailable"]),
    source: monitoringIdSchema, unit: z.literal(unit), kind: z.literal(kind),
    observedAt: time.nullable(), interval: monitoringIntervalSchema.nullable(), counterEpoch: monitoringIdSchema.nullable(),
    maxAgeMs: z.number().int().positive(), lastAttempt: monitoringAttemptSchema, value: value.optional(),
  }).strict().superRefine((v, ctx) => {
    const measured = v.status === "ok" || v.status === "stale";
    if (measured !== (v.value !== undefined) || measured !== (v.observedAt !== null)
      || (measured && intervalRequired && v.interval === null)
      || (measured && kind === "counter" && v.counterEpoch === null)
      || (kind === "gauge" && v.counterEpoch !== null)
      || (!measured && (v.interval !== null || v.counterEpoch !== null))) {
      ctx.addIssue({ code: "custom", message: "inconsistent measurement availability" });
    }
  }).meta({ "x-larm-interval-required": intervalRequired });
}

export const monitoringValues = {
  count: monitoringObservationSchema(count, "count"),
  bytes: monitoringObservationSchema(count, "bytes"),
  milliseconds: monitoringObservationSchema(z.number().nonnegative().finite(), "milliseconds"),
  percent: monitoringObservationSchema(z.number().min(0).max(100), "percent"),
  cpuPercent: monitoringObservationSchema(z.number().min(0).max(100), "percent", "gauge", true),
  load: monitoringObservationSchema(z.number().nonnegative().finite(), "tasks"),
  boolean: monitoringObservationSchema(z.boolean(), "boolean"),
  counter: monitoringObservationSchema(decimal, "count", "counter"),
  pages: monitoringObservationSchema(decimal, "pages", "counter"),
  psiTotal: monitoringObservationSchema(decimal, "microseconds", "counter"),
  timestamp: monitoringObservationSchema(time, "timestamp"),
  runtimeStatus: monitoringObservationSchema(z.enum(["COLD", "STARTING", "HOT", "BUSY", "STOPPING", "FAILED"]), "state"),
  modelLoadState: monitoringObservationSchema(z.enum(["unloaded", "loading", "loaded", "failed"]), "state"),
  readiness: monitoringObservationSchema(z.enum(["starting", "verifying", "ready", "draining", "failed"]), "state"),
  identifiers: monitoringObservationSchema(z.array(monitoringIdSchema), "identifiers"),
  decodeRate: monitoringObservationSchema(z.number().nonnegative().finite(), "tokens_per_second"),
  temperature: monitoringObservationSchema(z.number().min(-273.15).finite(), "celsius"),
  frequency: monitoringObservationSchema(z.number().nonnegative().finite(), "hertz"),
};
const m = monitoringValues;
const psiScope = z.object({ avg10: m.percent, avg60: m.percent, avg300: m.percent, total: m.psiTotal }).strict();
export const monitoringPsiSchema = z.object({ some: psiScope, full: psiScope }).strict();
export const monitoringCpuSchema = z.object({ logicalCores: m.count, utilization: m.cpuPercent, load1: m.load, load5: m.load, load15: m.load, psi: monitoringPsiSchema }).strict();
export const monitoringMemorySchema = z.object({
  memTotal: m.bytes, memAvailable: m.bytes, swapTotal: m.bytes, swapUsed: m.bytes,
  swapIn: m.pages, swapOut: m.pages, pageSize: m.bytes, psi: monitoringPsiSchema, oomKills: m.counter,
  aggregationPolicy: z.literal("do_not_add_host_vram_gtt"),
}).strict();
export const monitoringRuntimeSchema = z.object({
  runtimeId: monitoringIdSchema, nodeId: monitoringIdSchema, backend: z.enum(["systemd", "llama-swap"]),
  declaredModelIds: z.array(monitoringIdSchema), status: m.runtimeStatus, healthOk: m.boolean, modelLoadState: m.modelLoadState,
  gpuIds: m.identifiers, inFlightRequests: m.count, preparingRequests: m.count, forwardedRequests: m.count,
  gateOccupiedSlots: m.count, queuedRequests: m.count, oldestQueueWaitMs: m.milliseconds,
  lastDecodeTokensPerSecond: m.decodeRate, lastFirstResponseMs: m.milliseconds,
}).strict();
const instance = z.object({
  instanceId: monitoringIdSchema, runtimeId: monitoringIdSchema, nodeId: monitoringIdSchema,
  generation: z.number().int().positive(), revision: z.string().regex(/^[a-f0-9]{64}$/), createdAt: time,
  reportedStatus: z.enum(["COLD", "STARTING", "HOT", "BUSY", "STOPPING", "FAILED"]),
  allocationRefs: count, requestRefs: count, mutationRefs: count, warmRefs: count, idleDeadline: time.nullable(),
}).strict();
export const monitoringGpuSchema = z.object({
  id: monitoringIdSchema, nodeId: monitoringIdSchema,
  identity: monitoringObservationSchema(z.object({ busId: z.string().min(1).max(192), vendorId: z.string().min(1).max(192), deviceId: z.string().min(1).max(192), driver: z.string().min(1).max(192) }).strict(), "identity"),
  utilization: m.percent, temperatures: z.array(z.object({ id: monitoringIdSchema, value: m.temperature }).strict()),
  clocks: z.array(z.object({ id: monitoringIdSchema, value: m.frequency }).strict()), thermalThrottled: m.boolean,
  vramUsed: m.bytes, vramLimit: m.bytes, gttUsed: m.bytes, gttLimit: m.bytes,
  memoryRelationship: z.enum(["shared_or_unknown", "dedicated_verified"]),
  attributedActiveRequests: m.count, attributedQueuedRequests: m.count, oldestAttributedQueueWaitMs: m.milliseconds,
  lastDecodeTokensPerSecond: m.decodeRate, lastFirstResponseMs: m.milliseconds,
}).strict();
export const monitoringGpusSchema = monitoringObservationSchema(z.array(monitoringGpuSchema), "devices");
export const monitoringStorageSchema = z.object({ id: monitoringIdSchema, nodeId: monitoringIdSchema, artifactIds: z.array(monitoringIdSchema), total: m.bytes, availableToDaemon: m.bytes }).strict();
export const monitoringStoragesSchema = monitoringObservationSchema(z.array(monitoringStorageSchema), "filesystems");
export const monitoringCoverageSchema = z.object({
  id: z.enum(["larm_gateway", "music_jobs", "image_jobs", "control_operations", "kernel_events", "provider_internal_queue", "direct_provider_requests"]),
  status: z.enum(["available", "unsupported", "permission_denied", "error", "unavailable", "stale"]),
  since: time.nullable(), through: time.nullable(), reasonCode: monitoringIdSchema.nullable(),
}).strict();
export const monitoringStreamSchema = z.object({
  streamId: monitoringIdSchema, retentionTargetMs: z.literal(600_000), availableSince: time,
  previousBootHistory: z.literal(false), continuity: z.enum(["complete_since_start", "gap"]),
  droppedEventsTotal: decimal, capacityEvents: z.literal(100_000), capacityBytes: z.literal(67_108_864),
}).strict();
export const monitoringSnapshotSchema = z.object({
  contractVersion: z.literal(MONITORING_VERSION), generatedAt: time, snapshotId: monitoringIdSchema, bootEpoch: monitoringIdSchema,
  core: z.object({ startedAt: m.timestamp, uptimeMs: m.milliseconds, readiness: m.readiness, draining: m.boolean,
    activeWorkloads: m.count, runtimes: z.array(monitoringRuntimeSchema), providerInstances: monitoringObservationSchema(z.array(instance), "instances") }).strict(),
  nodes: z.array(z.object({ nodeId: monitoringIdSchema, hostBootId: monitoringIdSchema, scope: z.literal("local_host"), cpu: monitoringCpuSchema, memory: monitoringMemorySchema, gpus: monitoringGpusSchema }).strict()),
  modelStorage: monitoringStoragesSchema, coverage: z.array(monitoringCoverageSchema), eventStream: monitoringStreamSchema,
}).strict();
export const monitoringEventSchema = z.object({
  id: monitoringIdSchema, sequence: decimal, streamId: monitoringIdSchema, occurredAt: time, recordedAt: time,
  kind: z.enum(["daemon.started", "daemon.readiness_changed", "runtime.state_changed", "model.load_started", "model.load_completed", "model.load_failed",
    "request.started", "request.queued", "request.forwarded", "request.terminal", "request.rejected", "control.terminal", "host.oom_counter_changed", "host.oom_kill_observed",
    "gpu.reset_observed", "gpu.ring_timeout_observed", "gpu.page_fault_observed", "gpu.execution_fault_observed"]),
  target: z.object({ type: z.enum(["daemon", "runtime", "provider_instance", "node", "gpu"]), id: monitoringIdSchema, nodeId: monitoringIdSchema.nullable() }).strict(),
  workId: monitoringIdSchema.nullable(), reasonCode: monitoringIdSchema,
  outcome: z.enum(["succeeded", "failed", "cancelled", "timed_out", "rejected", "observed"]).nullable(),
  fromState: monitoringIdSchema.nullable(), toState: monitoringIdSchema.nullable(), countDelta: decimal.nullable(),
  observationInterval: monitoringIntervalSchema.nullable(), source: monitoringIdSchema, sourceEventId: monitoringIdSchema.nullable(),
}).strict();
export const monitoringEventsSchema = z.object({
  contractVersion: z.literal(MONITORING_VERSION), generatedAt: time, bootEpoch: monitoringIdSchema, eventStream: monitoringStreamSchema,
  window: z.object({ from: time, through: time, highWaterSequence: decimal }).strict(), events: z.array(monitoringEventSchema),
  nextCursor: z.string().min(1).max(1024), hasMore: z.boolean(), coverage: z.array(monitoringCoverageSchema),
}).strict();
export const monitoringErrorSchema = z.object({ error: z.object({
  code: z.enum(["invalid_request", "unauthorized", "forbidden", "monitoring_auth_not_configured", "unsupported_monitoring_contract", "monitoring_epoch_changed", "monitoring_cursor_expired", "monitoring_unavailable", "rate_limited"]),
  message: z.string().min(1).max(128), bootEpoch: monitoringIdSchema, reasonCode: monitoringIdSchema.nullable(),
  supportedContractVersions: z.array(z.literal(MONITORING_VERSION)), recovery: z.enum(["retry", "restart_window", "fix_request", "fix_auth"]).nullable(),
}).strict() }).strict();
export type MonitoringSnapshot = z.infer<typeof monitoringSnapshotSchema>;
export type MonitoringRuntime = z.infer<typeof monitoringRuntimeSchema>;
export type MonitoringGpu = z.infer<typeof monitoringGpuSchema>;
export type MonitoringEvent = z.infer<typeof monitoringEventSchema>;
export type MonitoringCoverage = z.infer<typeof monitoringCoverageSchema>;
export type MonitoringEvents = z.infer<typeof monitoringEventsSchema>;

/** Zod refinements are also expressed in the published JSON Schema. */
export function monitoringJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const child of Object.values(node)) visit(child);
    const o = node as Record<string, unknown>, props = o.properties as Record<string, { const?: unknown }> | undefined;
    if (!props?.status || !props.lastAttempt || !props.unit || !props.value) return;
    const measured: Record<string, unknown> = { required: ["value"], properties: {
      observedAt: { type: "string", format: "date-time", pattern: "^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$" },
      counterEpoch: props.kind?.const === "counter" ? { type: "string", minLength: 1 } : { type: "null" },
      ...(o["x-larm-interval-required"] ? { interval: { type: "object" } } : {}),
    } };
    o.allOf = [{ if: { properties: { status: { enum: ["ok", "stale"] } }, required: ["status"] }, then: measured,
      else: { not: { required: ["value"] }, properties: { observedAt: { type: "null" }, interval: { type: "null" }, counterEpoch: { type: "null" } } } }];
  };
  visit(result); return result;
}
export function monitoringContractJsonSchema() {
  const result = { $schema: "https://json-schema.org/draft/2020-12/schema", title: "LARM monitoring v1 response contract",
    description: "Canonical source: packages/core/src/monitoring.ts; snapshots, events and errors.",
    oneOf: [{ $ref: "#/$defs/snapshot" }, { $ref: "#/$defs/events" }, { $ref: "#/$defs/error" }],
    $defs: { snapshot: monitoringJsonSchema(monitoringSnapshotSchema), events: monitoringJsonSchema(monitoringEventsSchema), error: monitoringJsonSchema(monitoringErrorSchema) } as Record<string, unknown> };
  // Share repeated Observation envelopes in the standalone review artifact.
  const shared = new Map<string, { name: string; value: unknown }>();
  const compact = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(compact);
    if (!node || typeof node !== "object") return node;
    const o = node as Record<string, unknown>, props = o.properties as Record<string, unknown> | undefined;
    if (props?.status && props.lastAttempt && props.unit && props.value) {
      const key = JSON.stringify(o); let entry = shared.get(key);
      if (!entry) { entry = { name: `measurement${shared.size + 1}`, value: o }; shared.set(key, entry); }
      return { $ref: `#/$defs/${entry.name}` };
    }
    return Object.fromEntries(Object.entries(o).map(([key, value]) => [key, compact(value)]));
  };
  for (const name of ["snapshot", "events", "error"]) result.$defs[name] = compact(result.$defs[name]);
  // Envelopes whose values contain other envelopes are compacted too, without self references.
  for (const entry of shared.values()) {
    const o = entry.value as Record<string, unknown>;
    result.$defs[entry.name] = Object.fromEntries(Object.entries(o).map(([key, value]) => [key, compact(value)]));
  }
  return result;
}

export function monitoringError(bootEpoch: string, code: z.infer<typeof monitoringErrorSchema>["error"]["code"], reasonCode: string | null = null,
  recovery: z.infer<typeof monitoringErrorSchema>["error"]["recovery"] = "fix_request") {
  return { error: { code, message: code, bootEpoch, reasonCode, supportedContractVersions: [MONITORING_VERSION], recovery } };
}

const units: Record<keyof typeof monitoringValues, string> = {
  count: "count", bytes: "bytes", milliseconds: "milliseconds", percent: "percent", cpuPercent: "percent", load: "tasks",
  boolean: "boolean", counter: "count", pages: "pages", psiTotal: "microseconds", timestamp: "timestamp", runtimeStatus: "state",
  modelLoadState: "state", readiness: "state", identifiers: "identifiers", decodeRate: "tokens_per_second", temperature: "celsius", frequency: "hertz",
};
/** Trusted producers call this with extracted values only, never raw upstream objects. */
export function monitoringSample<T>(type: keyof typeof monitoringValues | "devices" | "instances" | "filesystems" | "identity", source: string, at: string, value?: T,
  options: { status?: MonitoringAttempt["status"]; reason?: string; maxAgeMs?: number; interval?: MonitoringInterval; counterEpoch?: string } = {}): MonitoringObservation<T> {
  const counter = type === "counter" || type === "pages" || type === "psiTotal";
  const status = options.status ?? (value === undefined ? "unavailable" : "ok");
  const measured = status === "ok";
  return { status, source, unit: units[type as keyof typeof units] ?? type, kind: counter ? "counter" : "gauge",
    observedAt: measured ? at : null, interval: measured ? options.interval ?? null : null,
    counterEpoch: counter && measured ? options.counterEpoch ?? null : null,
    maxAgeMs: options.maxAgeMs ?? 10_000, lastAttempt: { at, status, reasonCode: options.reason ?? null }, ...(measured ? { value } : {}) };
}

/** Clone and age a saved view; observing it never changes the producer's sample. */
export function ageMonitoringView<T>(view: T, now: number): T {
  const copy = structuredClone(view);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const o = value as Record<string, unknown>;
    if (o.status === "ok" && typeof o.observedAt === "string" && typeof o.maxAgeMs === "number") {
      const age = now - Date.parse(o.observedAt);
      if (age > o.maxAgeMs || age < 0) o.status = "stale";
    }
    for (const child of Object.values(o)) visit(child);
  };
  visit(copy);
  return copy;
}
