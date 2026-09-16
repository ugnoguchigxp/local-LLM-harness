import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InferenceAuditStoreError,
  LocalInferenceAuditStore,
} from "./inference-audit-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: {
  now?: () => number;
  retentionMs?: number;
  maxBytes?: number;
  maxResponseBytes?: number;
  availableBytes?: () => number;
  partialGraceMs?: number;
  key?: Uint8Array;
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), "larm-audit-test-"));
  roots.push(parent);
  const root = join(parent, "records");
  const store = new LocalInferenceAuditStore({
    root,
    key: options.key ?? new Uint8Array(32).fill(7),
    minFreeBytes: 0,
    availableBytes: options.availableBytes ?? (() => 1024 * 1024 * 1024),
    ...options,
  });
  await store.initialize();
  return { root, store };
}

function beginInput(requestId: string, createdAt?: string) {
  return {
    requestId,
    allocationId: "alloc_test",
    capability: "llm.general",
    route: "llm-default",
    runtime: "qwen-general",
    runtimeRelease: "qwen38-27b",
    bootEpoch: "boot-test",
    configRevision: "revision-test",
    ...(createdAt ? { createdAt } : {}),
  };
}

test("audit store encrypts request, prompt, tokens, and bounded response", async () => {
  const { store } = await fixture({ maxResponseBytes: 8 });
  const request = new TextEncoder().encode('{"messages":[{"content":"top secret"}]}');
  const session = await store.begin(beginInput("req_capture"), request);
  await session.saveMaterialization("rendered secret", [
    { id: 10, piece: "rendered" },
    { id: 11, piece: " secret" },
  ]);
  session.captureResponse(new TextEncoder().encode("12345"));
  session.captureResponse(new TextEncoder().encode("67890"));
  await session.finalize({ outcome: "http_200", upstreamStatus: 200 });

  const record = await store.get("req_capture");
  expect(record).toMatchObject({
    status: "completed",
    outcome: "http_200",
    upstreamStatus: 200,
    requestBytes: request.byteLength,
    responseBytes: 10,
    responseTruncated: true,
    promptTokens: 2,
  });
  expect(new TextDecoder().decode(await store.readPayload(record, "request"))).toBe(
    new TextDecoder().decode(request),
  );
  expect(new TextDecoder().decode(await store.readPayload(record, "prompt"))).toBe(
    "rendered secret",
  );
  expect(new TextDecoder().decode(await store.readPayload(record, "response"))).toBe("12345678");
  const encrypted = await readFile(join(session.path, "request.json.gz.enc"));
  expect(encrypted.includes(Buffer.from("top secret"))).toBe(false);
});

test("audit prune removes completed data at the seven-day boundary", async () => {
  let now = Date.parse("2026-08-01T00:00:00.000Z");
  const { store } = await fixture({ now: () => now });
  const session = await store.begin(
    beginInput("req_expiry", new Date(now).toISOString()),
    new TextEncoder().encode("{}"),
  );
  await session.finalize({ outcome: "http_200", upstreamStatus: 200 });
  now += 7 * 24 * 60 * 60 * 1000 - 1;
  expect(await store.list()).toHaveLength(1);
  now += 1;
  expect(await store.prune()).toMatchObject({ expired: 1, remainingRecords: 0 });
  expect(await readdir(store.root)).toEqual([]);
  await expect(store.get("req_expiry")).rejects.toMatchObject({
    code: "audit_record_not_found",
  });
});

test("audit store protects active reservations and evicts completed data for a new request", async () => {
  const reserve = 129 * 1024 * 1024;
  const { store } = await fixture({
    maxBytes: reserve + 100,
    maxResponseBytes: 1,
  });
  const first = await store.begin(beginInput("req_capacity_one"), new Uint8Array(1));
  await expect(
    store.begin(beginInput("req_capacity_two"), new Uint8Array(1)),
  ).rejects.toBeInstanceOf(InferenceAuditStoreError);
  await first.finalize({ outcome: "http_200", upstreamStatus: 200 });
  const second = await store.begin(beginInput("req_capacity_two"), new Uint8Array(1));
  expect((await store.list()).map((record) => record.requestId)).toEqual(["req_capacity_two"]);
  await second.finalize({ outcome: "http_200", upstreamStatus: 200 });
});

test("audit retention cannot be configured beyond seven days", async () => {
  await expect(fixture({ retentionMs: 7 * 24 * 60 * 60 * 1000 + 1 })).rejects.toThrow(
    /bounds are invalid/,
  );
});

test("audit response capture is bounded to 64 MiB", async () => {
  await expect(fixture({ maxResponseBytes: 64 * 1024 * 1024 + 1 })).rejects.toThrow(
    /bounds are invalid/,
  );
});

