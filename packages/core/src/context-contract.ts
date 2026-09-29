import { z } from "zod";
import {
  contextActivationStateSchema,
  contextDescriptorSchema,
  contextMaterializationModeSchema,
  contextOperationSchema,
  contextViewItemSchema,
  contextViewOmissionSchema,
  contextViewStateSchema,
} from "./context";

export const publicContextDescriptorSchema = contextDescriptorSchema.omit({ principal: true });
export const contextListSchema = z.object({
  contexts: z.array(publicContextDescriptorSchema),
  nextCursor: z.string().min(1).max(512).optional(),
}).strict();
export const contextRuntimeStatusSchema = z.object({
  runtime: z.string().min(1).max(128),
  release: z.string().min(1).max(128).optional(),
  state: contextActivationStateSchema,
  reason: z.string().min(1).max(128),
  modes: z.array(contextMaterializationModeSchema).max(1),
  leaseEpoch: z.number().int().nonnegative(),
  quota: z.object({
    sourceTokensUsed: z.number().int().nonnegative(),
    sourceTokensLimit: z.number().int().nonnegative(),
    sourceBytesUsed: z.number().int().nonnegative(),
    sourceBytesLimit: z.number().int().nonnegative(),
    filesystemFreeFloorBytes: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();
export const contextStatusSchema = z.object({
  enabled: z.boolean(),
  state: contextActivationStateSchema,
  runtimes: z.array(contextRuntimeStatusSchema),
}).strict();
export const publicContextViewSchema = z.object({
  id: z.string().min(1).max(192),
  operationId: z.string().min(1).max(192),
  allocationId: z.string().min(1).max(192),
  runtime: z.string().min(1).max(128),
  release: z.string().min(1).max(128),
  state: contextViewStateSchema,
  mode: z.literal("source-rebuild"),
  canonicalizationVersion: z.enum(["context-view-v1", "context-view-v2"]).optional(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  dataEpoch: z.number().int().nonnegative().optional(),
  tokenCount: z.number().int().nonnegative(),
  inputBudgetTokens: z.number().int().nonnegative(),
  orderedItems: z.array(contextViewItemSchema).max(512),
  omitted: z.array(contextViewOmissionSchema).max(512),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
export const publicContextOperationSchema = contextOperationSchema.omit({
  principal: true,
  idempotencyKeyDigest: true,
});
