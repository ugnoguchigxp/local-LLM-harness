import { z } from "zod";

const requestIdSchema = z.string().min(1).max(128);
const capabilitySchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const capabilityListSchema = z
  .array(capabilitySchema)
  .min(1)
  .max(16)
  .refine((items) => new Set(items).size === items.length, "capabilities must be unique");

export const prepareRequestSchema = z
  .object({
    profile: requestIdSchema.optional(),
    capabilities: capabilityListSchema.optional(),
    client: requestIdSchema.optional(),
  }).strict()
  .refine((value) => Boolean(value.profile) || (value.capabilities && value.capabilities.length > 0), {
    message: "profile or capabilities is required",
  });

export const releaseRequestSchema = z.object({
  leaseId: requestIdSchema,
}).strict();

export const resolveRequestSchema = z.object({
  capability: capabilitySchema,
}).strict();

export const allocationRequirementSchema = z.object({
  capability: capabilitySchema,
  route: requestIdSchema,
}).strict();

export const deploymentPolicySchema = z.enum(["existing-only", "allow-listed"]);

export const allocationRequestSchema = z
  .object({
    requirements: z.array(allocationRequirementSchema).min(1).max(16),
    client: requestIdSchema.optional(),
    allowFallback: z.boolean().default(false),
    ttlSeconds: z.number().int().min(1).max(86_400).default(300),
    deploymentPolicy: deploymentPolicySchema.default("existing-only"),
  }).strict()
  .refine(
    (value) => new Set(value.requirements.map((requirement) => requirement.capability)).size
      === value.requirements.length,
    { message: "requirements must contain each capability at most once", path: ["requirements"] },
  );

export const allocationResolveRequestSchema = z.object({
  capability: capabilitySchema,
}).strict();

export const allocationRenewRequestSchema = z.object({
  ttlSeconds: z.number().int().min(1).max(86_400).default(300),
}).strict();

export type PrepareRequest = z.infer<typeof prepareRequestSchema>;
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;
export type AllocationRequirement = z.infer<typeof allocationRequirementSchema>;
export type DeploymentPolicy = z.infer<typeof deploymentPolicySchema>;
export type AllocationRequest = z.infer<typeof allocationRequestSchema>;
export type AllocationResolveRequest = z.infer<typeof allocationResolveRequestSchema>;
export type AllocationRenewRequest = z.infer<typeof allocationRenewRequestSchema>;
