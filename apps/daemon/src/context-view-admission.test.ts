import { expect, test } from "bun:test";
import type { ActiveContextView } from "@larm/core";
import { ContextControllerError } from "./context-controller-errors";
import { assertContextViewMaterializable } from "./context-view-admission";

function view(overrides: Partial<ActiveContextView> = {}): ActiveContextView {
  return {
    id: "view_1",
    principal: "principal_1",
    allocationId: "alloc_1",
    runtime: "runtime_1",
    release: "release_1",
    state: "ready",
    leaseEpoch: 2,
    expiresAt: "2026-09-29T00:01:00.000Z",
    ...overrides,
  } as ActiveContextView;
}

function admit(overrides: Partial<Parameters<typeof assertContextViewMaterializable>[0]> = {}) {
  const current = overrides.view ?? view();
  return assertContextViewMaterializable({
    view: current,
    principal: "principal_1",
    allocationId: "alloc_1",
    runtime: "runtime_1",
    release: "release_1",
    isMaterializing: false,
    now: () => Date.parse("2026-09-29T00:00:00.000Z"),
    getActivation: () => ({ state: "ACTIVE", leaseEpoch: 2, release: "release_1" }),
    ...overrides,
  });
}

test("admits an active view only for the exact owner, allocation, runtime, and release epoch", () => {
  const current = view();
  expect(admit({ view: current })).toBe(current);
  expect(() => admit({ view: current, principal: "other" })).toThrow(ContextControllerError);
  for (const overrides of [
    { allocationId: "other" },
    { runtime: "other" },
    { release: "other" },
    { getActivation: () => ({ state: "COLD", leaseEpoch: 2, release: "release_1" }) },
    { getActivation: () => ({ state: "ACTIVE", leaseEpoch: 3, release: "release_1" }) },
    { getActivation: () => ({ state: "ACTIVE", leaseEpoch: 2, release: "other" }) },
  ]) {
    const candidate = view();
    expect(() => admit({ view: candidate, ...overrides })).toThrow(ContextControllerError);
    expect(candidate.state).toBe("invalid");
  }
});

test("rejects consumed, busy, expired, or unavailable views without resolving runtime activation", () => {
  const activation = () => { throw new Error("activation must not be resolved"); };
  for (const [candidate, busy, code] of [
    [view({ state: "consumed" }), false, "context_view_consumed"],
    [view(), true, "context_operation_busy"],
    [view({ expiresAt: "2026-09-28T00:00:00.000Z" }), false, "context_view_stale"],
  ] as const) {
    expect(() => admit({ view: candidate, isMaterializing: busy, getActivation: activation }))
      .toThrow(expect.objectContaining({ code }));
  }
  expect(() => admit({ view: undefined, getActivation: activation }))
    .toThrow(expect.objectContaining({ code: "context_not_found" }));
});
