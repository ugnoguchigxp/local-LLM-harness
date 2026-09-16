import { describe, expect, test } from "bun:test";
import {
  CONTEXT_SNAPSHOT_CHUNK_BYTES,
  contextSnapshotLookupKey,
  contextSnapshotManifestSchema,
  validateContextSnapshotIdentity,
} from "./context-snapshot";

const digest = "a".repeat(64);
const manifest = {
  schemaVersion: 1 as const,
  algorithm: "crc32c" as const,
  entryId: "snapshot-1",
  principalScope: digest,
  runtime: "qwen-worker-quality",
  release: "qwen-worker-quality-current",
  compatibilityKey: "b".repeat(64),
  viewDigest: "c".repeat(64),
  tokenCount: 100,
  snapshotBytes: CONTEXT_SNAPSHOT_CHUNK_BYTES + 7,
  chunkBytes: CONTEXT_SNAPSHOT_CHUNK_BYTES,
  chunks: [
    { index: 0, bytes: CONTEXT_SNAPSHOT_CHUNK_BYTES, crc32c: "e3069283" },
    { index: 1, bytes: 7, crc32c: "1234abcd" },
  ],
  state: "committed" as const,
  createdAt: "2026-09-10T00:00:00.000Z",
};

describe("context snapshot manifest", () => {
  test("accepts a canonical CRC32C chunk sequence", () => {
    expect(contextSnapshotManifestSchema.parse(manifest)).toEqual(manifest);
    expect(contextSnapshotLookupKey(manifest)).toContain("qwen-worker-quality");
    expect(validateContextSnapshotIdentity(manifest, {
      ...manifest,
      maxBytes: manifest.snapshotBytes,
    })).toBe("ok");
  });

  test("rejects gaps, short intermediate chunks, byte drift, and unknown fields", () => {
    expect(contextSnapshotManifestSchema.safeParse({
      ...manifest,
      chunks: [{ ...manifest.chunks[0], index: 1 }, manifest.chunks[1]],
    }).success).toBeFalse();
    expect(contextSnapshotManifestSchema.safeParse({
      ...manifest,
      chunks: [{ ...manifest.chunks[0], bytes: 1 }, manifest.chunks[1]],
      snapshotBytes: 8,
    }).success).toBeFalse();
    expect(contextSnapshotManifestSchema.safeParse({
      ...manifest,
      snapshotBytes: manifest.snapshotBytes + 1,
    }).success).toBeFalse();
    expect(contextSnapshotManifestSchema.safeParse({ ...manifest, surprise: true }).success).toBeFalse();
  });

  test("fails identity and byte bounds closed", () => {
    expect(validateContextSnapshotIdentity(manifest, {
      ...manifest,
      release: "other-release",
      maxBytes: manifest.snapshotBytes,
    })).toBe("identity_mismatch");
    expect(validateContextSnapshotIdentity(manifest, {
      ...manifest,
      maxBytes: manifest.snapshotBytes - 1,
    })).toBe("oversize");
  });

  test("v2 binds request, view, source, attempt, and data epoch dependencies", () => {
    expect(contextSnapshotManifestSchema.safeParse({ ...manifest, schemaVersion: 2 }).success).toBe(false);
    expect(contextSnapshotManifestSchema.parse({
      ...manifest,
      schemaVersion: 2,
      dependencies: {
        requestDigest: "d".repeat(64),
        viewId: "view_1",
        attemptId: "attempt-1",
        sourceDigests: ["e".repeat(64)],
        dataEpoch: 3,
      },
    }).dependencies).toMatchObject({ viewId: "view_1", dataEpoch: 3 });
  });
});
