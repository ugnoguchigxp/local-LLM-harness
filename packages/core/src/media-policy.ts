import { z } from "zod";

const variantSchema = z.object({
  healthUrl: z.string().url(),
  idleTtlSeconds: z.literal(0),
});

/** Demand-only media workers must stop after each request. */
export const mediaPolicySchema = z.object({
  variants: z.object({ image: variantSchema, music: variantSchema }),
});
