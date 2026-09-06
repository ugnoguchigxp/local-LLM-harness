import { z } from "zod";

export const LARM_SERVICE_ACTIVITY_CONTRACT_VERSION = "larm-service-activity.v1" as const;
export const LARM_SERVICE_ACTIVITY_VALID_FOR_MS = 1_000 as const;

export const serviceActivityStateSchema = z.enum([
  "idle",
  "active",
  "draining",
]);

const activeWorkloadCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const serviceActivityBaseShape = {
  contractVersion: z.literal(LARM_SERVICE_ACTIVITY_CONTRACT_VERSION),
  observedAt: z.string().datetime(),
  validForMs: z.literal(LARM_SERVICE_ACTIVITY_VALID_FOR_MS),
  reservationGuaranteed: z.literal(false),
  bootEpoch: z.string().min(1).max(128),
  configRevision: z.string().min(1).max(128),
};

export const serviceActivitySchema = z.discriminatedUnion("state", [
  z.object({
    ...serviceActivityBaseShape,
    state: z.literal("idle"),
    activeWorkloads: z.literal(0),
    retryAfterMs: z.literal(0),
  }).strict(),
  z.object({
    ...serviceActivityBaseShape,
    state: z.literal("active"),
    activeWorkloads: activeWorkloadCountSchema.min(1),
    retryAfterMs: z.literal(LARM_SERVICE_ACTIVITY_VALID_FOR_MS),
  }).strict(),
  z.object({
    ...serviceActivityBaseShape,
    state: z.literal("draining"),
    activeWorkloads: activeWorkloadCountSchema,
    retryAfterMs: z.literal(LARM_SERVICE_ACTIVITY_VALID_FOR_MS),
  }).strict(),
]);

export type ServiceActivityState = z.infer<typeof serviceActivityStateSchema>;
export type ServiceActivity = z.infer<typeof serviceActivitySchema>;

export type ServiceActivityInput = {
  httpActiveWorkloads: number;
  draining: boolean;
  observedAt: string;
  bootEpoch: string;
  configRevision: string;
};

function workloadCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function deriveServiceActivityState(
  activeWorkloads: number,
  draining: boolean,
): ServiceActivityState {
  workloadCount(activeWorkloads, "activeWorkloads");
  if (draining) return "draining";
  return activeWorkloads === 0 ? "idle" : "active";
}

export function createServiceActivity(input: ServiceActivityInput): ServiceActivity {
  const httpActiveWorkloads = workloadCount(input.httpActiveWorkloads, "httpActiveWorkloads");
  const activeWorkloads = workloadCount(httpActiveWorkloads, "activeWorkloads");
  const state = deriveServiceActivityState(activeWorkloads, input.draining);
  return serviceActivitySchema.parse({
    contractVersion: LARM_SERVICE_ACTIVITY_CONTRACT_VERSION,
    state,
    activeWorkloads,
    observedAt: input.observedAt,
    validForMs: LARM_SERVICE_ACTIVITY_VALID_FOR_MS,
    retryAfterMs: state === "idle" ? 0 : LARM_SERVICE_ACTIVITY_VALID_FOR_MS,
    reservationGuaranteed: false,
    bootEpoch: input.bootEpoch,
    configRevision: input.configRevision,
  });
}
