import { expect, test } from "bun:test";
import type { ClusterState, Registry, RuntimeSnapshot } from "./schema";
import { resolveCapability } from "./resolve";

const registry: Registry = {
  nodes: [
    {
      id: "ai395-01",
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
    },
  ],
  runtimes: [
    {
      id: "qwen-general",
      capability: ["llm.general"],
      backend: "systemd",
      node: "ai395-01",
      policy: { class: "resident" },
      resources: { estimatedMemoryGB: 24 },
      deployment: {
        service: "a",
        healthPort: 1,
        endpoint: "http://127.0.0.1:8080",
      },
    },
    {
      id: "qwen-worker",
      capability: ["llm.general"],
      backend: "systemd",
      node: "ai395-01",
      policy: { class: "preferred" },
      resources: { estimatedMemoryGB: 24 },
      deployment: {
        service: "b",
        healthPort: 2,
        endpoint: "http://127.0.0.1:8082",
      },
    },
  ],
  profiles: [],
  routes: [],
};

function state(runtimes: RuntimeSnapshot[]): ClusterState {
  return {
    generatedAt: "2026-08-26T00:00:00.000Z",
    node: {
      id: "ai395-01",
      online: true,
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
    },
    runtimes,
  };
}

function snap(
  id: string,
  status: RuntimeSnapshot["status"],
  cls: RuntimeSnapshot["class"],
  endpoint: string,
): RuntimeSnapshot {
  return {
    id,
    status,
    class: cls,
    capability: ["llm.general"],
    node: "ai395-01",
    backend: "systemd",
    endpoint,
    observedAt: "2026-08-26T00:00:00.000Z",
  };
}

test("prefers HOT resident over HOT preferred", () => {
  const result = resolveCapability(
    registry,
    state([
      snap("qwen-worker", "HOT", "preferred", "http://127.0.0.1:8082"),
      snap("qwen-general", "HOT", "resident", "http://127.0.0.1:8080"),
    ]),
    "llm.general",
  );
  expect(result).toEqual({
    ok: true,
    runtime: "qwen-general",
    node: "ai395-01",
    endpoint: "http://127.0.0.1:8080",
    status: "HOT",
  });
});

test("returns BUSY if that is the only live replica", () => {
  const result = resolveCapability(
    registry,
    state([snap("qwen-general", "BUSY", "resident", "http://127.0.0.1:8080")]),
    "llm.general",
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.status).toBe("BUSY");
  }
});

test("not_ready when only COLD", () => {
  const result = resolveCapability(
    registry,
    state([snap("qwen-general", "COLD", "resident", "http://127.0.0.1:8080")]),
    "llm.general",
  );
  expect(result).toEqual({ ok: false, reason: "not_ready" });
});

test("unknown_capability when nothing in the registry provides it", () => {
  expect(resolveCapability(registry, state([]), "speech.stt")).toEqual({
    ok: false,
    reason: "unknown_capability",
  });
});
