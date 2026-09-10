import { describe, expect, test } from "bun:test";
import {
  contextCertificationSchema,
  contextCompatibilityKey,
  deriveContextActivation,
  managedContextPolicySchema,
  planActiveContextView,
  type ContextCertification,
  type ContextDescriptor,
  type ManagedContextPolicy,
} from "./context";

const digest = (value: string) => value.repeat(64).slice(0, 64);

const policy: ManagedContextPolicy = managedContextPolicySchema.parse({
  class: "managed-context",
  activation: "when-hosted",
  sourceTokenLimit: 20_000_000,
  materializedRetentionTargetTokens: 20_000_000,
  outputReserveTokens: 100,
  safetyMarginTokens: 20,
  ramCacheMaxBytes: 1024,
  nvmeCacheMaxBytes: 2048,
  filesystemFreeFloorBytes: 512,
  cacheHighWatermark: 0.9,
  cacheLowWatermark: 0.8,
  operationTimeoutMs: 1000,
  allowedModes: ["source-rebuild"],
});

const certification: ContextCertification = contextCertificationSchema.parse({
  profile: "test-v1",
  modelArtifactDigest: digest("a"),
  tokenizerDigest: digest("b"),
  chatTemplateDigest: digest("c"),
  engineBuild: "test-engine",
  providerConfigRevision: "test-provider-v1",
  contextLimitTokens: 1000,
  verifiedModes: ["source-rebuild"],
  evidenceDigest: digest("d"),
});

function descriptor(id: string, tokenCount: number): ContextDescriptor {
  return {
    schemaVersion: 1,
    id,
    version: "v1",
    sourceHandle: `${id}-source`,
    sourceDigest: digest(id[0] ?? "e"),
    classification: "internal",
    byteCount: 100,
    tokenCount,
    tokenizerDigest: certification.tokenizerDigest,
    principal: "principal",
    state: "active",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  };
}

describe("managed context policy", () => {
  test("requires source rebuild and ordered watermarks", () => {
    expect(managedContextPolicySchema.safeParse({
      ...policy,
      allowedModes: ["session-snapshot"],
      cacheLowWatermark: 0.95,
    }).success).toBe(false);
  });

  test("requires state identity for persisted modes", () => {
    expect(contextCertificationSchema.safeParse({
      ...certification,
      verifiedModes: ["source-rebuild", "session-snapshot"],
    }).success).toBe(false);
  });
});

describe("active context planning", () => {
  test("selects required then highest utility optional within the exact budget", () => {
    const result = planActiveContextView({
      policy,
      certification,
      baseInputTokens: 100,
      maxInputTokens: 800,
      canonicalizationVersion: "context-view-v1",
      candidates: [
        { plan: { contextId: "optional-low", version: "v1", required: false, utility: 0.1 }, descriptor: descriptor("optional-low", 300) },
        { plan: { contextId: "required", version: "v1", required: true, utility: 0 }, descriptor: descriptor("required", 200) },
        { plan: { contextId: "optional-high", version: "v1", required: false, utility: 0.9 }, descriptor: descriptor("optional-high", 300) },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.inputBudgetTokens).toBe(800);
    expect(result.tokenCount).toBe(600);
    expect(result.orderedItems.map((item) => item.contextId)).toEqual(["required", "optional-high"]);
    expect(result.omitted).toEqual([{ contextId: "optional-low", version: "v1", reason: "budget" }]);
  });

  test("fails closed when required context exceeds the budget", () => {
    const result = planActiveContextView({
      policy,
      certification,
      baseInputTokens: 700,
      maxInputTokens: 800,
      canonicalizationVersion: "context-view-v1",
      candidates: [{
        plan: { contextId: "required", version: "v1", required: true, utility: 1 },
        descriptor: descriptor("required", 101),
      }],
    });
    expect(result).toEqual({
      ok: false,
      reason: "context_budget_exceeded",
      inputBudgetTokens: 800,
      requiredTokens: 801,
    });
  });

  test("is deterministic for candidate input order", () => {
    const candidates = [
      { plan: { contextId: "b", version: "v1", required: false, utility: 0.5 }, descriptor: descriptor("b", 10) },
      { plan: { contextId: "a", version: "v1", required: false, utility: 0.5 }, descriptor: descriptor("a", 10) },
    ];
    const plan = (input: typeof candidates) => planActiveContextView({
      policy,
      certification,
      baseInputTokens: 0,
      maxInputTokens: 800,
      canonicalizationVersion: "context-view-v1",
      candidates: input,
    });
    expect(plan(candidates)).toEqual(plan([...candidates].reverse()));
  });
});

test("compatibility key changes with release or principal", () => {
  const first = contextCompatibilityKey({ release: "release-a", certification, principalScope: "p1" });
  expect(first).not.toBe(contextCompatibilityKey({ release: "release-b", certification, principalScope: "p1" }));
  expect(first).not.toBe(contextCompatibilityKey({ release: "release-a", certification, principalScope: "p2" }));
});

test("activation is lifecycle and certification gated", () => {
  const common = {
    enabled: true,
    policy,
    reasoningCapable: true,
    certification,
    activeRelease: "release-a",
    observationFresh: true,
    probeOk: true,
    draining: false,
  } as const;
  expect(deriveContextActivation({ ...common, runtimeStatus: "COLD" }).state).toBe("STANDBY");
  expect(deriveContextActivation({ ...common, runtimeStatus: "HOT" }).state).toBe("ACTIVE");
  expect(deriveContextActivation({ ...common, runtimeStatus: "BUSY" }).state).toBe("BUSY");
  expect(deriveContextActivation({ ...common, runtimeStatus: "HOT", observationFresh: false }).state).toBe("DEGRADED");
  expect(deriveContextActivation({ ...common, enabled: false, runtimeStatus: "HOT" }).state).toBe("DISABLED");
});
