import { z } from "zod";
import { allocationRequirementSchema, deploymentPolicySchema } from "./api-schema";
import { runtimeStatusSchema } from "./schema";

export const allocationStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "released",
  "expired",
]);

export const allocationBindingSchema = z.object({
  capability: z.string().min(1).max(128),
  route: z.string().min(1).max(128),
  runtime: z.string().min(1).max(128),
  node: z.string().min(1).max(128),
  endpoint: z.string().url(),
  status: runtimeStatusSchema,
  candidateRank: z.number().int().positive(),
  fallback: z.boolean(),
  selectionReason: z.string().min(1).max(128),
}).strict();

export const allocationErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();

export const allocationSchema = z
  .object({
    id: z.string().min(1).max(192),
    bootEpoch: z.string().min(1).max(128),
    client: z.string().min(1).max(128).optional(),
    status: allocationStatusSchema,
    requirements: z.array(allocationRequirementSchema).min(1).max(16),
    bindings: z.array(allocationBindingSchema).min(1).max(16),
    allowFallback: z.boolean(),
    deploymentPolicy: deploymentPolicySchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    operationId: z.string().min(1).max(192).optional(),
    releasedAt: z.string().datetime().optional(),
    error: allocationErrorSchema.optional(),
  }).strict()
  .superRefine((allocation, context) => {
    const requirements = new Map(
      allocation.requirements.map((requirement) => [requirement.capability, requirement.route]),
    );
    const bound = new Set<string>();
    for (const [index, binding] of allocation.bindings.entries()) {
      if (bound.has(binding.capability)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate binding for ${binding.capability}`,
          path: ["bindings", index, "capability"],
        });
      }
      bound.add(binding.capability);
      if (requirements.get(binding.capability) !== binding.route) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "binding must match a declared capability and route",
          path: ["bindings", index],
        });
      }
    }
    for (const capability of requirements.keys()) {
      if (!bound.has(capability)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `missing binding for ${capability}`,
          path: ["bindings"],
        });
      }
    }
  });

export type AllocationStatus = z.infer<typeof allocationStatusSchema>;
export type AllocationBinding = z.infer<typeof allocationBindingSchema>;
export type AllocationError = z.infer<typeof allocationErrorSchema>;
export type Allocation = z.infer<typeof allocationSchema>;

export function createAllocationId(bootEpoch: string, random?: () => string): string {
  return `alloc_${bootEpoch}_${(random ?? (() => crypto.randomUUID()))()}`;
}

export function activeAllocation(status: AllocationStatus): boolean {
  return status === "pending" || status === "ready";
}
