import { expect, test } from "bun:test";
import { clusterStateSchema, type RuntimeDefinition } from "./schema";
import { buildClusterState, buildRuntimeSnapshot, primaryNode } from "./state";

const node = {
  id: "ai395-01",
  displayName: "test",
  endpoint: "http://127.0.0.1",
  resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
};

const runtime: RuntimeDefinition = {
  id: "qwen-general",
  capability: ["llm.general"],
  backend: "systemd",
  node: "ai395-01",
  policy: { class: "resident" },
  resources: { estimatedMemoryGB: 24 },
  deployment: {
    service: "llama-server.service",
    healthPort: 8080,
    endpoint: "http://127.0.0.1:8080",
    backendEndpoint: "http://127.0.0.1:8080",
  },
};

test("buildClusterState matches ClusterState schema", () => {
  const snapshot = buildRuntimeSnapshot({
    runtime,
    status: "HOT",
    observedAt: "2026-08-26T00:00:00.000Z",
    health: { ok: true, httpStatus: 200 },
  });
  const state = buildClusterState({
    node,
    snapshots: [snapshot],
    generatedAt: "2026-08-26T00:00:01.000Z",
  });
  expect(clusterStateSchema.parse(state).runtimes[0]?.status).toBe("HOT");
  expect(state.node.online).toBe(true);
  expect(state.runtimes[0]?.endpoint).toBe("http://127.0.0.1:8080");
});

test("primaryNode follows the first runtime node id", () => {
  expect(primaryNode([node], [runtime]).id).toBe("ai395-01");
});

test("llama-swap snapshots expose modelId as service", () => {
  const snapshot = buildRuntimeSnapshot({
    runtime: {
      id: "qwen-worker",
      capability: ["llm.general"],
      backend: "llama-swap",
      node: "ai395-01",
      policy: { class: "preferred" },
      resources: { estimatedMemoryGB: 24 },
      deployment: {
        modelId: "qwen-worker",
        listen: "http://127.0.0.1:9292",
        endpoint: "http://127.0.0.1:9292",
      },
    },
    status: "COLD",
    observedAt: "2026-08-26T00:00:00.000Z",
  });
  expect(snapshot.service).toBe("qwen-worker");
  expect(snapshot.backend).toBe("llama-swap");
});
