import { expect, test } from "bun:test";
import type { ActiveContextView, ClusterState, ContextDescriptor, Registry } from "@larm/core";
import type {
  ContextSourceProvider,
  LocalContextMetadataStore,
} from "@larm/backends";
import { ContextController } from "./context-controller";

test("Personal State invalidation removes registry ownership and durable planned views", async () => {
  const now = "2026-09-16T00:00:00.000Z";
  const descriptor: ContextDescriptor = {
    schemaVersion: 1,
    id: "context-1",
    version: "v1",
    sourceHandle: "source-1",
    sourceDigest: "a".repeat(64),
    classification: "restricted",
    byteCount: 10,
    tokenCount: 2,
    tokenizerDigest: "b".repeat(64),
    principal: "principal-1",
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
  const metadataStore = {
    load: async () => [descriptor],
    save: async () => undefined,
  } as unknown as LocalContextMetadataStore;
  const registry: Registry = {
    nodes: [{
      id: "node-1",
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 1, reservedMemoryGB: 0 },
    }],
    runtimes: [],
    profiles: [],
    routes: [],
  };
  const controller = new ContextController({
    enabled: true,
    registry,
    releases: [],
    metadataStore,
    sourceProvider: { read: async () => { throw new Error("unused"); } } as ContextSourceProvider,
    tokenizer: {
      identity: async () => { throw new Error("unused"); },
      countChatTokens: async () => { throw new Error("unused"); },
    },
    getState: () => ({ generatedAt: now } as ClusterState),
    getAllocation: () => undefined,
    getActiveRelease: () => undefined,
    isDraining: () => false,
    stateMaxAgeMs: 1_000,
    sourceMaxBytes: 1_024,
    sourceMaxTotalBytes: 4_096,
    materializedMaxBytes: 4_096,
    idempotencyTtlMs: 1_000,
    idempotencyLimit: 10,
  });
  await controller.initialize();

  let planned = false;
  const invalidated = await controller.invalidatePersonalState({
    principal: descriptor.principal,
    contextIds: [descriptor.id],
    sourceHandles: [],
  }, async (plan) => {
    planned = true;
    expect(plan.descriptors).toEqual([descriptor]);
    expect(controller.list(descriptor.principal).contexts).toHaveLength(1);
  });
  expect(planned).toBeTrue();
  expect(invalidated.descriptors).toEqual([descriptor]);
  expect(controller.list(descriptor.principal).contexts).toHaveLength(0);

  const durableOnlyView: ActiveContextView = {
    schemaVersion: 1,
    id: "view-from-durable-plan",
    operationId: "operation-from-durable-plan",
    principal: descriptor.principal,
    allocationId: "allocation-1",
    runtime: "runtime-1",
    release: "release-1",
    compatibilityKey: "d".repeat(64),
    viewDigest: "e".repeat(64),
    canonicalizationVersion: "context-view-v2",
    baseInputTokens: 1,
    inputBudgetTokens: 2,
    tokenCount: 1,
    orderedItems: [],
    omitted: [],
    leaseEpoch: 1,
    requestDigest: "f".repeat(64),
    dataEpoch: 1,
    state: "ready",
    createdAt: now,
    expiresAt: "2026-09-16T01:00:00.000Z",
  };
  (controller as unknown as { views: Map<string, ActiveContextView> }).views.set(
    durableOnlyView.id,
    durableOnlyView,
  );
  expect(controller.getView(descriptor.principal, durableOnlyView.id)).toBeDefined();
  const durableInvalidation = await controller.invalidatePersonalState({
    principal: descriptor.principal,
    contextIds: [],
    sourceHandles: [],
  }, async () => ({ viewIds: [durableOnlyView.id] }));
  expect(durableInvalidation.viewIds).toEqual([durableOnlyView.id]);
  expect(controller.getView(descriptor.principal, durableOnlyView.id)).toBeUndefined();
});
