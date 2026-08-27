import { expect, test } from "bun:test";
import { createLeaseId, desiredCapabilities, residentCapabilitiesFrom, type Lease } from "./leases";

test("createLeaseId works without an injected generator", () => {
  expect(createLeaseId().startsWith("lease_")).toBe(true);
});

test("desired capabilities are the union of resident floor and leases", () => {
  const leases: Lease[] = [
    {
      id: "lease_a",
      capabilities: ["llm.general", "speech.stt"],
      createdAt: "2026-08-26T00:00:00.000Z",
    },
    {
      id: "lease_b",
      capabilities: ["llm.coding"],
      createdAt: "2026-08-26T00:00:00.000Z",
    },
  ];
  expect(
    desiredCapabilities(["llm.general", "llm.reasoning"], leases),
  ).toEqual(["llm.coding", "llm.general", "llm.reasoning", "speech.stt"]);
});

test("residentCapabilitiesFrom only includes resident runtimes", () => {
  expect(
    residentCapabilitiesFrom([
      { policy: { class: "resident" }, capability: ["llm.general"] },
      { policy: { class: "preferred" }, capability: ["llm.general"] },
    ]),
  ).toEqual(["llm.general"]);
});
