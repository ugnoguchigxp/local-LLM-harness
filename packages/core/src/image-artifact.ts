import { z } from "zod";

export const imageArtifactIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const imageArtifactFormatSchema = z.enum(["webp", "png"]);
export const imageArtifactMimeTypeSchema = z.enum(["image/webp", "image/png"]);

const imageArtifactMetadataFieldsSchema = z.object({
  id: imageArtifactIdSchema,
  createdAt: z.string().datetime(),
  format: imageArtifactFormatSchema,
  mimeType: imageArtifactMimeTypeSchema,
  file: z.enum(["image.webp", "image.png"]),
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
  hasAlpha: z.boolean(),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().min(1).max(256).optional(),
  modelRevision: z.string().min(1).max(256).optional(),
  seed: z.number().int().nonnegative().optional(),
  steps: z.number().int().positive().optional(),
}).strict();

function validateImageArtifactFormat(
  metadata: { format: "webp" | "png"; mimeType: "image/webp" | "image/png"; file?: string },
  context: z.RefinementCtx,
): void {
  if (metadata.file !== undefined && metadata.file !== `image.${metadata.format}`) {
    context.addIssue({
      code: "custom",
      path: ["file"],
      message: "image artifact filename must match its format",
    });
  }
  const expectedMimeType = metadata.format === "webp" ? "image/webp" : "image/png";
  if (metadata.mimeType !== expectedMimeType) {
    context.addIssue({
      code: "custom",
      path: ["mimeType"],
      message: "image artifact MIME type must match its format",
    });
  }
}

export const storedImageArtifactMetadataSchema = imageArtifactMetadataFieldsSchema
  .superRefine(validateImageArtifactFormat);

export const imageArtifactSchema = imageArtifactMetadataFieldsSchema.omit({ file: true }).extend({
  contentUrl: z.string().startsWith("/v1/image-artifacts/"),
}).strict().superRefine(validateImageArtifactFormat);

export const imageArtifactListSchema = z.object({
  images: z.array(imageArtifactSchema),
  totalBytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive(),
  targetBytes: z.number().int().nonnegative(),
}).strict();

export const imageArtifactDeleteSchema = z.object({
  id: imageArtifactIdSchema,
  deleted: z.literal(true),
}).strict();

export const imageGenerationRequestSchema = z.object({
  prompt: z.string().min(1).max(8_192),
  model: z.enum(["qwen-image-2.1-turbo", "flux-3-image-klein"]).optional()
    .describe("Select the on-demand image model; defaults to qwen-image-2.1-turbo. FLUX requires a configured runtime and never falls back to Qwen."),
  width: z.number().int().min(100).max(1280).optional()
    .describe("Output width in pixels, 100 through 1280 inclusive; defaults to 512. Generation rounds up to model alignment (Qwen: 32, FLUX: 16), then resizes to this exact width."),
  height: z.number().int().min(100).max(1280).optional()
    .describe("Output height in pixels, 100 through 1280 inclusive; defaults to 512. Generation rounds up to model alignment (Qwen: 32, FLUX: 16), then resizes to this exact height."),
  steps: z.union([z.literal(8), z.literal(16)]).optional()
    .describe("Fixed model schedule: Qwen Turbo uses 8 steps, FLUX 3 Image Klein uses 16. Omit to use the selected model's schedule."),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  format: imageArtifactFormatSchema.optional(),
}).strict().superRefine((request, context) => {
  const steps = request.model === "flux-3-image-klein" ? 16 : 8;
  if (request.steps !== undefined && request.steps !== steps) context.addIssue({
    code: "custom", path: ["steps"], message: `selected image model requires ${steps} steps`,
  });
});

export const imageGenerationResponseSchema = z.object({
  object: z.literal("image_generation"),
  status: z.literal("succeeded"),
  artifact: imageArtifactSchema,
  artifacts: z.array(imageArtifactSchema).length(1).optional(),
  durationMs: z.number().nonnegative(),
}).strict();

export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;

export type StoredImageArtifactMetadata = z.infer<typeof storedImageArtifactMetadataSchema>;
export type ImageArtifact = z.infer<typeof imageArtifactSchema>;
export type ImageArtifactList = z.infer<typeof imageArtifactListSchema>;
export type ImageArtifactDelete = z.infer<typeof imageArtifactDeleteSchema>;
