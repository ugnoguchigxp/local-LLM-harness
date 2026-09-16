import { createHash } from "node:crypto";
import { z } from "zod";

export const PERSONAL_STATE_CONTRACT_VERSION = "larm-personal-state.v1" as const;
export const PERSONAL_STATE_CANONICALIZATION_VERSION = "context-view-v2" as const;

const identifierSchema = z.string().min(1).max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const allocationIdentifierSchema = z.string().min(1).max(192);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instantSchema = z.string().datetime();
const byteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokenCountSchema = z.number().int().nonnegative().max(100_000_000);

function unique<T>(items: T[]): boolean {
  return new Set(items).size === items.length;
}

export const personalStateScopeSchema = z.enum([
  "context.source.provision",
  "context.measure",
  "context.view.create",
  "context.generate",
  "context.attempt.cancel",
  "context.forget",
  "context.operation.read",
]);

export const personalStateCapabilitySchema = z.object({
  contractVersion: z.literal(PERSONAL_STATE_CONTRACT_VERSION),
  bootEpoch: z.string().uuid(),
  subjectDigest: digestSchema,
  allocationId: allocationIdentifierSchema,
  runtime: identifierSchema,
  release: identifierSchema,
  leaseEpoch: z.number().int().nonnegative(),
  leaseExpiresAt: instantSchema,
  credentialExpiresAt: instantSchema,
  tokenizerDigest: digestSchema,
  chatTemplateDigest: digestSchema,
  contextLimitTokens: tokenCountSchema.min(1),
  outputReserveTokens: tokenCountSchema.min(1),
  safetyMarginTokens: tokenCountSchema,
  sourceTokenLimit: tokenCountSchema.min(1),
  maxSourceBytes: byteCountSchema,
  maxTotalSourceBytes: byteCountSchema,
  maxMaterializedBytes: byteCountSchema,
  scopes: z.array(personalStateScopeSchema).length(7)
    .refine((items) => new Set(items).size === items.length, "Personal State scopes must be unique"),
}).strict();

export const personalStateOperationStateSchema = z.enum([
  "accepted",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "result_unknown",
]);

export const sourceProvisionReceiptSchema = z.object({
  contractVersion: z.literal(PERSONAL_STATE_CONTRACT_VERSION),
  operationId: z.string().min(1).max(192),
  incarnation: identifierSchema,
  subjectDigest: digestSchema,
  allocationId: allocationIdentifierSchema,
  runtime: identifierSchema,
  release: identifierSchema,
  sourceHandle: identifierSchema,
  sourceDigest: digestSchema,
  byteCount: byteCountSchema.min(1),
  tokenCount: tokenCountSchema.min(1),
  tokenizerDigest: digestSchema,
  chatTemplateDigest: digestSchema,
  leaseEpoch: z.number().int().nonnegative(),
  dataEpoch: z.number().int().nonnegative(),
  state: personalStateOperationStateSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
  expiresAt: instantSchema,
  error: identifierSchema.optional(),
}).strict();

export const canonicalMeasurementRequestSchema = z.object({
  measurementId: identifierSchema,
  allocationId: allocationIdentifierSchema,
  runtime: identifierSchema,
  maxInputTokens: tokenCountSchema.min(1),
  request: z.record(z.string(), z.unknown()),
}).strict().superRefine((value, context) => {
  if (!Array.isArray(value.request.messages)) {
    context.addIssue({
      code: "custom",
      path: ["request", "messages"],
      message: "messages must be an array",
    });
  }
});

export const canonicalMeasurementReceiptSchema = z.object({
  contractVersion: z.literal(PERSONAL_STATE_CONTRACT_VERSION),
  measurementId: z.string().min(1).max(192),
  subjectDigest: digestSchema,
  allocationId: allocationIdentifierSchema,
  runtime: identifierSchema,
  release: identifierSchema,
  requestDigest: digestSchema,
  baseInputTokens: tokenCountSchema,
  maxInputTokens: tokenCountSchema.min(1),
  tokenizerDigest: digestSchema,
  chatTemplateDigest: digestSchema,
  leaseEpoch: z.number().int().nonnegative(),
  dataEpoch: z.number().int().nonnegative(),
  createdAt: instantSchema,
  expiresAt: instantSchema,
}).strict();

export const personalStatePlanItemSchema = z.object({
  contextId: identifierSchema,
  version: identifierSchema,
  required: z.boolean(),
  utility: z.number().min(0).max(1),
}).strict();

