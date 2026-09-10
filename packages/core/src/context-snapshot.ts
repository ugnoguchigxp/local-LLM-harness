import { z } from "zod";

export const CONTEXT_SNAPSHOT_CHUNK_BYTES = 64 * 1024 * 1024;
export const CONTEXT_SNAPSHOT_MAX_CHUNKS = 16_384;

const identifierSchema = z.string().min(1).max(192)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const byteCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const contextSnapshotChunkSchema = z.object({
  index: z.number().int().nonnegative().max(CONTEXT_SNAPSHOT_MAX_CHUNKS - 1),
  bytes: z.number().int().positive().max(CONTEXT_SNAPSHOT_CHUNK_BYTES),
  crc32c: z.string().regex(/^[a-f0-9]{8}$/),
}).strict();

export const contextSnapshotManifestSchema = z.object({
  schemaVersion: z.literal(1),
  algorithm: z.literal("crc32c"),
  entryId: identifierSchema,
  principalScope: digestSchema,
  runtime: identifierSchema,
  release: identifierSchema,
  compatibilityKey: digestSchema,
  viewDigest: digestSchema,
  tokenCount: z.number().int().positive().max(100_000_000),
  snapshotBytes: byteCountSchema.min(1),
  chunkBytes: z.literal(CONTEXT_SNAPSHOT_CHUNK_BYTES),
  chunks: z.array(contextSnapshotChunkSchema).min(1).max(CONTEXT_SNAPSHOT_MAX_CHUNKS),
  state: z.literal("committed"),
  createdAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  let total = 0;
  for (let index = 0; index < value.chunks.length; index += 1) {
    const chunk = value.chunks[index]!;
    if (chunk.index !== index) {
      context.addIssue({
        code: "custom",
        path: ["chunks", index, "index"],
        message: "snapshot chunk indexes must be contiguous",
      });
    }
    if (index < value.chunks.length - 1 && chunk.bytes !== value.chunkBytes) {
      context.addIssue({
        code: "custom",
        path: ["chunks", index, "bytes"],
        message: "all snapshot chunks except the last must have the configured size",
      });
    }
    total += chunk.bytes;
  }
  if (total !== value.snapshotBytes) {
    context.addIssue({
      code: "custom",
      path: ["snapshotBytes"],
      message: "snapshotBytes must equal the sum of chunk bytes",
    });
  }
});

export type ContextSnapshotChunk = z.infer<typeof contextSnapshotChunkSchema>;
export type ContextSnapshotManifest = z.infer<typeof contextSnapshotManifestSchema>;

export function contextSnapshotLookupKey(input: {
  principalScope: string;
  runtime: string;
  release: string;
  compatibilityKey: string;
  viewDigest: string;
}): string {
  return [
    input.principalScope,
    input.runtime,
    input.release,
    input.compatibilityKey,
    input.viewDigest,
  ].join("\0");
}

export function validateContextSnapshotIdentity(
  manifest: ContextSnapshotManifest,
  expected: {
    principalScope: string;
    runtime: string;
    release: string;
    compatibilityKey: string;
    viewDigest: string;
    maxBytes: number;
  },
): "ok" | "identity_mismatch" | "oversize" {
  if (manifest.snapshotBytes > expected.maxBytes) return "oversize";
  return manifest.principalScope === expected.principalScope
    && manifest.runtime === expected.runtime
    && manifest.release === expected.release
    && manifest.compatibilityKey === expected.compatibilityKey
    && manifest.viewDigest === expected.viewDigest
    ? "ok"
    : "identity_mismatch";
}
