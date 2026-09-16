import { expect, test } from "bun:test";
import { access, mkdir, mkdtemp, open, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalContextSnapshotStore } from "./context-snapshot-store";

const expectation = {
  principalScope: "a".repeat(64),
  runtime: "qwen-worker-quality",
  release: "qwen-worker-quality-current",
  compatibilityKey: "b".repeat(64),
  viewDigest: "c".repeat(64),
};

async function committedStore(content = "123456789") {
  const root = await mkdtemp(join(tmpdir(), "larm-context-snapshot-"));
  const store = new LocalContextSnapshotStore(root, { maxBytes: 1024 * 1024, freeFloorBytes: 1 });
  await store.initialize();
  const pending = store.pendingFilename();
  await writeFile(join(root, pending), content, { mode: 0o600 });
  const manifest = await store.commitPending(pending, { ...expectation, tokenCount: 9 });
  return { root, store, manifest };
}

test("CRC32C snapshot store commits and lazily caches verified identity", async () => {
  const value = await committedStore();
  expect(value.manifest.chunks).toEqual([{ index: 0, bytes: 9, crc32c: "e3069283" }]);
  expect((await stat(join(value.root, value.store.filename(value.manifest.entryId)))).mode & 0o777).toBe(0o600);
  expect(await value.store.findAndVerify({ ...expectation, maxBytes: 1024 }))
    .toMatchObject({ hit: true, cached: true });
  const restarted = new LocalContextSnapshotStore(value.root, { maxBytes: 1024 * 1024, freeFloorBytes: 1 });
  const first = await restarted.findAndVerify({ ...expectation, maxBytes: 1024 });
  expect(first).toMatchObject({ hit: true, cached: false });
  const second = await restarted.findAndVerify({ ...expectation, maxBytes: 1024 });
  expect(second).toMatchObject({ hit: true, cached: true, verificationMs: 0 });
});

test("CRC32C snapshot store quarantines a bit flip and never returns it", async () => {
  const value = await committedStore();
  const path = join(value.root, value.store.filename(value.manifest.entryId));
  const handle = await open(path, "r+");
  try {
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, 4);
    byte[0] ^= 1;
    await handle.write(byte, 0, 1, 4);
    await handle.sync();
  } finally {
    await handle.close();
  }
  expect(await value.store.findAndVerify({ ...expectation, maxBytes: 1024 }))
    .toEqual({ hit: false, reason: "crc_mismatch" });
  expect(await value.store.findAndVerify({ ...expectation, maxBytes: 1024 }))
    .toEqual({ hit: false, reason: "not_found" });
  expect(value.store.stats().invalidEntries).toBe(1);
  expect(await value.store.usageBytes()).toBe(9);
  expect(await value.store.prune(0)).toEqual({ removedEntries: 1, removedBytes: 9 });
  expect(await value.store.usageBytes()).toBe(0);
});

test("CRC32C snapshot store rejects truncation, wrong identity, and unsafe roots", async () => {
  const value = await committedStore("snapshot fixture");
  const path = join(value.root, value.store.filename(value.manifest.entryId));
  await truncate(path, 4);
  expect(await value.store.findAndVerify({ ...expectation, maxBytes: 1024 }))
    .toEqual({ hit: false, reason: "crc_mismatch" });

  const other = await committedStore();
  expect(await other.store.findAndVerify({ ...expectation, release: "other", maxBytes: 1024 }))
    .toEqual({ hit: false, reason: "not_found" });

  const parent = await mkdtemp(join(tmpdir(), "larm-context-snapshot-link-"));
  const target = join(parent, "target");
  await mkdir(target);
  const linked = join(parent, "linked");
  await symlink(target, linked);
  await expect(new LocalContextSnapshotStore(linked, { maxBytes: 1024, freeFloorBytes: 1 }).initialize())
    .rejects.toMatchObject({ code: "snapshot_root_unsafe" });
});

test("CRC32C snapshot store invalidates a file removed after startup so it can be rebuilt", async () => {
  const value = await committedStore();
  await unlink(join(value.root, value.store.filename(value.manifest.entryId)));
  expect(await value.store.findAndVerify({ ...expectation, maxBytes: 1024 }))
    .toEqual({ hit: false, reason: "snapshot_unavailable" });
  const pending = value.store.pendingFilename();
  await writeFile(join(value.root, pending), "123456789");
  await expect(value.store.commitPending(pending, { ...expectation, tokenCount: 9 })).resolves.toBeDefined();
});

test("CRC32C snapshot store replaces a same-key entry that became corrupt", async () => {
  const value = await committedStore();
  const committedPath = join(value.root, value.store.filename(value.manifest.entryId));
  await writeFile(committedPath, "923456789");
  const pending = value.store.pendingFilename();
  await writeFile(join(value.root, pending), "123456789");
  const repaired = await value.store.commitPending(pending, { ...expectation, tokenCount: 9 });
  expect(repaired.chunks).toEqual([{ index: 0, bytes: 9, crc32c: "e3069283" }]);
  expect(await new LocalContextSnapshotStore(value.root, {
    maxBytes: 1024 * 1024,
    freeFloorBytes: 1,
  }).findAndVerify({ ...expectation, maxBytes: 1024 })).toMatchObject({ hit: true, cached: false });
});