export const personalStateViewRequestSchema = z.object({
  viewRequestId: identifierSchema,
  measurementId: z.string().min(1).max(192),
  allocationId: allocationIdentifierSchema,
  runtime: identifierSchema,
  maxInputTokens: tokenCountSchema.min(1),
  deadline: instantSchema,
  canonicalizationVersion: z.literal(PERSONAL_STATE_CANONICALIZATION_VERSION),
  request: z.record(z.string(), z.unknown()),
  items: z.array(personalStatePlanItemSchema).min(1).max(512),
}).strict().superRefine((value, context) => {
  if (!Array.isArray(value.request.messages)) {
    context.addIssue({
      code: "custom",
      path: ["request", "messages"],
      message: "messages must be an array",
    });
  }
  const keys = value.items.map((item) => `${item.contextId}\0${item.version}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "context plan items must be unique",
    });
  }
});

export const personalStateViewReceiptSchema = z.object({
  contractVersion: z.literal(PERSONAL_STATE_CONTRACT_VERSION),
  viewRequestId: identifierSchema,
  subjectDigest: digestSchema,
  requestDigest: digestSchema,
  planDigest: digestSchema,
  idempotencyKeyDigest: digestSchema,
  viewId: z.string().min(1).max(192),
  operationId: z.string().min(1).max(192),
  allocationId: allocationIdentifierSchema,
  runtime: identifierSchema,
  release: identifierSchema,
  bootEpoch: z.string().uuid(),
  dataEpoch: z.number().int().nonnegative(),
  dependencies: z.object({
    contextIds: z.array(identifierSchema).min(1).max(512)
      .refine(unique, "context dependencies must be unique"),
    sourceDigests: z.array(digestSchema).min(1).max(512)
      .refine(unique, "source dependencies must be unique"),
  }).strict().optional(),
  state: z.enum(["ready", "consumed", "expired", "invalid"]),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  expiresAt: instantSchema,
}).strict();

export const generationStopStateSchema = z.enum([
  "not_requested",
  "cancel_requested",
  "transport_closed",
  "backend_stopped",
  "stop_unknown",
]);

export const generationAttemptSchema = z.object({
  contractVersion: z.literal(PERSONAL_STATE_CONTRACT_VERSION),
  attemptId: identifierSchema,
  subjectDigest: digestSchema,
  allocationId: allocationIdentifierSchema,
  runtime: identifierSchema,
  release: identifierSchema,
  viewId: z.string().min(1).max(192).optional(),
  requestDigest: digestSchema,
  larmRequestId: z.string().min(1).max(192),
  dataEpoch: z.number().int().nonnegative(),
  state: z.enum(["accepted", "forwarded", "completed", "failed", "cancelled", "result_unknown"]),
  stopState: generationStopStateSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
  forwardedAt: instantSchema.optional(),
  cancelRequestedAt: instantSchema.optional(),
  transportClosedAt: instantSchema.optional(),
  backendStoppedAt: instantSchema.optional(),
  terminalAt: instantSchema.optional(),
  outcome: identifierSchema.optional(),
}).strict();

export const forgetPhaseNameSchema = z.enum([
  "attempts",
  "views",
  "runtime",
  "snapshots",
  "registry",
  "sources",
  "audit",
]);

export const forgetPhaseSchema = z.object({
  state: z.enum(["pending", "running", "absent", "failed", "stop_unknown"]),
  updatedAt: instantSchema,
  affected: z.number().int().nonnegative(),
  error: identifierSchema.optional(),
}).strict();

export const forgetRequestSchema = z.object({
  forgetId: identifierSchema,
  incarnation: identifierSchema.optional(),
  contextIds: z.array(identifierSchema).max(512).refine(unique, "context targets must be unique").default([]),
  sourceHandles: z.array(identifierSchema).max(512).refine(unique, "source targets must be unique").default([]),
  attemptIds: z.array(identifierSchema).max(512).refine(unique, "attempt targets must be unique").default([]),
}).strict().refine((value) =>
  value.incarnation !== undefined
  || value.contextIds.length > 0
  || value.sourceHandles.length > 0
  || value.attemptIds.length > 0,
{ path: ["forgetId"], message: "at least one forget target is required" });

export const forgetOperationSchema = z.object({
  contractVersion: z.literal(PERSONAL_STATE_CONTRACT_VERSION),
  forgetId: identifierSchema,
  operationId: z.string().min(1).max(192),
  subjectDigest: digestSchema,
  requestDigest: digestSchema,
  targets: z.object({
    incarnation: identifierSchema.optional(),
    contextIds: z.array(identifierSchema).max(512).refine(unique, "context targets must be unique"),
    sourceHandles: z.array(identifierSchema).max(512).refine(unique, "source targets must be unique"),
    attemptIds: z.array(identifierSchema).max(512).refine(unique, "attempt targets must be unique"),
  }).strict(),
  resolved: z.object({
    sourceHandles: z.array(identifierSchema).max(100_000)
      .refine(unique, "resolved source handles must be unique"),
    sourceDigests: z.array(digestSchema).max(100_000)
      .refine(unique, "resolved source digests must be unique"),
    viewIds: z.array(z.string().min(1).max(192)).max(100_000)
      .refine(unique, "resolved view IDs must be unique"),
  }).strict().optional(),
  fenceEpoch: z.number().int().positive(),
  state: personalStateOperationStateSchema,
  phases: z.record(forgetPhaseNameSchema, forgetPhaseSchema),
  absenceVerified: z.boolean(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  completedAt: instantSchema.optional(),
  expiresAt: instantSchema,
  error: identifierSchema.optional(),
}).strict();

export const personalStateSubjectSchema = z.object({
  subjectDigest: digestSchema,
  dataEpoch: z.number().int().nonnegative(),
  updatedAt: instantSchema,
  tombstones: z.array(z.object({
    forgetId: identifierSchema,
    fenceEpoch: z.number().int().positive(),
    targetDigest: digestSchema,
    targets: z.object({
      incarnation: identifierSchema.optional(),
      contextIds: z.array(identifierSchema).max(512).refine(unique, "context targets must be unique"),
      sourceHandles: z.array(identifierSchema).max(512).refine(unique, "source targets must be unique"),
      attemptIds: z.array(identifierSchema).max(512).refine(unique, "attempt targets must be unique"),
    }).strict(),
    createdAt: instantSchema,
  }).strict()).max(10_000),
}).strict();

export const personalStateJournalSchema = z.object({
  schemaVersion: z.literal(1),
  bootEpoch: z.string().uuid(),
  subjects: z.array(personalStateSubjectSchema).max(10_000),
  provisions: z.array(sourceProvisionReceiptSchema).max(100_000),
  measurements: z.array(canonicalMeasurementReceiptSchema).max(100_000),
  views: z.array(personalStateViewReceiptSchema).max(100_000),
  attempts: z.array(generationAttemptSchema).max(100_000),
  forgets: z.array(forgetOperationSchema).max(100_000),
}).strict();

export type PersonalStateScope = z.infer<typeof personalStateScopeSchema>;
export type PersonalStateCapability = z.infer<typeof personalStateCapabilitySchema>;
export type PersonalStateOperationState = z.infer<typeof personalStateOperationStateSchema>;
export type SourceProvisionReceipt = z.infer<typeof sourceProvisionReceiptSchema>;
export type CanonicalMeasurementRequest = z.infer<typeof canonicalMeasurementRequestSchema>;
export type CanonicalMeasurementReceipt = z.infer<typeof canonicalMeasurementReceiptSchema>;
export type PersonalStateViewRequest = z.infer<typeof personalStateViewRequestSchema>;
export type PersonalStateViewReceipt = z.infer<typeof personalStateViewReceiptSchema>;
export type GenerationStopState = z.infer<typeof generationStopStateSchema>;
export type GenerationAttempt = z.infer<typeof generationAttemptSchema>;
export type ForgetPhaseName = z.infer<typeof forgetPhaseNameSchema>;
export type ForgetPhase = z.infer<typeof forgetPhaseSchema>;
export type ForgetRequestInput = z.input<typeof forgetRequestSchema>;
export type ForgetRequest = z.infer<typeof forgetRequestSchema>;
export type ForgetOperation = z.infer<typeof forgetOperationSchema>;
export type PersonalStateSubject = z.infer<typeof personalStateSubjectSchema>;
export type PersonalStateJournal = z.infer<typeof personalStateJournalSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function personalStateDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function personalStateSubjectDigest(principal: string): string {
  return createHash("sha256").update(`larm-personal-state-subject\0${principal}`).digest("hex");
}

export function personalStateSourceHandle(input: {
  subjectDigest: string;
  incarnation: string;
  sourceDigest: string;
}): string {
  return `ps_${personalStateDigest(input).slice(0, 48)}`;
}

export function personalStateOperationId(kind: "source" | "forget", subjectDigest: string, id: string): string {
  return `psop_${personalStateDigest({ kind, subjectDigest, id }).slice(0, 48)}`;
}

export function bindContextViewDigest(viewDigest: string, requestDigest: string): string {
  return personalStateDigest({ viewDigest, requestDigest });
}

export function forgetIsComplete(operation: ForgetOperation): boolean {
  const phases = Object.values(operation.phases);
  return operation.absenceVerified
    && phases.length === forgetPhaseNameSchema.options.length
    && phases.every((phase) => phase.state === "absent");
}
