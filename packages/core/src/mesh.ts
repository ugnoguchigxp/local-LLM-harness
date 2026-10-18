import { z } from "zod";

export const meshIdSchema = z.string().regex(/^mesh_[a-f0-9]{32}$/);
export const meshJobIdSchema = z.string().regex(/^meshjob_[a-f0-9]{32}$/);
const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(32).transform((v) => [...new Set(v)]);
export const meshGenerationRequestSchema = z.object({
  model: z.literal("trellis2-4b").default("trellis2-4b"),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("image-artifact"), id: z.string().regex(/^image_[a-f0-9]{32}$/) }).strict(),
    z.object({ type: z.literal("prompt"), prompt: z.string().trim().min(1).max(8192),
      imageModel: z.literal("qwen-image-2.1-turbo").default("qwen-image-2.1-turbo"),
      imageSeed: z.number().int().min(0).max(2147483647).default(42) }).strict(),
  ]),
  title: z.string().trim().min(1).max(256).default("3D asset"),
  tags: tagsSchema.default([]), resolution: z.literal(512).default(512),
  seed: z.number().int().min(1).max(2147483647).default(42),
}).strict();
export type MeshGenerationRequestInput = z.input<typeof meshGenerationRequestSchema>;
export type MeshGenerationRequest = z.infer<typeof meshGenerationRequestSchema>;
export const meshAssetPatchSchema = z.object({ title: z.string().trim().min(1).max(256).optional(), tags: tagsSchema.optional() }).strict();
export const meshQuerySchema = z.object({
  q: z.string().max(512).optional(),
  tags: z.union([z.string().max(4096).transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)), tagsSchema]).pipe(tagsSchema).optional(),
  sort: z.enum(["createdAt", "relevance"]).default("createdAt"), order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().max(8192).optional(),
}).strict();
export type MeshQuery = z.infer<typeof meshQuerySchema>;
export const meshGeometrySchema = z.object({ vertices: z.number().int().positive(), triangles: z.number().int().positive(),
  textures: z.number().int().nonnegative(), extensions: z.array(z.string()) }).strict();
export const meshAssetSchema = z.object({
  id: meshIdSchema, jobId: meshJobIdSchema.optional(), createdAt: z.string().datetime(),
  title: z.string().max(256), tags: tagsSchema, prompt: z.string().max(8192).optional(),
  sourceImageId: z.string().regex(/^image_[a-f0-9]{32}$/).optional(),
  model: z.literal("trellis2-4b"), resolution: z.literal(512), seed: z.number().int(), steps: z.literal(12),
  bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceMimeType: z.enum(["image/png", "image/webp"]), geometry: meshGeometrySchema,
  provenance: z.object({ engine: z.string().max(128), engineCommit: z.string().max(64), weightsRevision: z.string().max(64),
    imported: z.boolean().default(false) }).strict(),
  warnings: z.array(z.string().max(512)).max(32),
  contentUrl: z.string(), metadataUrl: z.string(), sourceUrl: z.string(), previewUrl: z.string(),
}).strict();
export type MeshAsset = z.infer<typeof meshAssetSchema>;
export const meshJobSchema = z.object({
  jobId: meshJobIdSchema, status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  stage: z.enum(["queued", "image", "waiting_gpu", "background", "mesh", "validating", "stopping", "completed", "failed", "cancelled", "deleted"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  statusUrl: z.string(), eventsUrl: z.string(), assetId: meshIdSchema.optional(), asset: meshAssetSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(), deleted: z.boolean().optional(),
}).strict();
export type MeshJob = z.infer<typeof meshJobSchema>;
export const meshAssetListSchema = z.object({ assets: z.array(meshAssetSchema), total: z.number().int().nonnegative(), nextCursor: z.string().optional() });
export type MeshAssetList = z.infer<typeof meshAssetListSchema>;
export function meshUrls(id: string) {
  const base = `/v1/3d/assets/${id}`;
  return { contentUrl: `${base}/content`, metadataUrl: `${base}/metadata`, sourceUrl: `${base}/source`, previewUrl: `${base}/preview` };
}
