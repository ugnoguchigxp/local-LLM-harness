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
  model: z.literal("qwen-image-2.1").optional(),
  width: z.union([z.literal(512), z.literal(768), z.literal(1024)]).optional(),
  height: z.union([z.literal(512), z.literal(768), z.literal(1024)]).optional(),
  steps: z.number().int().min(1).max(50).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  format: imageArtifactFormatSchema.optional(),
}).strict();

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
