import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalUsageRetentionStore } from "./usage-retention-store";

test("retention metadata is bounded, coalesced, atomic and contains no credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-retention-"));
  try {
    const path = join(root, "retention.json");
    const store = new LocalUsageRetentionStore(path);
    expect(await store.load()).toBeUndefined();
    store.save({ version: 1, catalogRevision: "rev", runtimeIds: ["first"], protectedConsumer: true });
    store.save({ version: 1, catalogRevision: "rev", runtimeIds: ["last"], protectedConsumer: false });
    await store.flush();
    expect(await store.load()).toEqual({ version: 1, catalogRevision: "rev", runtimeIds: ["last"], protectedConsumer: false });
    expect(store.failed).toBe(false);
    expect(await readFile(path, "utf8")).not.toContain("token");
    await writeFile(path, "x".repeat(16_385));
    await expect(store.load()).rejects.toThrow();
    expect(store.failed).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the latest retention intent wins when reverting an in-flight save", async () => {
  const root = await mkdtemp(join(tmpdir(), "larm-retention-revert-"));
  try {
    const store = new LocalUsageRetentionStore(join(root, "retention.json"));
    const original = { version: 1 as const, catalogRevision: "rev", runtimeIds: ["original"], protectedConsumer: true };
    store.save(original);
    await store.flush();
    store.save({ ...original, runtimeIds: ["replacement"], protectedConsumer: false });
    store.save(original);
    await store.flush();
    expect(await store.load()).toEqual(original);
    expect(store.failed).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
