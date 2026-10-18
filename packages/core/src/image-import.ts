import { z } from "zod";
import { imageArtifactSchema } from "./image-artifact";

export const IMAGE_IMPORT_LIMITS = Object.freeze({ inputBytes: 16 * 1024 ** 2, storedBytes: 20 * 1024 ** 2, maxEdge: 2000, maxPixels: 4_000_000, receiptTtlMs: 7 * 24 * 60 * 60 * 1000, multipartOverheadBytes: 64 * 1024 });
export const imageImportRequestIdSchema = z.uuid();
export const imageImportErrorSchema = z.object({ code: z.string(), message: z.string() }).strict();
const fields = {
  requestId: imageImportRequestIdSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  statusUrl: z.string().startsWith("/v1/image-imports/"),
};
export const imageImportReceiptSchema = z.union([
  z.object({ ...fields, status: z.literal("pending") }).strict(),
  z.object({ ...fields, status: z.literal("succeeded"), deleted: z.literal(false), artifact: imageArtifactSchema }).strict(),
  z.object({ ...fields, status: z.literal("succeeded"), deleted: z.literal(true), artifactId: z.string().regex(/^image_[a-f0-9]{32}$/) }).strict(),
  z.object({ ...fields, status: z.literal("failed"), error: imageImportErrorSchema }).strict(),
]);
export type ImageImportReceipt = z.infer<typeof imageImportReceiptSchema>;