test("CRC32C snapshot store recovers pending and orphan snapshot files after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-context-snapshot-recovery-"));
  const pending = "pending-00000000-0000-4000-8000-000000000000.bin";
  const orphan = `ctxsnap-${"d".repeat(64)}.bin`;
  const unrelated = "operator-evidence.json";
  await writeFile(join(root, pending), "partial");
  await writeFile(join(root, orphan), "orphan");
  await writeFile(join(root, unrelated), "{}\n");
  const store = new LocalContextSnapshotStore(root, { maxBytes: 1024 * 1024, freeFloorBytes: 1 });
  await store.initialize();
  await expect(access(join(root, pending))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(join(root, orphan))).rejects.toMatchObject({ code: "ENOENT" });
  await access(join(root, unrelated));
  expect(store.stats()).toMatchObject({ entries: 0, invalidEntries: 1 });
});

test("CRC32C snapshot store evicts oldest entries down to its low watermark", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-context-snapshot-prune-"));
  const store = new LocalContextSnapshotStore(root, {
    maxBytes: 30,
    freeFloorBytes: 1,
    highWatermark: 0.8,
    lowWatermark: 0.5,
  });
  await store.initialize();
  for (let index = 0; index < 2; index += 1) {
    const pending = store.pendingFilename();
    await writeFile(join(root, pending), "123456789");
    await store.commitPending(pending, {
      ...expectation,
      viewDigest: String(index).repeat(64),
      tokenCount: 9,
      createdAt: new Date(index * 1_000).toISOString(),
    });
  }
  await store.preflight(9, expectation.principalScope);
  expect(await store.usageBytes()).toBe(0);
  expect(store.stats().entries).toBe(0);
});

test("snapshot dependency deletion removes matching v2 and conservative legacy principal entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-context-snapshot-dependency-"));
  const store = new LocalContextSnapshotStore(root, { maxBytes: 1024 * 1024, freeFloorBytes: 1 });
  await store.initialize();
  const pendingV2 = store.pendingFilename();
  await writeFile(join(root, pendingV2), "123456789");
  await store.commitPending(pendingV2, {
    ...expectation,
    tokenCount: 9,
    dependencies: {
      requestDigest: "d".repeat(64),
      viewId: "view_1",
      attemptId: "attempt-1",
      sourceDigests: ["e".repeat(64)],
      dataEpoch: 2,
    },
  });
  const pendingLegacy = store.pendingFilename();
  await writeFile(join(root, pendingLegacy), "abcdefghi");
  await store.commitPending(pendingLegacy, {
    ...expectation,
    viewDigest: "f".repeat(64),
    tokenCount: 9,
  });
  expect((await store.deleteByDependency({
    principalScope: expectation.principalScope,
    sourceDigests: ["e".repeat(64)],
  })).removedEntries).toBe(2);
  expect(store.stats().entries).toBe(0);
  expect(await store.usageBytes()).toBe(0);
});

test("snapshot dependency deletion fails closed when a committed file cannot be removed", async () => {
  const value = await committedStore();
  const snapshotPath = join(value.root, value.store.filename(value.manifest.entryId));
  await unlink(snapshotPath);
  await mkdir(snapshotPath);
  await expect(value.store.deleteByDependency({
    principalScope: expectation.principalScope,
  })).rejects.toMatchObject({ code: "snapshot_io_failed" });
  expect(value.store.stats().entries).toBe(1);
});

test("snapshot dependency deletion fails closed on unattributed pending and orphan data", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-context-snapshot-unattributed-"));
  const store = new LocalContextSnapshotStore(root, { maxBytes: 1024 * 1024, freeFloorBytes: 1 });
  await store.initialize();
  const pending = store.pendingFilename();
  await writeFile(join(root, pending), "pending personal state");
  await expect(store.deleteByDependency({ principalScope: expectation.principalScope }))
    .rejects.toMatchObject({ code: "snapshot_manifest_invalid" });
  await store.discardPending(pending);

  const orphan = `ctxsnap-${"9".repeat(64)}.bin`;
  await writeFile(join(root, orphan), "orphan personal state");
  await expect(store.deleteByDependency({ principalScope: expectation.principalScope }))
    .rejects.toMatchObject({ code: "snapshot_manifest_invalid" });
});

test("snapshot dependency deletion removes only quarantined entries owned by the target principal", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-context-snapshot-quarantine-scope-"));
  const store = new LocalContextSnapshotStore(root, { maxBytes: 1024 * 1024, freeFloorBytes: 1 });
  await store.initialize();
  const otherExpectation = {
    ...expectation,
    principalScope: "d".repeat(64),
    viewDigest: "e".repeat(64),
  };
  for (const item of [expectation, otherExpectation]) {
    const pending = store.pendingFilename();
    await writeFile(join(root, pending), "123456789");
    const manifest = await store.commitPending(pending, { ...item, tokenCount: 9 });
    await writeFile(join(root, store.filename(manifest.entryId)), "923456789");
    expect(await store.findAndVerify({ ...item, maxBytes: 1024 }))
      .toEqual({ hit: false, reason: "crc_mismatch" });
  }
  expect(await store.usageBytes()).toBe(18);
  expect(await store.deleteByDependency({ principalScope: expectation.principalScope }))
    .toEqual({ removedEntries: 1, removedBytes: 9 });
  expect(await store.usageBytes()).toBe(9);
  expect(await store.deleteByDependency({ principalScope: otherExpectation.principalScope }))
    .toEqual({ removedEntries: 1, removedBytes: 9 });
  expect(await store.usageBytes()).toBe(0);
});
