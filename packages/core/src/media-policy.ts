import { z } from "zod";

const variantSchema = z.object({
  healthUrl: z.string().url(),
  idleTtlSeconds: z.literal(0),
  models: z.array(z.enum(["qwen-image-2.1-turbo", "flux-3-image-klein"])).optional(),
});

/** Demand-only media workers must stop after each request. */
export const mediaPolicySchema = z.object({
  variants: z.object({ image: variantSchema, "image-flux3": variantSchema.optional(), music: variantSchema, mesh: variantSchema.optional(), "stable-audio": variantSchema }),
});
