import { z } from "zod";

export const prepareRequestSchema = z
  .object({
    profile: z.string().min(1).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    client: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.profile) || (value.capabilities && value.capabilities.length > 0), {
    message: "profile or capabilities is required",
  });

export const releaseRequestSchema = z.object({
  leaseId: z.string().min(1),
});

export const resolveRequestSchema = z.object({
  capability: z.string().min(1),
});

export type PrepareRequest = z.infer<typeof prepareRequestSchema>;
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;