test("encrypted payload authentication binds ciphertext to request identity", async () => {
  const { store } = await fixture();
  const request = new TextEncoder().encode('{"same":"plaintext"}');
  const first = await store.begin(beginInput("req_aad_one"), request);
  await first.finalize({ outcome: "http_200", upstreamStatus: 200 });
  const second = await store.begin(beginInput("req_aad_two"), request);
  await second.finalize({ outcome: "http_200", upstreamStatus: 200 });
  const firstRecord = await store.get("req_aad_one");
  const secondRecord = await store.get("req_aad_two");
  await copyFile(
    join(first.path, "request.json.gz.enc"),
    join(second.path, "request.json.gz.enc"),
  );
  const forged = {
    ...secondRecord,
    payloads: { ...secondRecord.payloads, request: firstRecord.payloads.request },
  };
  await expect(store.readPayload(forged, "request")).rejects.toMatchObject({
    code: "audit_payload_corrupt",
  });
});

test("same-process active sessions survive prune and restart recovery marks them interrupted", async () => {
  let now = Date.parse("2026-08-01T00:00:00.000Z");
  const key = new Uint8Array(32).fill(4);
  const { root, store } = await fixture({
    now: () => now,
    partialGraceMs: 10,
    key,
  });
  const session = await store.begin(
    beginInput("req_recovery", new Date(now).toISOString()),
    new TextEncoder().encode("{}"),
  );
  now += 11;
  expect((await store.prune()).interrupted).toBe(0);
  expect((await store.get("req_recovery")).status).toBe("active");

  const restarted = new LocalInferenceAuditStore({
    root,
    key,
    minFreeBytes: 0,
    availableBytes: () => 1024 * 1024 * 1024,
    partialGraceMs: 10,
    now: () => now,
  });
  expect((await restarted.prune()).interrupted).toBe(1);
  expect(await restarted.get("req_recovery")).toMatchObject({
    status: "interrupted",
    outcome: "daemon_interrupted",
  });
  await session.finalize({ outcome: "http_200", upstreamStatus: 200 });
});

test("prune preserves committed completion when its active marker survived a crash", async () => {
  const { store } = await fixture();
  const session = await store.begin(
    beginInput("req_committed_recovery"),
    new TextEncoder().encode("{}"),
  );
  await session.finalize({ outcome: "http_200", upstreamStatus: 200 });
  await writeFile(join(session.path, "active"), "", { mode: 0o600 });

  expect(await store.prune()).toMatchObject({ interrupted: 0 });
  expect(await store.get("req_committed_recovery")).toMatchObject({
    status: "completed",
    outcome: "http_200",
  });
});

test("store rejects broadened record permissions", async () => {
  const { store } = await fixture();
  const session = await store.begin(beginInput("req_permissions"), new TextEncoder().encode("{}"));
  await session.finalize({ outcome: "http_200", upstreamStatus: 200 });
  await chmod(join(session.path, "metadata.json"), 0o644);
  await expect(store.list()).rejects.toMatchObject({ code: "audit_record_corrupt" });
});

test("Personal State dependency erasure removes only matching terminal audit payloads", async () => {
  const { store } = await fixture();
  const personalState = {
    subjectDigest: "a".repeat(64),
    attemptId: "attempt-1",
    viewId: "view_1",
    requestDigest: "b".repeat(64),
    sourceDigests: ["c".repeat(64)],
    dataEpoch: 4,
  };
  const matching = await store.begin(
    { ...beginInput("req_personal"), personalState },
    new TextEncoder().encode('{"secret":true}'),
  );
  await matching.finalize({ outcome: "http_200", upstreamStatus: 200 });
  const other = await store.begin(
    { ...beginInput("req_other"), personalState: { ...personalState, attemptId: "attempt-2" } },
    new TextEncoder().encode("{}"),
  );
  await other.finalize({ outcome: "http_200", upstreamStatus: 200 });

  expect(await store.erasePersonalState({
    subjectDigest: personalState.subjectDigest,
    attemptIds: ["attempt-1"],
  })).toEqual({ removed: 1, active: 0 });
  expect(await store.personalStateAbsent({
    subjectDigest: personalState.subjectDigest,
    attemptIds: ["attempt-1"],
  })).toBe(true);
  expect((await store.list()).map((record) => record.requestId)).toEqual(["req_other"]);
});

test("Personal State erasure fails closed on an unattributed partial audit record", async () => {
  const { root, store } = await fixture();
  const orphan = join(root, "2026", "09", "13", "00", "req_orphan");
  await mkdir(orphan, { recursive: true, mode: 0o700 });
  await writeFile(join(orphan, "request.json.gz.enc"), "orphan payload", { mode: 0o600 });
  await expect(store.erasePersonalState({ subjectDigest: "a".repeat(64) }))
    .rejects.toMatchObject({ code: "audit_record_corrupt" });
  await expect(store.personalStateAbsent({ subjectDigest: "a".repeat(64) }))
    .rejects.toMatchObject({ code: "audit_record_corrupt" });
});
