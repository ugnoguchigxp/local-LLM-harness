import { expect, test } from "bun:test";
import {
  inferenceAuditExpired,
  inferenceAuditModeSchema,
  inferenceAuditRecordSchema,
} from "./inference-audit";

test("inference audit contract accepts strict encrypted metadata", () => {
  const record = inferenceAuditRecordSchema.parse({
    version: 1,
    requestId: "req_test",
    allocationId: "alloc_test",
    protocol: "openai.chat-completions.v1",
    capability: "llm.general",
    route: "llm-default",
    runtime: "qwen-general",
    bootEpoch: "boot-test",
    configRevision: "revision-test",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-08T00:00:00.000Z",
    status: "active",
    requestBytes: 2,
    payloads: {},
  });
  expect(record.responseBytes).toBe(0);
  expect(inferenceAuditExpired(record, Date.parse(record.expiresAt))).toBe(true);
  expect(inferenceAuditModeSchema.parse("full-required")).toBe("full-required");
  expect(() => inferenceAuditRecordSchema.parse({ ...record, plaintext: "secret" })).toThrow();
  expect(() => inferenceAuditRecordSchema.parse({
    ...record,
    expiresAt: "2026-08-08T00:00:00.001Z",
  })).toThrow(/seven days/);
  expect(() => inferenceAuditRecordSchema.parse({
    ...record,
    status: "completed",
  })).toThrow(/terminal records/);
  expect(() => inferenceAuditRecordSchema.parse({
    ...record,
    requestBytes: 3,
    payloads: {
      request: {
        file: "request.json.gz.enc",
        plainBytes: 2,
        storedBytes: 48,
        sha256: "a".repeat(64),
        encoding: "gzip+aes-256-gcm",
        keyId: "b".repeat(16),
      },
    },
  })).toThrow(/request payload size/);
  expect(() => inferenceAuditRecordSchema.parse({
    ...record,
    createdAt: "2026-08-01T00:00:00Z",
  })).toThrow(/canonical ISO-8601/);
  expect(() => inferenceAuditRecordSchema.parse({
    ...record,
    upstreamStatus: 200,
  })).toThrow(/terminal fields/);
  expect(() => inferenceAuditRecordSchema.parse({
    ...record,
    requestBytes: 2,
    payloads: {
      request: {
        file: "prompt.txt.gz.enc",
        plainBytes: 2,
        storedBytes: 48,
        sha256: "a".repeat(64),
        encoding: "gzip+aes-256-gcm",
        keyId: "b".repeat(16),
      },
    },
  })).toThrow(/wrong file/);
  expect(inferenceAuditRecordSchema.parse({
    ...record,
    status: "completed",
    completedAt: "2026-08-01T00:01:00.000Z",
    outcome: "http_200",
    responseBytes: 10,
    responseTruncated: true,
    payloads: {
      request: {
        file: "request.json.gz.enc",
        plainBytes: 2,
        storedBytes: 48,
        sha256: "a".repeat(64),
        encoding: "gzip+aes-256-gcm",
        keyId: "b".repeat(16),
      },
    },
  }).responseTruncated).toBe(true);
});
