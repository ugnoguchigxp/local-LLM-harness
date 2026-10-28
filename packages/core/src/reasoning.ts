import { z } from "zod";

export const reasoningEffortSchema = z.enum(["low", "medium", "high", "max"]);

// Internal runtime policy. Public requests use reasoning_effort only.
export const reasoningPolicySchema = z.object({
  defaultEffort: reasoningEffortSchema,
  readinessDisableThinking: z.boolean().optional(),
  budgets: z.object({
    low: z.number().int().positive(),
    medium: z.number().int().positive(),
    high: z.number().int().positive(),
    max: z.literal(-1),
  }).strict(),
}).strict().refine((policy) => policy.budgets.low <= policy.budgets.medium
  && policy.budgets.medium <= policy.budgets.high, "reasoning budgets must increase with effort");

export type ReasoningPolicy = z.infer<typeof reasoningPolicySchema>;
