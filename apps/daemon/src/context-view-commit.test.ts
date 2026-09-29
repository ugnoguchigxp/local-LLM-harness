import { expect, test } from "bun:test";
import type { ActiveContextView, ContextOperation } from "@larm/core";
import { commitContextViewCreation } from "./context-view-commit";

function view(): ActiveContextView {
  return {
    id: "view_1",
    operationId: "ctxop_1",
    allocationId: "alloc_1",
    runtime: "runtime_1",
    release: "release_1",
    state: "ready",
    leaseEpoch: 4,
    canonicalizationVersion: "context-view-v2",
    viewDigest: "digest",
    tokenCount: 12,
    inputBudgetTokens: 20,
    orderedItems: [],
    omitted: [],
    createdAt: "2026-09-29T00:00:00.000Z",
    expiresAt: "2026-09-29T00:01:00.000Z",
  } as unknown as ActiveContextView;
}

test("commits view, operation, idempotency result, then emits creation", () => {
  const views = new Map<string, ActiveContextView>();
  const operations = new Map<string, ContextOperation>();
  const order: string[] = [];
  const currentView = view();

  const result = commitContextViewCreation({
    view: currentView,
    principal: "principal_1",
    idempotencyKeyDigest: "key_digest",
    views,
    operations,
    project: (item) => ({ id: item.id, runtime: item.runtime }),
    remember: (value) => {
      expect(views.get(currentView.id)).toBe(currentView);
      expect(operations.get(currentView.operationId)?.state).toBe("pending");
      order.push(`remember:${value.view.id}`);
    },
    emit: (runtime) => order.push(`emit:${runtime}`),
  });

  expect(result).toEqual({ view: { id: "view_1", runtime: "runtime_1" } });
  expect(operations.get("ctxop_1")).toMatchObject({
    principal: "principal_1",
    idempotencyKeyDigest: "key_digest",
    viewId: "view_1",
    fence: 4,
    state: "pending",
    deadline: currentView.expiresAt,
    createdAt: currentView.createdAt,
    updatedAt: currentView.createdAt,
  });
  expect(order).toEqual(["remember:view_1", "emit:runtime_1"]);
});
