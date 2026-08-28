import { expect, test } from "bun:test";
import type { Registry } from "./registry";
import type { ClusterState, RuntimeSnapshot } from "./schema";
import {
  compareRouteSelection,
  findDefaultRoute,
  selectRoute,
} from "./route-selector";

const registry: Registry = {
  nodes: [
    {
      id: "gnosis",
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
    },
  ],
  runtimes: [
    {
      id: "qwen-general",
      capability: ["llm.general", "llm.reasoning", "llm.coding"],
      backend: "systemd",
      node: "gnosis",
      policy: { class: "resident" },
      resources: { estimatedMemoryGB: 40 },
      deployment: {
        service: "llama-server.service",
        healthPort: 8080,
        endpoint: "http://127.0.0.1:8080",
      },
    },
    {
      id: "qwen-worker-quality",
      capability: ["llm.general", "llm.reasoning", "llm.coding"],
      backend: "llama-swap",
      node: "gnosis",
      policy: { class: "preferred" },
      resources: { estimatedMemoryGB: 40 },
      deployment: {
        modelId: "qwen-quality",
        listen: "http://127.0.0.1:8083",
        endpoint: "http://127.0.0.1:8083/upstream/qwen-quality",
      },
    },
    {
      id: "qwen-worker-fast",
      capability: ["llm.general", "llm.coding"],
      backend: "llama-swap",
      node: "gnosis",
      policy: { class: "preferred" },
      resources: { estimatedMemoryGB: 38 },
      deployment: {
        modelId: "qwen-fast",
        listen: "http://127.0.0.1:8083",
        endpoint: "http://127.0.0.1:8083/upstream/qwen-fast",
      },
    },
    {
      id: "qwen-35b-speed",
      capability: ["llm.general", "llm.coding"],
      backend: "llama-swap",
      node: "gnosis",
      policy: { class: "preferred" },
      resources: { estimatedMemoryGB: 48 },
      deployment: {
        modelId: "qwen-35b-speed",
        listen: "http://127.0.0.1:8083",
        endpoint: "http://127.0.0.1:8083/upstream/qwen-35b-speed",
      },
    },
  ],
  profiles: [],
  routes: [
    {
      id: "llm-default",
      capabilities: ["llm.general", "llm.reasoning", "llm.coding"],
      explicitOnly: false,
      candidates: [
        { runtime: "qwen-general", purpose: "primary" },
        { runtime: "qwen-worker-quality", purpose: "fallback" },
      ],
    },
    {
      id: "llm-speed",
      capabilities: ["llm.general", "llm.coding"],
      explicitOnly: true,
      candidates: [
        { runtime: "qwen-worker-fast", purpose: "primary" },
        { runtime: "qwen-general", purpose: "fallback" },
      ],
    },
  ],
};

function snapshot(id: string, status: RuntimeSnapshot["status"]): RuntimeSnapshot {
  const runtime = registry.runtimes.find((item) => item.id === id);
  if (!runtime) {
    throw new Error(`unknown test runtime ${id}`);
  }
  return {
    id,
    status,
    class: runtime.policy.class,
    capability: runtime.capability,
    node: runtime.node,
    backend: runtime.backend,
    endpoint: runtime.deployment.endpoint,
    observedAt: "2026-08-28T00:00:00.000Z",
  };
}

function state(statuses: Record<string, RuntimeSnapshot["status"]>): ClusterState {
  return {
    generatedAt: "2026-08-28T00:00:00.000Z",
    node: {
      id: "gnosis",
      online: true,
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
    },
    runtimes: Object.entries(statuses).map(([id, status]) => snapshot(id, status)),
  };
}

test("finds the declared default route for a capability", () => {
  expect(findDefaultRoute(registry, "llm.general")?.id).toBe("llm-default");
  expect(findDefaultRoute(registry, "speech.stt")).toBeUndefined();
});

test("default route keeps the resident primary even when optional models are hot", () => {
  const result = selectRoute({
    registry,
    state: state({
      "qwen-general": "HOT",
      "qwen-worker-quality": "HOT",
      "qwen-worker-fast": "HOT",
      "qwen-35b-speed": "HOT",
    }),
    routeId: "llm-default",
    capability: "llm.general",
    mode: "default",
    allowFallback: true,
  });

  expect(result).toMatchObject({
    ok: true,
    runtime: "qwen-general",
    candidateRank: 1,
    fallback: false,
    reason: "primary-live",
  });
});

test("does not use an available fallback without caller permission", () => {
  const result = selectRoute({
    registry,
    state: state({
      "qwen-general": "COLD",
      "qwen-worker-quality": "COLD",
    }),
    routeId: "llm-default",
    capability: "llm.general",
    mode: "default",
    allowFallback: false,
  });

  expect(result).toEqual({
    ok: false,
    route: "llm-default",
    capability: "llm.general",
    reason: "fallback_not_allowed",
  });
});

test("selects a declared fallback when the resident is unavailable and fallback is allowed", () => {
  const result = selectRoute({
    registry,
    state: state({
      "qwen-general": "COLD",
      "qwen-worker-quality": "COLD",
    }),
    routeId: "llm-default",
    capability: "llm.general",
    mode: "default",
    allowFallback: true,
  });

  expect(result).toMatchObject({
    ok: true,
    runtime: "qwen-worker-quality",
    status: "COLD",
    candidateRank: 2,
    fallback: true,
    reason: "fallback-startable",
  });
});

test("requires explicit selection for the speed route", () => {
  const current = state({ "qwen-worker-fast": "COLD", "qwen-general": "HOT" });
  expect(
    selectRoute({
      registry,
      state: current,
      routeId: "llm-speed",
      capability: "llm.general",
      mode: "default",
      allowFallback: false,
    }),
  ).toEqual({
    ok: false,
    route: "llm-speed",
    capability: "llm.general",
    reason: "explicit_route_required",
  });

  expect(
    selectRoute({
      registry,
      state: current,
      routeId: "llm-speed",
      capability: "llm.general",
      mode: "explicit",
      allowFallback: false,
    }),
  ).toMatchObject({
    ok: true,
    runtime: "qwen-worker-fast",
    reason: "primary-startable",
  });
});

test("shadow comparison reports differences without changing either result", () => {
  const route = findDefaultRoute(registry, "llm.general");
  if (!route) {
    throw new Error("default route missing from fixture");
  }
  const selected = selectRoute({
    registry,
    state: state({ "qwen-general": "COLD", "qwen-worker-quality": "COLD" }),
    routeId: route.id,
    capability: "llm.general",
    mode: "default",
    allowFallback: true,
  });
  const comparison = compareRouteSelection(
    "llm.general",
    route,
    { ok: false, reason: "not_ready" },
    selected,
  );

  expect(comparison).toEqual({
    capability: "llm.general",
    route: "llm-default",
    legacyRuntime: undefined,
    routeRuntime: "qwen-worker-quality",
    legacyOutcome: "error:not_ready",
    routeOutcome: "runtime:qwen-worker-quality",
    matches: false,
  });
});
