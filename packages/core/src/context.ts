import { createHash } from "node:crypto";
import { z } from "zod";

const contextIdentifierSchema = z.string().min(1).max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const byteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokenCountSchema = z.number().int().nonnegative().max(100_000_000);

export const contextMaterializationModeSchema = z.enum([
  "source-rebuild",
  "exact-prefix",
  "session-snapshot",
  "selective-blend",
]);

const uniqueModesSchema = z.array(contextMaterializationModeSchema).min(1).max(4)
  .refine((items) => new Set(items).size === items.length, "context modes must be unique");

const disabledContextPolicySchema = z.object({
  class: z.literal("disabled"),
}).strict();

export const managedContextPolicySchema = z.object({
  class: z.literal("managed-context"),
  activation: z.literal("when-hosted"),
  sourceTokenLimit: z.number().int().min(1).max(100_000_000),
  materializedRetentionTargetTokens: z.number().int().min(1).max(100_000_000),
  outputReserveTokens: z.number().int().min(1).max(1_000_000),
  safetyMarginTokens: z.number().int().min(0).max(1_000_000),
  ramCacheMaxBytes: byteCountSchema,
  nvmeCacheMaxBytes: byteCountSchema,
  filesystemFreeFloorBytes: byteCountSchema,
  cacheHighWatermark: z.number().min(0.01).max(1),
  cacheLowWatermark: z.number().min(0).max(0.99),
  operationTimeoutMs: z.number().int().min(1).max(3_600_000),
  allowedModes: uniqueModesSchema,
}).strict().superRefine((value, context) => {
  if (value.cacheLowWatermark >= value.cacheHighWatermark) {
    context.addIssue({
      code: "custom",
      path: ["cacheLowWatermark"],
      message: "cacheLowWatermark must be less than cacheHighWatermark",
    });
  }
  if (!value.allowedModes.includes("source-rebuild")) {
    context.addIssue({
      code: "custom",
      path: ["allowedModes"],
      message: "managed context must allow source-rebuild fallback",
    });
  }
});

export const runtimeContextPolicySchema = z.union([
  disabledContextPolicySchema,
  managedContextPolicySchema,
]);

export const contextCertificationSchema = z.object({
  profile: contextIdentifierSchema,
  modelArtifactDigest: digestSchema,
  tokenizerDigest: digestSchema,
  chatTemplateDigest: digestSchema,
  engineBuild: z.string().min(1).max(256),
  providerConfigRevision: contextIdentifierSchema,
  stateFormat: contextIdentifierSchema.optional(),
  cacheTypeK: contextIdentifierSchema.optional(),
  cacheTypeV: contextIdentifierSchema.optional(),
  contextLimitTokens: z.number().int().min(1).max(100_000_000),
  verifiedModes: uniqueModesSchema,
  evidenceDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const persistsState = value.verifiedModes.some((mode) =>
    mode === "exact-prefix" || mode === "session-snapshot" || mode === "selective-blend"
  );
  if (persistsState && !value.stateFormat) {
    context.addIssue({
      code: "custom",
      path: ["stateFormat"],
      message: "stateFormat is required for persisted context modes",
    });
  }
  if (persistsState && (!value.cacheTypeK || !value.cacheTypeV)) {
    context.addIssue({
      code: "custom",
      path: ["cacheTypeK"],
      message: "cacheTypeK and cacheTypeV are required for persisted context modes",
    });
  }
});

export const contextClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

export const contextRegistrationRequestSchema = z.object({
  id: contextIdentifierSchema,
  version: contextIdentifierSchema,
  sourceHandle: contextIdentifierSchema,
  sourceDigest: digestSchema,
  classification: contextClassificationSchema,
  byteCount: byteCountSchema.min(1),
  tokenCount: tokenCountSchema.min(1),
  tokenizerDigest: digestSchema,
  expiresAt: z.string().datetime().optional(),
}).strict();

