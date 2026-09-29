import { z } from "zod";
import {
  allocationBindingObjectSchema,
  allocationStatusSchema,
} from "./allocation";
import {
  allocationRequirementSchema,
  allocationCapacityPolicySchema,
  allocationPrioritySchema,
  deploymentPolicySchema,
} from "./api-schema";
import { providerInstanceSchema } from "./provider-lifecycle";
import {
  runtimeClassSchema,
  runtimeDefinitionSchema,
  runtimeProtocolSchema,
  runtimeStatusSchema,
} from "./schema";

const identifierSchema = z.string().min(1).max(192);

export const errorDetailSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1),
  type: z.string().min(1).max(128).optional(),
  param: z.string().min(1).max(128).nullable().optional(),
  blockers: z.array(z.string().min(1)).optional(),
  admission: z.array(z.object({
    node: z.string().min(1),
    usableMemoryGB: z.number(),
    committedMemoryGB: z.number(),
    incrementalMemoryGB: z.number(),
    availableMemoryGB: z.number(),
    liveAvailableMemoryGB: z.number().optional(),
    reclaimableMemoryGB: z.number().optional(),
  }).strict()).optional(),
}).strict();

export const publicRuntimeSchema = z.object({
  id: z.string().min(1).max(128),
  capability: z.array(z.string().min(1).max(128)).min(1).max(64),
  protocol: runtimeProtocolSchema,
  policy: z.object({ class: runtimeClassSchema }).strict(),
}).strict();

export const runtimeListSchema = z.object({
  runtimes: z.array(publicRuntimeSchema),
}).strict();

export const publicRuntimeSnapshotSchema = z.object({
  id: z.string().min(1).max(128),
  status: runtimeStatusSchema,
  class: runtimeClassSchema,
  capability: z.array(z.string().min(1).max(128)).min(1).max(64),
  observedAt: z.string().datetime(),
  health: z.object({ ok: z.boolean() }).strict().optional(),
}).strict();

export const publicClusterStateSchema = z.object({
  generatedAt: z.string().datetime(),
  online: z.boolean(),
  runtimes: z.array(publicRuntimeSnapshotSchema),
}).strict();

export const inspectionRuntimeListSchema = z.object({
  runtimes: z.array(runtimeDefinitionSchema),
}).strict();

export const inspectionProviderInstanceListSchema = z.object({
  instances: z.array(z.object({
    instance: providerInstanceSchema,
    refs: z.object({
      allocation: z.number().int().nonnegative(),
      request: z.number().int().nonnegative(),
      mutation: z.number().int().nonnegative(),
    }).strict(),
    warmRefs: z.number().int().nonnegative(),
    idleDeadline: z.string().datetime().optional(),
  }).strict()),
}).strict();

export const errorResponseSchema = z.object({
  error: errorDetailSchema,
}).strict();

export const daemonHealthSchema = z.object({
  status: z.literal("ok"),
  ready: z.literal(true).optional(),
  readiness: z.object({
    state: z.literal("ready"),
    ready: z.literal(true),
    changedAt: z.string().datetime(),
    reason: z.string().min(1).max(256),
    listener: z.string().url().optional(),
  }).strict().optional(),
  version: z.string().min(1),
  releaseCommit: z.union([z.string().regex(/^[a-f0-9]{40}$/), z.literal("development")]),
  configRevision: z.string().min(1),
  bootEpoch: z.string().min(1),
}).strict();

export const readinessSchema = z.union([
  z.object({ status: z.literal("ready") }).strict(),
  z.object({ status: z.literal("draining") }).strict(),
  z.object({ status: z.enum(["starting", "verifying", "failed", "draining"]), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal("stale"), ageMs: z.number() }).strict(),
]);

export const publicAllocationBindingSchema = allocationBindingObjectSchema.omit({
  endpoint: true,
  providerRevision: true,
  instanceId: true,
  instanceGeneration: true,
});
export const publicAllocationSchema = z.object({
  id: z.string().min(1).max(192),
  bootEpoch: z.string().min(1).max(128),
  catalogRevision: z.string().min(1).max(128).optional(),
  client: z.string().min(1).max(128).optional(),
  status: allocationStatusSchema,
  requirements: z.array(allocationRequirementSchema).min(1).max(16),
  bindings: z.array(publicAllocationBindingSchema).min(1).max(16),
  allowFallback: z.boolean(),
  deploymentPolicy: deploymentPolicySchema,
  priority: allocationPrioritySchema.optional(),
  capacityPolicy: allocationCapacityPolicySchema.optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  operationId: z.string().min(1).max(192).optional(),
  releasedAt: z.string().datetime().optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().optional(),
}).strict();

export const allocationResolveResponseSchema = z.object({
  allocationId: identifierSchema,
  capability: z.string().min(1).max(128),
  route: z.string().min(1).max(128),
  runtime: z.string().min(1).max(128),
  node: z.string().min(1).max(128),
  endpoint: z.string().url(),
  status: z.enum(["HOT", "BUSY"]),
  expiresAt: z.string().datetime(),
}).strict();

export const legacyPrepareResponseSchema = z.object({
  leaseId: identifierSchema,
  operationId: identifierSchema.optional(),
  desired: z.array(z.string().min(1).max(128)),
  ready: z.boolean(),
  runtimes: z.array(z.string().min(1).max(128)),
}).strict();

export const legacyResolveResponseSchema = z.object({
  runtime: z.string().min(1).max(128),
  node: z.string().min(1).max(128),
  endpoint: z.string().url(),
  status: z.enum(["HOT", "BUSY"]),
}).strict();

export const legacyReleaseResponseSchema = z.object({
  released: z.literal(true),
  leaseId: identifierSchema,
  desired: z.array(z.string().min(1).max(128)),
}).strict();

export const controlOperationSchema = z.object({
  id: identifierSchema,
  kind: z.enum(["prepare", "allocation", "artifact"]),
  leaseId: identifierSchema.optional(),
  allocationId: identifierSchema.optional(),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "timed_out"]),
  ready: z.boolean(),
  desired: z.array(z.string()),
  ensure: z.array(z.string()),
  createdAt: z.string().datetime(),
  deadlineAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  phase: z.string().optional(),
  error: errorDetailSchema.optional(),
}).strict();

export const artifactOperationSchema = z.object({
  id: identifierSchema,
  kind: z.enum(["stage", "activate", "rollback"]),
  artifactId: z.string().min(1).max(128).optional(),
  runtimeId: z.string().min(1).max(128).optional(),
  releaseId: z.string().min(1).max(128).optional(),
  status: z.enum(["pending", "running", "succeeded", "failed", "interrupted"]),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  error: errorDetailSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type PublicAllocation = z.infer<typeof publicAllocationSchema>;
export type ControlOperation = z.infer<typeof controlOperationSchema>;
