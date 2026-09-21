import { expect, test } from "bun:test";
import type { RuntimeDefinition } from "./schema";
import {
  compileProviderRevision,
  managedWarmPolicy,
  providerInstanceId,
} from "./provider-lifecycle";

const runtime: RuntimeDefinition = {
  id: "qwen-fast",
  backend: "llama-swap",
  capability: ["llm.coding"],
  protocol: "openai.chat-completions.v1",
  node: "local-node",
  policy: { class: "preferred" },
  resources: {
    estimatedMemoryGB: 24,
    maxConcurrentRequests: 1,
    maxQueuedRequests: 0,
    queueTimeoutMs: 1_000,
  },
  deployment: {
    modelId: "qwen-fast",
    listen: "http://127.0.0.1:8083",
    endpoint: "http://127.0.0.1:8083/upstream/qwen-fast",
  },
};

test("provider revision is deterministic and changes with launch or resource input", () => {
  const first = compileProviderRevision({ runtime, runtimeRelease: "qwen-r1" });
  expect(compileProviderRevision({
    runtime: structuredClone(runtime),
    runtimeRelease: "qwen-r1",
  })).toEqual(first);
  expect(compileProviderRevision({
    runtime: {
      ...runtime,
      deployment: { ...runtime.deployment, modelId: "qwen-fast-next" },
    },
    runtimeRelease: "qwen-r1",
  }).revision).not.toBe(first.revision);
  expect(compileProviderRevision({
    runtime: { ...runtime, capability: ["llm.general"] },
    runtimeRelease: "qwen-r1",
  }).revision).not.toBe(first.revision);
  expect(compileProviderRevision({
    runtime: { ...runtime, policy: { class: "resident" } },
    runtimeRelease: "qwen-r1",
  }).revision).not.toBe(first.revision);
  expect(compileProviderRevision({
    runtime: {
      ...runtime,
      resources: { ...runtime.resources, estimatedMemoryGB: 25 },
    },
    runtimeRelease: "qwen-r1",
  }).revision).not.toBe(first.revision);
  expect(providerInstanceId(first, 2)).toBe(
    `pinst-qwen-fast-${first.revision.slice(0, 12)}-2`,
  );
});

test("provider revision rejects ambiguous release selectors", () => {
  const release = {
    id: "qwen-r2",
    runtime: runtime.id,
    artifacts: ["model-qwen-r2"],
    providerConfigRevision: "config-r2",
    estimatedMemoryGB: 24,
    healthPath: "/health",
    default: false,
    digest: "a".repeat(64),
  };
  expect(() => compileProviderRevision({
    runtime,
    runtimeRelease: "qwen-r1",
    release,
  })).toThrow(/mutually exclusive/);
  expect(() => compileProviderRevision({
    runtime,
    release: { ...release, runtime: "another-runtime" },
  })).toThrow(/belongs to/);
});

test("legacy runtime class compiles to managed warm policy", () => {
  expect(managedWarmPolicy(runtime)).toEqual({
    lifecycle: "managed",
    minInstances: 0,
    idleTtlSeconds: 60,
  });
  expect(managedWarmPolicy({
    ...runtime,
    policy: {
      class: "resident",
      lifecycle: "managed",
      warm: { minInstances: 1, idleTtlSeconds: 90 },
    },
  })).toEqual({ lifecycle: "managed", minInstances: 1, idleTtlSeconds: 90 });
});
