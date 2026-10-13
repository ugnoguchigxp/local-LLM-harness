import { expect, test } from "bun:test";
import { runtimeSetsConflict } from "./allocation-resource-conflict";
import type { Registry } from "./registry";

const registry = {
  runtimes: [
    { id: "shared", resources: { maxConcurrentAllocations: 4 }, policy: { swapGroup: "conversation" } },
    { id: "alternate", resources: { maxConcurrentAllocations: 4 }, policy: { swapGroup: "conversation" } },
    { id: "exclusive", resources: { maxConcurrentAllocations: 1 }, policy: {} },
    { id: "speech", resources: {}, policy: {} },
  ],
} as unknown as Registry;

test("shared leases of the same runtime do not require a swap or priority preemption", () => {
  expect(runtimeSetsConflict(registry, ["shared", "speech"], ["shared", "speech"], true)).toBeFalse();
  expect(runtimeSetsConflict(registry, ["shared"], ["shared"], false)).toBeTrue();
});

test("different swap-group runtimes and single-allocation runtimes remain exclusive", () => {
  expect(runtimeSetsConflict(registry, ["shared"], ["alternate"], true)).toBeTrue();
  expect(runtimeSetsConflict(registry, ["exclusive"], ["exclusive"], true)).toBeTrue();
  expect(runtimeSetsConflict(registry, ["shared", "exclusive"], ["shared", "exclusive"], true)).toBeTrue();
  expect(runtimeSetsConflict(registry, ["speech"], ["alternate"], true)).toBeFalse();
});
