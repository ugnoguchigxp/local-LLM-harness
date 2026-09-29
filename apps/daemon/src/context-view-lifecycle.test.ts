import { describe, expect, test } from "bun:test";
import type { ActiveContextView } from "@larm/core";
import { expireContextView, invalidateReadyContextViews } from "./context-view-lifecycle";

function view(id: string, state: ActiveContextView["state"] = "ready"): ActiveContextView {
  return {
    schemaVersion: 1,
    id,
    operationId: `op-${id}`,
    principal: "principal",
    allocationId: "allocation",
    runtime: "runtime",
    release: "release",
    compatibilityKey: "a".repeat(64),
    viewDigest: "b".repeat(64),
    state,
    canonicalizationVersion: "context-view-v1",
    baseInputTokens: 1,
    tokenCount: 1,
    inputBudgetTokens: 2,
    orderedItems: [],
    omitted: [],
    leaseEpoch: 1,
    createdAt: "2026-09-29T00:00:00.000Z",
    expiresAt: "2026-09-29T00:01:00.000Z",
  };
}

describe("context view lifecycle", () => {
  test("invalidates only matching ready views and cancels their operations when requested", () => {
    const views = [view("match"), view("other"), view("used", "consumed")];
    const updates: Array<[string, string, string]> = [];
    const count = invalidateReadyContextViews(views, {
      matches: (candidate) => candidate.id === "match" || candidate.id === "used",
      operationOutcome: "daemon_draining",
      updateOperation: (id, state, outcome) => updates.push([id, state, outcome]),
    });

    expect(count).toBe(1);
    expect(views.map(({ state }) => state)).toEqual(["invalid", "ready", "consumed"]);
    expect(updates).toEqual([["op-match", "cancelled", "daemon_draining"]]);
  });

  test("expires, cancels, clears materialization, and removes the view in order", () => {
    const target = view("expires");
    const events: string[] = [];
    expireContextView("expires", target, {
      updateOperation: (id, state, outcome) => events.push(`operation:${id}:${state}:${outcome}`),
      clearMaterializing: (id) => events.push(`materializing:${id}`),
      removeView: (id) => events.push(`remove:${id}`),
    });

    expect(target.state).toBe("expired");
    expect(events).toEqual([
      "operation:op-expires:cancelled:context_view_expired",
      "materializing:expires",
      "remove:expires",
    ]);
  });
});
