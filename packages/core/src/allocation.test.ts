import { expect, test } from "bun:test";
import { allocationSchema } from "./allocation";
import { allocationRequestSchema } from "./api-schema";

function allocation() {
  return {
    id: "alloc_test",
    bootEpoch: "epoch-test",
    status: "ready",
    requirements: [{ capability: "llm.general", route: "llm-default" }],
    bindings: [{
      capability: "llm.general",
      route: "llm-default",
      runtime: "qwen-general",
      node: "local-node",
      endpoint: "http://127.0.0.1:8080",
      status: "HOT",
      candidateRank: 1,
      fallback: false,
      selectionReason: "primary-live",
    }],
    allowFallback: false,
    deploymentPolicy: "existing-only",
    createdAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2026-08-28T00:05:00.000Z",
  };
}

test("validates complete one-to-one allocation bindings", () => {
  expect(allocationSchema.parse(allocation()).status).toBe("ready");
  expect(() => allocationSchema.parse({ ...allocation(), bindings: [] })).toThrow(/missing binding|Too small/);
  expect(() => allocationSchema.parse({
    ...allocation(),
    bindings: [{ ...allocation().bindings[0], route: "llm-speed" }],
  })).toThrow(/match a declared/);
});

test("validates provider instance identity as one coherent binding", () => {
  const binding = allocation().bindings[0]!;
  expect(() => allocationSchema.parse({
    ...allocation(),
    bindings: [{ ...binding, instanceId: "pinst-a" }],
  })).toThrow(/supplied together/);
  expect(() => allocationSchema.parse({
    ...allocation(),
    bindings: [{ ...binding, instanceId: "pinst-a", instanceGeneration: 1 }],
  })).toThrow(/providerRevision/);
  expect(allocationSchema.safeParse({
    ...allocation(),
    bindings: [{
      ...binding,
      providerRevision: "a".repeat(64),
      instanceId: "pinst-a",
      instanceGeneration: 1,
    }],
  }).success).toBeTrue();
});

test("allocation scheduling defaults preserve rejection and accept bounded priorities", () => {
  const request = allocationRequestSchema.parse({
    requirements: [{ capability: "llm.general", route: "llm-default" }],
  });
  expect(request).toMatchObject({ priority: 0, capacityPolicy: "reject" });
  expect(allocationRequestSchema.parse({
    ...request,
    priority: 3_000,
    capacityPolicy: "wait",
  })).toMatchObject({ priority: 3_000, capacityPolicy: "wait" });
  expect(allocationRequestSchema.safeParse({ ...request, priority: 1_000_001 }).success)
    .toBeFalse();
});
