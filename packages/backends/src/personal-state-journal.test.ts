import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalPersonalStateJournal } from "./personal-state-journal";

const digest = "a".repeat(64);
const subjectDigest = "b".repeat(64);
const now = "2026-09-13T00:00:00.000Z";

test("personal state receipts and tombstone epochs survive daemon restart", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-personal-state-"));
  const root = join(parent, "journal");
  try {
    const first = new LocalPersonalStateJournal(root);
    await first.initialize();
    const firstBoot = await first.bootEpoch();
    await first.saveProvision({
      contractVersion: "larm-personal-state.v1",
      operationId: "psop_source",
      incarnation: "inc-1",
      subjectDigest,
      allocationId: "alloc_test",
      runtime: "runtime-a",
      release: "release-a",
      sourceHandle: "ps_source",
      sourceDigest: digest,
      byteCount: 4,
      tokenCount: 2,
      tokenizerDigest: "c".repeat(64),
      chatTemplateDigest: "d".repeat(64),
      leaseEpoch: 1,
      dataEpoch: 0,
      state: "succeeded",
      createdAt: now,
      updatedAt: now,
      expiresAt: "2026-09-14T00:00:00.000Z",
    });
    await first.saveView({
      contractVersion: "larm-personal-state.v1",
      viewRequestId: "view-request-1",
      subjectDigest,
      requestDigest: "e".repeat(64),
      planDigest: "f".repeat(64),
      idempotencyKeyDigest: "1".repeat(64),
      viewId: "view-1",
      operationId: "ctxop-1",
      allocationId: "alloc_test",
      runtime: "runtime-a",
      release: "release-a",
      bootEpoch: firstBoot,
      dataEpoch: 0,
      state: "ready",
      createdAt: now,
      updatedAt: now,
      expiresAt: "2026-09-14T00:00:00.000Z",
    });
    const begun = await first.beginForget({
      subjectDigest,
      request: {
        forgetId: "forget-1",
        incarnation: "inc-1",
        contextIds: [],
        sourceHandles: [],
        attemptIds: [],
      },
      operationId: "psop_forget",
      now,
      expiresAt: "2026-09-14T00:00:00.000Z",
    });
    expect(begun.operation.fenceEpoch).toBe(1);
    await first.saveForget({
      ...begun.operation,
      state: "running",
      phases: Object.fromEntries(Object.keys(begun.operation.phases).map((phase) => [
        phase,
        { state: "absent", updatedAt: now, affected: 0 },
      ])) as typeof begun.operation.phases,
      absenceVerified: true,
      updatedAt: now,
    });
    expect(await first.isForgotten({ subjectDigest, incarnation: "inc-1" })).toBe(true);

    const second = new LocalPersonalStateJournal(root);
    await second.initialize();
    expect(await second.bootEpoch()).not.toBe(firstBoot);
    expect((await second.provision(subjectDigest, "inc-1"))?.sourceHandle).toBe("ps_source");
    expect(await second.view(subjectDigest, "view-request-1")).toMatchObject({
      viewId: "view-1",
      state: "invalid",
    });
    expect(await second.currentEpoch(subjectDigest)).toBe(1);
    expect((await second.beginForget({
      subjectDigest,
      request: {
        forgetId: "forget-1",
        incarnation: "inc-1",
        contextIds: [],
        sourceHandles: [],
        attemptIds: [],
      },
      operationId: "ignored",
      now,
      expiresAt: "2026-09-14T00:00:00.000Z",
    })).replay).toBe(true);
    await second.prune(Date.parse("2026-09-15T00:00:00.000Z"));
    expect(await second.provision(subjectDigest, "inc-1")).toBeUndefined();
    expect(await second.forget(subjectDigest, "forget-1")).toBeUndefined();
    expect(await second.isForgotten({ subjectDigest, incarnation: "inc-1" })).toBe(true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("journal rejects reusing an incarnation for different content", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-personal-state-"));
  const journal = new LocalPersonalStateJournal(join(parent, "journal"));
  try {
    const base = {
      contractVersion: "larm-personal-state.v1" as const,
      operationId: "psop_source",
      incarnation: "inc-1",
      subjectDigest,
      allocationId: "alloc_test",
      runtime: "runtime-a",
      release: "release-a",
      sourceHandle: "ps_source",
      sourceDigest: digest,
      byteCount: 4,
      tokenCount: 2,
      tokenizerDigest: "c".repeat(64),
      chatTemplateDigest: "d".repeat(64),
      leaseEpoch: 1,
      dataEpoch: 0,
      state: "succeeded" as const,
      createdAt: now,
      updatedAt: now,
      expiresAt: "2026-09-14T00:00:00.000Z",
    };
    await journal.saveProvision(base);
    await expect(journal.saveProvision({ ...base, sourceDigest: "e".repeat(64) }))
      .rejects.toMatchObject({ code: "personal_state_conflict" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("measurement IDs are isolated by Personal State subject", async () => {
  const parent = await mkdtemp(join(tmpdir(), "larm-personal-state-"));
  const journal = new LocalPersonalStateJournal(join(parent, "journal"));
  try {
    const measurement = {
      contractVersion: "larm-personal-state.v1" as const,
      measurementId: "shared-client-id",
      subjectDigest,
      allocationId: "alloc_test",
      runtime: "runtime-a",
      release: "release-a",
      requestDigest: "c".repeat(64),
      baseInputTokens: 2,
      maxInputTokens: 100,
      tokenizerDigest: "d".repeat(64),
      chatTemplateDigest: "e".repeat(64),
      leaseEpoch: 1,
      dataEpoch: 0,
      createdAt: now,
      expiresAt: "2026-09-14T00:00:00.000Z",
    };
    const otherSubject = "f".repeat(64);
    await journal.saveMeasurement(measurement);
    await journal.saveMeasurement({ ...measurement, subjectDigest: otherSubject });
    expect(await journal.measurement(subjectDigest, measurement.measurementId)).toBeDefined();
    expect(await journal.measurement(otherSubject, measurement.measurementId)).toBeDefined();
    expect((await journal.snapshot()).measurements).toHaveLength(2);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