export const contextDescriptorSchema = contextRegistrationRequestSchema.extend({
  schemaVersion: z.literal(1),
  principal: z.string().min(1).max(128),
  state: z.enum(["active", "invalid", "deleted"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const contextPlanItemSchema = z.object({
  contextId: contextIdentifierSchema,
  version: contextIdentifierSchema,
  required: z.boolean(),
  utility: z.number().min(0).max(1),
}).strict();

export const contextViewRequestSchema = z.object({
  allocationId: z.string().min(1).max(192),
  runtime: contextIdentifierSchema,
  baseInputTokens: tokenCountSchema,
  maxInputTokens: tokenCountSchema.min(1),
  deadline: z.string().datetime(),
  canonicalizationVersion: z.literal("context-view-v1"),
  items: z.array(contextPlanItemSchema).min(1).max(512),
}).strict().refine((value) => {
  const keys = value.items.map((item) => `${item.contextId}\0${item.version}`);
  return new Set(keys).size === keys.length;
}, { path: ["items"], message: "context plan items must be unique" });

export const contextViewStateSchema = z.enum(["ready", "consumed", "expired", "invalid"]);

export const contextViewItemSchema = contextPlanItemSchema.extend({
  tokenCount: tokenCountSchema,
  sourceDigest: digestSchema,
}).strict();

export const contextViewOmissionSchema = z.object({
  contextId: contextIdentifierSchema,
  version: contextIdentifierSchema,
  reason: z.enum(["budget", "not_found", "invalid", "tokenizer_mismatch"]),
}).strict();

export const activeContextViewSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(192),
  operationId: z.string().min(1).max(192),
  principal: z.string().min(1).max(128),
  allocationId: z.string().min(1).max(192),
  runtime: contextIdentifierSchema,
  release: contextIdentifierSchema,
  compatibilityKey: digestSchema,
  viewDigest: digestSchema,
  canonicalizationVersion: z.literal("context-view-v1"),
  baseInputTokens: tokenCountSchema,
  inputBudgetTokens: tokenCountSchema,
  tokenCount: tokenCountSchema,
  orderedItems: z.array(contextViewItemSchema).max(512),
  omitted: z.array(contextViewOmissionSchema).max(512),
  leaseEpoch: z.number().int().nonnegative(),
  state: contextViewStateSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const contextOperationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(192),
  principal: z.string().min(1).max(128),
  idempotencyKeyDigest: digestSchema,
  viewId: z.string().min(1).max(192),
  fence: z.number().int().nonnegative(),
  mode: z.enum(["source-rebuild", "session-snapshot"]),
  state: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  deadline: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  outcome: z.string().min(1).max(128).optional(),
}).strict();

export const contextActivationStateSchema = z.enum([
  "DISABLED",
  "INELIGIBLE",
  "STANDBY",
  "STARTING",
  "ACTIVE",
  "BUSY",
  "DRAINING",
  "DEGRADED",
]);

export type ContextMaterializationMode = z.infer<typeof contextMaterializationModeSchema>;
export type ManagedContextPolicy = z.infer<typeof managedContextPolicySchema>;
export type RuntimeContextPolicy = z.infer<typeof runtimeContextPolicySchema>;
export type ContextCertification = z.infer<typeof contextCertificationSchema>;
export type ContextClassification = z.infer<typeof contextClassificationSchema>;
export type ContextRegistrationRequest = z.infer<typeof contextRegistrationRequestSchema>;
export type ContextDescriptor = z.infer<typeof contextDescriptorSchema>;
export type ContextPlanItem = z.infer<typeof contextPlanItemSchema>;
export type ContextViewRequest = z.infer<typeof contextViewRequestSchema>;
export type ContextViewItem = z.infer<typeof contextViewItemSchema>;
export type ContextViewOmission = z.infer<typeof contextViewOmissionSchema>;
export type ActiveContextView = z.infer<typeof activeContextViewSchema>;
export type ContextOperation = z.infer<typeof contextOperationSchema>;
export type ContextActivationState = z.infer<typeof contextActivationStateSchema>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contextCompatibilityKey(input: {
  release: string;
  certification: ContextCertification;
  principalScope: string;
}): string {
  return sha256(JSON.stringify({
    release: input.release,
    profile: input.certification.profile,
    modelArtifactDigest: input.certification.modelArtifactDigest,
    tokenizerDigest: input.certification.tokenizerDigest,
    chatTemplateDigest: input.certification.chatTemplateDigest,
    engineBuild: input.certification.engineBuild,
    providerConfigRevision: input.certification.providerConfigRevision,
    stateFormat: input.certification.stateFormat ?? null,
    cacheTypeK: input.certification.cacheTypeK ?? null,
    cacheTypeV: input.certification.cacheTypeV ?? null,
    contextLimitTokens: input.certification.contextLimitTokens,
    principalScope: input.principalScope,
  }));
}

export type ContextPlanCandidate = {
  plan: ContextPlanItem;
  descriptor: ContextDescriptor;
};

export type ContextPlanResult =
  | {
    ok: true;
    inputBudgetTokens: number;
    tokenCount: number;
    orderedItems: ContextViewItem[];
    omitted: ContextViewOmission[];
    viewDigest: string;
  }
  | {
    ok: false;
    reason: "context_budget_exceeded";
    inputBudgetTokens: number;
    requiredTokens: number;
  };

function compareCanonical(left: ContextPlanCandidate, right: ContextPlanCandidate): number {
  return left.plan.contextId.localeCompare(right.plan.contextId)
    || left.plan.version.localeCompare(right.plan.version);
}

export function planActiveContextView(input: {
  policy: ManagedContextPolicy;
  certification: ContextCertification;
  baseInputTokens: number;
  maxInputTokens: number;
  canonicalizationVersion: "context-view-v1";
  candidates: ContextPlanCandidate[];
  omissions?: ContextViewOmission[];
}): ContextPlanResult {
  const inputBudgetTokens = Math.max(0, Math.min(
    input.maxInputTokens,
    input.certification.contextLimitTokens
      - input.policy.outputReserveTokens
      - input.policy.safetyMarginTokens,
  ));
  const required = input.candidates.filter((candidate) => candidate.plan.required)
    .sort(compareCanonical);
  const optional = input.candidates.filter((candidate) => !candidate.plan.required)
    .sort((left, right) =>
      right.plan.utility - left.plan.utility || compareCanonical(left, right)
    );
  const requiredTokens = input.baseInputTokens
    + required.reduce((total, candidate) => total + candidate.descriptor.tokenCount, 0);
  if (requiredTokens > inputBudgetTokens) {
    return { ok: false, reason: "context_budget_exceeded", inputBudgetTokens, requiredTokens };
  }

  const selected = [...required];
  const omitted = [...(input.omissions ?? [])];
  let tokenCount = requiredTokens;
  for (const candidate of optional) {
    if (tokenCount + candidate.descriptor.tokenCount <= inputBudgetTokens) {
      selected.push(candidate);
      tokenCount += candidate.descriptor.tokenCount;
    } else {
      omitted.push({
        contextId: candidate.plan.contextId,
        version: candidate.plan.version,
        reason: "budget",
      });
    }
  }
  const orderedItems = selected.map(({ plan, descriptor }) => ({
    ...plan,
    tokenCount: descriptor.tokenCount,
    sourceDigest: descriptor.sourceDigest,
  }));
  const viewDigest = sha256(JSON.stringify({
    canonicalizationVersion: input.canonicalizationVersion,
    baseInputTokens: input.baseInputTokens,
    orderedItems: orderedItems.map((item) => ({
      contextId: item.contextId,
      version: item.version,
      sourceDigest: item.sourceDigest,
      tokenCount: item.tokenCount,
    })),
  }));
  omitted.sort((left, right) =>
    left.contextId.localeCompare(right.contextId)
    || left.version.localeCompare(right.version)
    || left.reason.localeCompare(right.reason)
  );
  return { ok: true, inputBudgetTokens, tokenCount, orderedItems, omitted, viewDigest };
}

export function deriveContextActivation(input: {
  enabled: boolean;
  policy?: RuntimeContextPolicy;
  reasoningCapable: boolean;
  certification?: ContextCertification;
  activeRelease?: string;
  runtimeStatus?: "COLD" | "STARTING" | "HOT" | "BUSY" | "STOPPING" | "FAILED";
  observationFresh: boolean;
  probeOk: boolean;
  draining: boolean;
}): { state: ContextActivationState; reason: string; modes: ContextMaterializationMode[] } {
  if (!input.enabled || !input.policy || input.policy.class === "disabled") {
    return { state: "DISABLED", reason: "context_disabled", modes: [] };
  }
  if (!input.reasoningCapable) {
    return { state: "INELIGIBLE", reason: "reasoning_capability_missing", modes: [] };
  }
  if (!input.certification || !input.activeRelease) {
    return { state: "INELIGIBLE", reason: "context_certification_missing", modes: [] };
  }
  const modes = input.policy.allowedModes.filter((mode) =>
    input.certification!.verifiedModes.includes(mode)
  );
  if (!modes.includes("source-rebuild")) {
    return { state: "INELIGIBLE", reason: "source_rebuild_not_certified", modes: [] };
  }
  if (input.draining || input.runtimeStatus === "STOPPING") {
    return { state: "DRAINING", reason: "runtime_draining", modes };
  }
  if (!input.observationFresh) {
    return { state: "DEGRADED", reason: "runtime_observation_stale", modes };
  }
  if (input.runtimeStatus === "FAILED") {
    return { state: "DEGRADED", reason: "runtime_failed", modes };
  }
  if (!input.runtimeStatus || input.runtimeStatus === "COLD") {
    return { state: "STANDBY", reason: "runtime_cold", modes };
  }
  if (input.runtimeStatus === "STARTING" || !input.probeOk) {
    return { state: "STARTING", reason: input.probeOk ? "runtime_starting" : "context_probe_pending", modes };
  }
  if (input.runtimeStatus === "BUSY") {
    return { state: "BUSY", reason: "runtime_busy", modes };
  }
  return { state: "ACTIVE", reason: "eligible_runtime_hot", modes };
}
