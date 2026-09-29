import { expect, test } from "bun:test";
import { activeContextViewSchema } from "@larm/core";
import { bindPersonalStateViewData } from "./context-personal-state-bridge";

test("binds the exact Personal State measurement to its planned context view", () => {
  const view = activeContextViewSchema.parse({
    schemaVersion: 1,
    id: "view-a",
    operationId: "operation-a",
    principal: "principal-a",
    allocationId: "allocation-a",
    runtime: "runtime-a",
    release: "release-a",
    compatibilityKey: "a".repeat(64),
    viewDigest: "b".repeat(64),
    canonicalizationVersion: "context-view-v1",
    baseInputTokens: 10,
    inputBudgetTokens: 100,
    tokenCount: 20,
    orderedItems: [{
      contextId: "context-a",
      version: "v1",
      required: false,
      utility: 0.2,
      tokenCount: 10,
      sourceDigest: "c".repeat(64),
    }],
    omitted: [],
    leaseEpoch: 1,
    state: "ready",
    createdAt: "2026-09-29T00:00:00.000Z",
    expiresAt: "2026-09-29T00:05:00.000Z",
  });
  const bound = bindPersonalStateViewData({
    view,
    requestDigest: "d".repeat(64),
    dataEpoch: 7,
    actualInputTokens: 35,
    selectedItems: [{
      contextId: "context-a",
      version: "v1",
      required: true,
      utility: 0.9,
    }],
    omitted: [
      { contextId: "context-z", version: "v1", reason: "budget" },
      { contextId: "context-b", version: "v1", reason: "not_found" },
    ],
  });

  expect(bound).toMatchObject({
    requestDigest: "d".repeat(64),
    dataEpoch: 7,
    canonicalizationVersion: "context-view-v2",
    tokenCount: 35,
    orderedItems: [{ required: true, utility: 0.9 }],
    omitted: [
      { contextId: "context-b", reason: "not_found" },
      { contextId: "context-z", reason: "budget" },
    ],
  });
  expect(bound.viewDigest).not.toBe("b".repeat(64));
});
