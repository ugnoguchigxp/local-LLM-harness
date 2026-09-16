import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Allocation,
  type ClusterState,
  type Registry,
  type RuntimeReleaseDefinition,
} from "@larm/core";
import {
  LocalContextMetadataStore,
  LocalContextSourceStore,
} from "@larm/backends";
import { ContextController } from "./context-controller";

const tokenizerDigest = "b".repeat(64);
const runtime: Registry["runtimes"][number] = {
  id: "qwen-general",
  artifacts: ["model"],
  capability: ["llm.general", "llm.reasoning"],
  protocol: "openai.chat-completions.v1",
  backend: "systemd",
  node: "node",
  policy: { class: "resident" },
  context: {
    class: "managed-context",
    activation: "when-hosted",
    sourceTokenLimit: 20_000_000,
    outputReserveTokens: 100,
    safetyMarginTokens: 20,
    filesystemFreeFloorBytes: 256 * 1024 ** 3,
    operationTimeoutMs: 600_000,
    allowedModes: ["source-rebuild"],
  },
  resources: {
    estimatedMemoryGB: 40,
    maxConcurrentRequests: 1,
    maxQueuedRequests: 1,
    queueTimeoutMs: 1000,
  },
  deployment: {
    service: "llama-server.service",
    healthPort: 8080,
    endpoint: "http://127.0.0.1:8080",
  },
};
const registry: Registry = {
  nodes: [{
    id: "node",
    endpoint: "http://127.0.0.1",
    resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
  }],
  runtimes: [runtime],
  profiles: [],
  routes: [],
};
const release: RuntimeReleaseDefinition = {
  id: "qwen-general-current",
  runtime: runtime.id,
  artifacts: ["model"],
  providerConfigRevision: "provider-v1",
  estimatedMemoryGB: 40,
  healthPath: "/health",
  default: true,
  digest: "e".repeat(64),
  contextCertification: {
    profile: "qwen-context-v1",
    modelArtifactDigest: "a".repeat(64),
    tokenizerDigest,
    chatTemplateDigest: "c".repeat(64),
    engineBuild: "engine-v1",
    providerConfigRevision: "provider-v1",
    contextLimitTokens: 1000,
    verifiedModes: ["source-rebuild"],
    evidenceDigest: "d".repeat(64),
  },
};

