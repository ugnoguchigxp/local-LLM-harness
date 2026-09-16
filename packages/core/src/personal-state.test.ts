import { describe, expect, test } from "bun:test";
import {
  bindContextViewDigest,
  forgetIsComplete,
  forgetOperationSchema,
  forgetRequestSchema,
  personalStateCapabilitySchema,
  personalStateDigest,
  personalStateSourceHandle,
  personalStateSubjectDigest,
} from "./personal-state";

const digest = "a".repeat(64);
const now = "2026-09-13T00:00:00.000Z";

describe("Personal State contracts", () => {
  test("canonical request digests ignore object key insertion order but preserve arrays", () => {
    expect(personalStateDigest({ tools: [{ b: 2, a: 1 }], messages: ["a", "b"] }))
      .toBe(personalStateDigest({ messages: ["a", "b"], tools: [{ a: 1, b: 2 }] }));
    expect(personalStateDigest({ messages: ["a", "b"] }))
      .not.toBe(personalStateDigest({ messages: ["b", "a"] }));
  });

  test("subject, source, and view bindings are domain separated", () => {
    const subject = personalStateSubjectDigest("principal-a");
    expect(subject).toHaveLength(64);
    expect(subject).not.toBe(personalStateSubjectDigest("principal-b"));
    expect(personalStateSourceHandle({
      subjectDigest: subject,
      incarnation: "inc-1",
      sourceDigest: digest,
    })).toMatch(/^ps_[a-f0-9]{48}$/);
    expect(bindContextViewDigest(digest, "b".repeat(64))).not.toBe(digest);
  });

  test("capability scopes are exhaustive rather than duplicate padding", () => {
    expect(personalStateCapabilitySchema.safeParse({
      contractVersion: "larm-personal-state.v1",
      bootEpoch: "11111111-1111-4111-8111-111111111111",
      subjectDigest: digest,
      allocationId: "allocation-1",
      runtime: "runtime-1",
      release: "release-1",
      leaseEpoch: 1,
      leaseExpiresAt: "2026-09-13T00:10:00.000Z",
      credentialExpiresAt: "2026-09-13T00:10:00.000Z",
      tokenizerDigest: "b".repeat(64),
      chatTemplateDigest: "c".repeat(64),
      contextLimitTokens: 100,
      outputReserveTokens: 10,
      safetyMarginTokens: 1,
      sourceTokenLimit: 100,
      maxSourceBytes: 1_024,
      maxTotalSourceBytes: 4_096,
      maxMaterializedBytes: 1_024,
      scopes: Array.from({ length: 7 }, () => "context.operation.read"),
    }).success).toBe(false);
  });

  test("forget succeeds only when every named phase proves absence", () => {
    const phases = Object.fromEntries([
      "attempts", "views", "runtime", "snapshots", "registry", "sources", "audit",
    ].map((name) => [name, { state: "absent", updatedAt: now, affected: 0 }]));
    const operation = forgetOperationSchema.parse({
      contractVersion: "larm-personal-state.v1",
      forgetId: "forget-1",
      operationId: "psop_1",
      subjectDigest: digest,
      requestDigest: "b".repeat(64),
      targets: { contextIds: ["ctx"], sourceHandles: [], attemptIds: [] },
      fenceEpoch: 1,
      state: "succeeded",
      phases,
      absenceVerified: true,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      expiresAt: "2026-09-14T00:00:00.000Z",
    });
    expect(forgetIsComplete(operation)).toBe(true);
    operation.phases.audit.state = "stop_unknown";
    expect(forgetIsComplete(operation)).toBe(false);
  });

  test("forget targets reject duplicate logical dependencies", () => {
    expect(forgetRequestSchema.safeParse({
      forgetId: "forget-duplicates",
      contextIds: ["context-1", "context-1"],
    }).success).toBe(false);
    expect(forgetRequestSchema.safeParse({
      forgetId: "forget-unique",
      contextIds: ["context-1"],
      sourceHandles: ["source-1"],
      attemptIds: ["attempt-1"],
    }).success).toBe(true);
  });
});
