import { expect, test } from "bun:test";
import type { Registry } from "@larm/core";
import { computeCatalogGenerationRevision } from "./catalog-generation";

const registry: Registry = {
  nodes: [{
    id: "local-node",
    endpoint: "http://127.0.0.1",
    resources: { memoryTotalGB: 64, reservedMemoryGB: 8 },
  }],
  runtimes: [],
  profiles: [],
  routes: [],
};

test("catalog generation revision covers all startup catalogs deterministically", () => {
  const input = { registry, artifacts: [], releases: [] };
  const revision = computeCatalogGenerationRevision(input);
  expect(revision).toHaveLength(64);
  expect(computeCatalogGenerationRevision(input)).toBe(revision);
  expect(computeCatalogGenerationRevision({
    ...input,
    registry: { ...registry, profiles: [{ id: "changed", require: [] }] },
  })).not.toBe(revision);
});
