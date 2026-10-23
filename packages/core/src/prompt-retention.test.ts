import { expect, test } from "bun:test";
import { promptRetentionPolicySchema, promptRetentionMemoryGB, promptRetentionContextSchema, runtimeMemoryGB } from "./prompt-retention";

test("retention has bounded memory including staging and metadata", () => {
  const policy = promptRetentionPolicySchema.parse({});
  expect(policy.maxBytes).toBe(8 * 1024 ** 3);
  expect(promptRetentionMemoryGB(policy)).toBe(9.0625);
  expect(runtimeMemoryGB({ resources: { estimatedMemoryGB: 56 }, promptRetention: policy })).toBe(65.0625);
  expect(policy.idleTtlMs).toBe(300_000);
  expect(policy.maxAgeMs).toBe(1_800_000);
  for (const invalid of [{ maxBytes: 1 }, { entryMaxBytes: 5 * 1024 ** 3 }, { principalMaxEntries: 65 }, { idleTtlMs: 2_000_000 }]) {
    expect(promptRetentionPolicySchema.safeParse(invalid).success).toBe(false);
  }
});

test("internal cache metadata accepts opaque IDs and bounded lease only", () => {
  const context = { owner: "a".repeat(64), scope: "b".repeat(64), instance: "c".repeat(64), correlation: "d".repeat(64), leaseMs: 300_000 };
  expect(promptRetentionContextSchema.safeParse(context).success).toBe(true);
  for (const invalid of [{ ...context, scope: "client-selected-session" }, { ...context, leaseMs: 300_001 }, { ...context, id_slot: 1 }]) {
    expect(promptRetentionContextSchema.safeParse(invalid).success).toBe(false);
  }
});
