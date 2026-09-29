import { expect, test } from "bun:test";
import type { Allocation, Registry } from "@larm/core";
import {
  allocationResourceKeys,
  countActiveAdmission,
  countActiveAllocations,
  hasAllocationResourceConflict,
} from "./allocation-admission";

const registry = {
  runtimes: [
    {
      id: "single",
      policy: { swapGroup: "gpu" },
      resources: { maxConcurrentAllocations: 1 },
    },
    {
      id: "shared",
      policy: { swapGroup: "gpu" },
      resources: { maxConcurrentAllocations: 4 },
    },
    {
      id: "other",
      policy: {},
      resources: { maxConcurrentAllocations: 2 },
    },
  ],
} as unknown as Registry;

function allocation(status: Allocation["status"], runtime: string): Allocation {
  return { status, bindings: [{ runtime }] } as unknown as Allocation;
}

test("exclusive resources model single-slot runtimes and shared swap groups", () => {
  expect([...allocationResourceKeys(registry, ["single", "shared"], true)].sort()).toEqual([
    "runtime:single",
    "swap:gpu",
  ]);
  const admitted = [allocation("ready", "shared")];
  expect(hasAllocationResourceConflict(registry, admitted, ["single"], () => true, true)).toBeTrue();
  expect(hasAllocationResourceConflict(registry, admitted, ["other"], () => true, true)).toBeFalse();
  expect(hasAllocationResourceConflict(registry, admitted, ["shared"], () => true, false)).toBeTrue();
});

test("active capacity includes waiting allocations and only unattached legacy leases", () => {
  const allocations = [allocation("waiting", "single"), allocation("ready", "other"), allocation("released", "single")];
  expect(countActiveAllocations(allocations)).toBe(2);
  expect(countActiveAdmission(
    allocations,
    ["legacy-attached", "legacy-direct"],
    new Map([["legacy-attached", "allocation-1"]]),
  )).toBe(3);
});
