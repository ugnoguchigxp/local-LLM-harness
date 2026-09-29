import { z } from "zod";
import { runtimeReleaseDefinitionSchema } from "./releases";
import { runtimeStatusSchema } from "./schema";

export const releaseConvergenceStatusSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().regex(/^[a-f0-9]{64}$/),
  desiredRelease: z.string().regex(/^[a-f0-9]{40}$/),
  observedRelease: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  stage: z.enum([
    "approved",
    "validated",
    "activated",
    "contract_verified",
    "canary_verified",
    "consumer_verified",
    "complete",
  ]),
  result: z.enum(["pending", "running", "succeeded", "failed"]),
  reason: z.string().min(1).max(256).nullable(),
  updatedAt: z.string().datetime(),
}).strict();

export const httpProviderSoakEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("http-provider-soak"),
  ok: z.boolean(),
  releaseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  configRevision: z.string().regex(/^[a-f0-9]{64}$/),
  bootEpoch: z.string().min(1).max(128),
  startedAt: z.string().datetime(),
  lastAttemptAt: z.string().datetime(),
  lastSuccessAt: z.string().datetime().nullable(),
  durationSeconds: z.number().int().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  maxGapSeconds: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.ok !== (value.sampleCount > 0 && value.failureCount === 0)) {
    context.addIssue({ code: "custom", message: "ok must reflect samples and failures" });
  }
  if ((value.sampleCount === 0) !== (value.lastSuccessAt === null)) {
    context.addIssue({ code: "custom", message: "lastSuccessAt must reflect sampleCount" });
  }
});

export const publicRuntimeReleaseSchema = runtimeReleaseDefinitionSchema.extend({
  state: z.enum(["active", "previous", "staged", "available"]),
}).strict();

export const runtimeReleaseListSchema = z.object({
  releases: z.array(publicRuntimeReleaseSchema),
}).strict();

export const runtimeReleaseSelectionSchema = z.object({
  release: z.string().min(1).max(128),
  expectedActiveRelease: z.string().min(1).max(128).nullable(),
}).strict();

export const runtimeReleasePlanRequestSchema = z.object({
  release: z.string().min(1).max(128),
}).strict();

export const runtimeDeploymentSchema = z.object({
  runtime: z.string().min(1).max(128),
  activeRelease: z.string().min(1).max(128).nullable(),
  previousRelease: z.string().min(1).max(128).nullable(),
  desiredRelease: z.string().min(1).max(128),
  activeProviderConfigRevision: z.string().min(1).max(128).nullable(),
  previousProviderConfigRevision: z.string().min(1).max(128).nullable(),
  desiredProviderConfigRevision: z.string().min(1).max(128),
  catalogRevision: z.string().min(1),
  pendingRelease: z.string().min(1).max(128).optional(),
  stagedReleases: z.array(z.string().min(1).max(128)),
  health: z.object({
    status: z.string().min(1).max(32),
    ok: z.boolean().optional(),
    observedAt: z.string().datetime(),
  }).strict().optional(),
}).strict();

export const runtimeDeploymentPlanSchema = z.object({
  runtime: z.string().min(1).max(128),
  release: z.string().min(1).max(128),
  activeRelease: z.string().min(1).max(128).nullable(),
  artifacts: z.array(z.string().min(1).max(128)).min(1),
  providerConfigRevision: z.string().min(1).max(128),
  healthPath: z.string().min(1).startsWith("/"),
  runtimeStatus: runtimeStatusSchema.optional(),
  requiresStop: z.boolean(),
  staged: z.boolean(),
  rollbackAvailable: z.boolean(),
  disk: z.object({
    additionalBytesRequired: z.number().int().nonnegative(),
    checkedDuringStage: z.boolean(),
  }).strict(),
  allowed: z.boolean(),
  blockers: z.array(z.string().min(1)),
}).strict();

export type PublicRuntimeRelease = z.infer<typeof publicRuntimeReleaseSchema>;
export type RuntimeReleaseSelection = z.infer<typeof runtimeReleaseSelectionSchema>;
export type RuntimeReleasePlanRequest = z.infer<typeof runtimeReleasePlanRequestSchema>;
export type RuntimeDeployment = z.infer<typeof runtimeDeploymentSchema>;
export type RuntimeDeploymentPlan = z.infer<typeof runtimeDeploymentPlanSchema>;
export type ReleaseConvergenceStatus = z.infer<typeof releaseConvergenceStatusSchema>;
export type HttpProviderSoakEvidence = z.infer<typeof httpProviderSoakEvidenceSchema>;
