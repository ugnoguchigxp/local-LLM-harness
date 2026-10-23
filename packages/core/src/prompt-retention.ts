import { z } from "zod";

const bytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const promptRetentionPolicySchema = z.object({
  protocol: z.literal("larm-prompt-cache.v1").default("larm-prompt-cache.v1"),
  maxBytes: bytes.default(8 * 1024 ** 3),
  principalMaxBytes: bytes.default(4 * 1024 ** 3),
  entryMaxBytes: bytes.default(1024 ** 3),
  stagingMaxBytes: bytes.default(1024 ** 3),
  metadataMaxBytes: bytes.default(64 * 1024 ** 2),
  maxEntries: z.number().int().min(1).max(4096).default(64),
  principalMaxEntries: z.number().int().min(1).max(4096).default(16),
  idleTtlMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  maxAgeMs: z.number().int().min(1000).max(86_400_000).default(1_800_000),
}).strict().superRefine((p, c) => {
  if (p.entryMaxBytes > p.principalMaxBytes || p.principalMaxBytes > p.maxBytes
    || p.entryMaxBytes > p.stagingMaxBytes || p.principalMaxEntries > p.maxEntries
    || p.idleTtlMs > p.maxAgeMs) c.addIssue({ code: "custom", message: "inconsistent prompt retention bounds" });
});
export type PromptRetentionPolicy = z.infer<typeof promptRetentionPolicySchema>;

/** Additional reservation, separate from weights, active KV and active checkpoints. */
export function promptRetentionMemoryGB(policy: PromptRetentionPolicy): number {
  // The existing resource planner's GB values are binary GiB.
  return (policy.maxBytes + policy.stagingMaxBytes + policy.metadataMaxBytes) / 1024 ** 3;
}
export function runtimeMemoryGB(runtime: { resources: { estimatedMemoryGB: number }; promptRetention?: PromptRetentionPolicy }): number {
  return runtime.resources.estimatedMemoryGB + (runtime.promptRetention ? promptRetentionMemoryGB(runtime.promptRetention) : 0);
}

const opaque = z.string().regex(/^[a-f0-9]{64}$/);
export const promptRetentionContextSchema = z.object({
  owner: opaque, scope: opaque, instance: opaque, correlation: opaque,
  leaseMs: z.number().int().min(1).max(300_000),
}).strict();
export type PromptRetentionContext = z.infer<typeof promptRetentionContextSchema>;
