import { z } from "zod";

const variantSchema = z.object({
  healthUrl: z.string().url(),
  idleTtlSeconds: z.literal(0),
  estimatedMemoryGB: z.number().positive(),
  service: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/),
  models: z.array(z.enum(["qwen-image-2.1-turbo", "flux-3-image-klein"])).optional(),
});

/** Demand-only media workers must stop after each request. */
export const mediaPolicySchema = z.object({
  groups: z.object({ "accelerator-media-heavy": z.object({ minimumAvailableMemoryGB: z.number().nonnegative() }) }),
  variants: z.object({ image: variantSchema, "image-flux3": variantSchema.optional(), music: variantSchema, mesh: variantSchema.optional(), "stable-audio": variantSchema }),
});
