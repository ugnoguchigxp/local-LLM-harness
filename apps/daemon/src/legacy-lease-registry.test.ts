import { expect, test } from "bun:test";
import type { Lease } from "@larm/core";
import { LegacyLeaseRegistry } from "./legacy-lease-registry";

const lease = (id: string): Lease => ({
  id,
  client: "test",
  capabilities: ["chat"],
  createdAt: "2026-09-29T00:00:00.000Z",
});

test("tracks direct and allocation-backed compatibility leases for admission", () => {
  const registry = new LegacyLeaseRegistry();
  registry.add(lease("direct"));
  registry.add(lease("allocated"), "allocation-1");

  expect(registry.has("direct")).toBe(true);
  expect(registry.has("missing")).toBe(false);
  expect(registry.get("allocated")).toEqual(lease("allocated"));
  expect(registry.values().map((item) => item.id)).toEqual(["direct", "allocated"]);
  expect([...registry.ids()]).toEqual(["direct", "allocated"]);
  expect(registry.activeAdmissionIndex()).toEqual(new Map([["allocated", "allocation-1"]]));
});

test("removing a compatibility lease atomically removes its allocation mapping", () => {
  const registry = new LegacyLeaseRegistry();
  registry.add(lease("allocated"), "allocation-1");

  expect(registry.remove("allocated")).toEqual({
    lease: lease("allocated"),
    allocationId: "allocation-1",
  });
  expect(registry.remove("allocated")).toEqual({ lease: undefined, allocationId: undefined });
  expect([...registry.ids()]).toEqual([]);
});

test("allocation detachment removes only compatibility leases linked to that allocation", () => {
  const registry = new LegacyLeaseRegistry();
  registry.add(lease("direct"));
  registry.add(lease("first"), "allocation-1");
  registry.add(lease("second"), "allocation-2");

  expect(registry.detachAllocation("allocation-1")).toEqual(["first"]);
  expect(registry.values().map((item) => item.id)).toEqual(["direct", "second"]);
  expect(registry.detachAllocation("allocation-1")).toEqual([]);
});
