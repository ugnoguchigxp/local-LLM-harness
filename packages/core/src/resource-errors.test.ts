import { expect, test } from "bun:test";
import { memoryResourceError } from "./resource-errors";
import { errorResponseSchema } from "./api-control-contract";
import { allocationErrorSchema } from "./allocation";

test("memory refusal survives public and persisted error contracts without parsing prose", () => {
  for (const reason of ["memory_exhausted", "live_memory_exhausted"]) {
    const error = memoryResourceError(reason, "insufficient memory", [{ node: "n", usableMemoryGB: 12,
      committedMemoryGB: 8, incrementalMemoryGB: 6, availableMemoryGB: 4, effectiveLiveAvailableMemoryGB: 3 }])!;
    expect(error).toMatchObject({ code: "resource_exhausted", type: "resource_error", resource: "memory", reason, retry: "after_capacity_change" });
    expect(errorResponseSchema.parse({ error }).error).toEqual(error);
    expect(allocationErrorSchema.parse(error)).toEqual(error);
  }
  expect(errorResponseSchema.parse({ error: { code: "memory_exhausted", message: "legacy" } }).error.code).toBe("memory_exhausted");
});

test("telemetry failures, busy slots and worker exits are not proof of memory shortage", () => {
  for (const reason of ["telemetry_unavailable", "runtime_capacity", "swap_group_conflict", "generation_failed", "memory_reclamation_failed"]) {
    expect(memoryResourceError(reason, "out of memory")).toBeUndefined();
  }
});