async function fixture(options: {
  chatTokens?: number;
  identityMatches?: boolean;
  countChatTokens?: (signal?: AbortSignal) => Promise<number>;
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), "larm-context-controller-"));
  const source = new LocalContextSourceStore(join(parent, "sources"));
  const principal = "principal-a";
  const provisioned = await source.provision(
    principal,
    "source-a",
    "trusted facts",
    1024,
    [{ tokenizerDigest, tokenCount: 20 }],
  );
  let now = Date.parse("2026-09-09T00:00:00.000Z");
  let status: ClusterState["runtimes"][number]["status"] = "HOT";
  const fixtureRuntime = structuredClone(runtime);
  const fixtureRelease = structuredClone(release);
  const fixtureRegistry = { ...registry, runtimes: [fixtureRuntime] };
  const state = (): ClusterState => ({
    generatedAt: new Date(now).toISOString(),
    node: {
      id: "node",
      online: true,
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
    },
    runtimes: [{
      id: fixtureRuntime.id,
      status,
      class: "resident",
      capability: fixtureRuntime.capability,
      node: "node",
      backend: "systemd",
      endpoint: fixtureRuntime.deployment.endpoint,
      service: "llama-server.service",
      observedAt: new Date(now).toISOString(),
      health: { ok: true },
    }],
  });
  const allocation: Allocation = {
    id: "alloc_test",
    bootEpoch: "boot",
    status: "ready",
    requirements: [{ capability: "llm.reasoning", route: "route" }],
    bindings: [{
      capability: "llm.reasoning",
      route: "route",
      runtime: fixtureRuntime.id,
      node: "node",
      endpoint: fixtureRuntime.deployment.endpoint,
      status: "HOT",
      candidateRank: 1,
      fallback: false,
      selectionReason: "test",
      release: fixtureRelease.id,
    }],
    allowFallback: false,
    deploymentPolicy: "existing-only",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  };
  let randomSequence = 0;
  const controller = new ContextController({
    enabled: true,
    registry: fixtureRegistry,
    releases: [fixtureRelease],
    metadataStore: new LocalContextMetadataStore(join(parent, "metadata")),
    sourceProvider: source,
    tokenizer: {
      identity: async () => ({
        engineBuild: "engine-v1",
        contextLimitTokens: 1000,
        chatTemplateDigest: options.identityMatches === false
          ? "f".repeat(64)
          : fixtureRelease.contextCertification!.chatTemplateDigest,
        tokenizerDigest,
      }),
      countChatTokens: async (_endpoint, _request, signal) => options.countChatTokens
        ? await options.countChatTokens(signal)
        : options.chatTokens ?? 100,
    },
    getState: state,
    getAllocation: (id) => id === allocation.id ? allocation : undefined,
    getActiveRelease: () => fixtureRelease.id,
    isDraining: () => false,
    stateMaxAgeMs: 10_000,
    sourceMaxBytes: 1024,
    sourceMaxTotalBytes: 1024 * 1024,
    materializedMaxBytes: 4096,
    idempotencyTtlMs: 300_000,
    idempotencyLimit: 100,
    now: () => now,
    random: () => `fixed-${randomSequence += 1}`,
  });
  await controller.initialize();
  await controller.refreshRuntimeProbes();
  return {
    controller,
    source,
    principal,
    provisioned,
    allocation,
    runtime: fixtureRuntime,
    release: fixtureRelease,
    setStatus: (value: typeof status) => { status = value; },
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

test("context lifecycle is active only while the certified runtime is hosted", async () => {
  const value = await fixture();
  expect(value.controller.statuses().state).toBe("ACTIVE");
  expect(value.controller.statuses().runtimes[0]?.state).toBe("ACTIVE");
  value.setStatus("BUSY");
  expect(value.controller.statuses().state).toBe("BUSY");
  value.setStatus("COLD");
  expect(value.controller.statuses().state).toBe("STANDBY");
  expect(value.controller.statuses().runtimes[0]?.state).toBe("STANDBY");
  value.setStatus("FAILED");
  expect(value.controller.statuses().runtimes[0]?.state).toBe("DEGRADED");
});

test("live context identity mismatch never activates the runtime", async () => {
  const value = await fixture({ identityMatches: false });
  expect(value.controller.statuses().runtimes[0]).toMatchObject({
    state: "STARTING",
    reason: "context_probe_identity_mismatch",
  });
});

test("source set accepts exactly 20M tokens and rejects the next token", async () => {
  const value = await fixture();
  const capacitySource = await value.source.provision(
    value.principal,
    "source-capacity",
    "capacity fixture",
    1024,
    [{ tokenizerDigest, tokenCount: 20_000_000 }],
  );
  await value.controller.register({
    id: "ctx-capacity",
    version: "v1",
    sourceHandle: "source-capacity",
    sourceDigest: capacitySource.digest,
    classification: "internal",
    byteCount: capacitySource.bytes,
    tokenCount: 20_000_000,
    tokenizerDigest,
  }, value.principal, "register-capacity");
  const extra = await value.source.provision(
    value.principal,
    "source-extra",
    "one more token",
    1024,
    [{ tokenizerDigest, tokenCount: 1 }],
  );
  await expect(value.controller.register({
    id: "ctx-extra",
    version: "v1",
    sourceHandle: "source-extra",
    sourceDigest: extra.digest,
    classification: "internal",
    byteCount: extra.bytes,
    tokenCount: 1,
    tokenizerDigest,
  }, value.principal, "register-extra")).rejects.toMatchObject({
    code: "context_source_limit_exceeded",
  });
});

test("registered source is planned, materialized once, and bound to the lifecycle epoch", async () => {
  const value = await fixture();
  const registration = {
    id: "ctx-a",
    version: "v1",
    sourceHandle: "source-a",
    sourceDigest: value.provisioned.digest,
    classification: "internal" as const,
    byteCount: value.provisioned.bytes,
    tokenCount: 20,
    tokenizerDigest,
  };
  expect((await value.controller.register(registration, value.principal, "register-1")).replay)
    .toBeFalse();
  expect((await value.controller.register(registration, value.principal, "register-1")).replay)
    .toBeTrue();
  await expect(value.controller.register({
    ...registration,
    sourceDigest: "f".repeat(64),
  }, value.principal, "register-conflict")).rejects.toMatchObject({
    code: "context_version_conflict",
  });
  const created = await value.controller.createView({
    allocationId: value.allocation.id,
    runtime: runtime.id,
    baseInputTokens: 10,
    maxInputTokens: 800,
    deadline: "2026-09-09T00:05:00.000Z",
    canonicalizationVersion: "context-view-v1",
    items: [{ contextId: "ctx-a", version: "v1", required: true, utility: 1 }],
  }, value.principal, "view-1");
  expect(created.view.tokenCount).toBe(30);
  expect(value.controller.getOperation(value.principal, created.view.operationId).state).toBe("pending");
  const body = new TextEncoder().encode(JSON.stringify({
    model: "test",
    messages: [{ role: "user", content: "answer" }],
  }));
  const prepared = await value.controller.prepareChatRequest({
    viewId: created.view.id,
    principal: value.principal,
    allocationId: value.allocation.id,
    runtime: runtime.id,
    release: release.id,
    requestBody: body,
  });
  const parsed = JSON.parse(new TextDecoder().decode(prepared));
  expect(parsed.messages[0].content).toContain("trusted facts");
  expect(value.controller.getOperation(value.principal, created.view.operationId)).toMatchObject({
    state: "succeeded",
    outcome: "source_rebuild_materialized",
  });
  await expect(value.controller.prepareChatRequest({
    viewId: created.view.id,
    principal: value.principal,
    allocationId: value.allocation.id,
    runtime: runtime.id,
    release: release.id,
    requestBody: body,
  })).rejects.toMatchObject({ code: "context_view_consumed" });
});

test("registration rejects caller-claimed token counts and final chat is canonically recounted", async () => {
  const value = await fixture({ chatTokens: 100 });
  await expect(value.controller.register({
    id: "ctx-lie",
    version: "v1",
    sourceHandle: "source-a",
    sourceDigest: value.provisioned.digest,
    classification: "internal",
    byteCount: value.provisioned.bytes,
    tokenCount: 1,
    tokenizerDigest,
  }, value.principal, "register-lie")).rejects.toMatchObject({ code: "context_source_invalid" });
  await value.controller.register({
    id: "ctx-a",
    version: "v1",
    sourceHandle: "source-a",
    sourceDigest: value.provisioned.digest,
    classification: "internal",
    byteCount: value.provisioned.bytes,
    tokenCount: 20,
    tokenizerDigest,
  }, value.principal, "register-ok");
  const created = await value.controller.createView({
    allocationId: value.allocation.id,
    runtime: runtime.id,
    baseInputTokens: 0,
    maxInputTokens: 80,
    deadline: "2026-09-09T00:05:00.000Z",
    canonicalizationVersion: "context-view-v1",
    items: [{ contextId: "ctx-a", version: "v1", required: true, utility: 1 }],
  }, value.principal, "view-budget");
  await expect(value.controller.prepareChatRequest({
    viewId: created.view.id,
    principal: value.principal,
    allocationId: value.allocation.id,
    runtime: runtime.id,
    release: release.id,
    requestBody: new TextEncoder().encode(JSON.stringify({
      model: "test",
      messages: [{ role: "user", content: "large undeclared base prompt" }],
    })),
  })).rejects.toMatchObject({ code: "context_budget_exceeded" });
  expect(value.controller.getOperation(value.principal, created.view.operationId)).toMatchObject({
    state: "failed",
    outcome: "context_budget_exceeded",
  });
});

test("a lifecycle transition fences a ready view", async () => {
  const value = await fixture();
  await value.controller.register({
    id: "ctx-a",
    version: "v1",
    sourceHandle: "source-a",
    sourceDigest: value.provisioned.digest,
    classification: "internal",
    byteCount: value.provisioned.bytes,
    tokenCount: 20,
    tokenizerDigest,
  }, value.principal, "register-1");
  const created = await value.controller.createView({
    allocationId: value.allocation.id,
    runtime: runtime.id,
    baseInputTokens: 10,
    maxInputTokens: 800,
    deadline: "2026-09-09T00:05:00.000Z",
    canonicalizationVersion: "context-view-v1",
    items: [{ contextId: "ctx-a", version: "v1", required: true, utility: 1 }],
  }, value.principal, "view-1");
  value.setStatus("COLD");
  value.controller.statuses();
  value.setStatus("HOT");
  await expect(value.controller.prepareChatRequest({
    viewId: created.view.id,
    principal: value.principal,
    allocationId: value.allocation.id,
    runtime: runtime.id,
    release: release.id,
    requestBody: new TextEncoder().encode(JSON.stringify({ messages: [] })),
  })).rejects.toMatchObject({ code: "context_view_stale" });
});

test("context list is cursor bounded and delete is path-scoped idempotent", async () => {
  const value = await fixture();
  for (const [index, id] of ["ctx-a", "ctx-b"].entries()) {
    await value.controller.register({
      id,
      version: "v1",
      sourceHandle: "source-a",
      sourceDigest: value.provisioned.digest,
      classification: "internal",
      byteCount: value.provisioned.bytes,
      tokenCount: 20,
      tokenizerDigest,
    }, value.principal, index === 0 ? "same-key" : "register-b");
  }
  const first = value.controller.list(value.principal, { limit: 1 });
  expect(first.contexts.map((item) => item.id)).toEqual(["ctx-a"]);
  expect(first.nextCursor).toBeString();
  expect(value.controller.list(value.principal, { cursor: first.nextCursor, limit: 1 }).contexts
    .map((item) => item.id)).toEqual(["ctx-b"]);
  const deleted = await value.controller.delete(value.principal, "ctx-a", "same-key");
  expect(deleted).toEqual({ deleted: 1, replay: false });
  expect(await value.controller.delete(value.principal, "ctx-a", "same-key"))
    .toEqual({ deleted: 1, replay: true });
});

test("optional source drift is omitted while a materialization deadline cancels fail closed", async () => {
  const value = await fixture();
  const optional = await value.source.provision(
    value.principal,
    "source-optional",
    "optional facts",
    1024,
    [{ tokenizerDigest, tokenCount: 10 }],
  );
  for (const registration of [{
    id: "ctx-required",
    sourceHandle: "source-a",
    sourceDigest: value.provisioned.digest,
    byteCount: value.provisioned.bytes,
    tokenCount: 20,
  }, {
    id: "ctx-optional",
    sourceHandle: "source-optional",
    sourceDigest: optional.digest,
    byteCount: optional.bytes,
    tokenCount: 10,
  }]) {
    await value.controller.register({
      ...registration,
      version: "v1",
      classification: "internal",
      tokenizerDigest,
    }, value.principal, `register-${registration.id}`);
  }
  const created = await value.controller.createView({
    allocationId: value.allocation.id,
    runtime: runtime.id,
    baseInputTokens: 0,
    maxInputTokens: 800,
    deadline: "2026-09-09T00:05:00.000Z",
    canonicalizationVersion: "context-view-v1",
    items: [
      { contextId: "ctx-required", version: "v1", required: true, utility: 1 },
      { contextId: "ctx-optional", version: "v1", required: false, utility: 0.5 },
    ],
  }, value.principal, "view-optional");
  await value.source.delete(value.principal, "source-optional");
  const prepared = await value.controller.prepareChatRequest({
    viewId: created.view.id,
    principal: value.principal,
    allocationId: value.allocation.id,
    runtime: runtime.id,
    release: release.id,
    requestBody: new TextEncoder().encode(JSON.stringify({ messages: [] })),
  });
  expect(new TextDecoder().decode(prepared)).toContain("trusted facts");

  const delayed = await fixture({
    countChatTokens: async (signal) => await new Promise<number>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  await delayed.controller.register({
    id: "ctx-deadline",
    version: "v1",
    sourceHandle: "source-a",
    sourceDigest: delayed.provisioned.digest,
    classification: "internal",
    byteCount: delayed.provisioned.bytes,
    tokenCount: 20,
    tokenizerDigest,
  }, delayed.principal, "register-deadline");
  const deadlineView = await delayed.controller.createView({
    allocationId: delayed.allocation.id,
    runtime: runtime.id,
    baseInputTokens: 0,
    maxInputTokens: 800,
    deadline: "2026-09-09T00:00:00.010Z",
    canonicalizationVersion: "context-view-v1",
    items: [{ contextId: "ctx-deadline", version: "v1", required: true, utility: 1 }],
  }, delayed.principal, "view-deadline");
  await expect(delayed.controller.prepareChatRequest({
    viewId: deadlineView.view.id,
    principal: delayed.principal,
    allocationId: delayed.allocation.id,
    runtime: runtime.id,
    release: release.id,
    requestBody: new TextEncoder().encode(JSON.stringify({ messages: [] })),
  })).rejects.toMatchObject({ code: "context_view_stale" });
});
