import { expect, test } from "bun:test";
import type { Registry } from "./registry";
import type { ClusterState, RuntimeSnapshot } from "./schema";
import { planTransition } from "./planner";

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
      capability: ["llm.general", "llm.reasoning"],
      protocol: "openai.chat-completions.v1",
      backend: "systemd",
      node: "ai395-01",
      policy: { class: "resident" },
      resources: { estimatedMemoryGB: 24, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
      deployment: {
        service: "llama-server.service",
        healthPort: 8080,
        endpoint: "http://127.0.0.1:8080",
      },
    },
    {
      id: "qwen-worker",
      capability: ["llm.general"],
      protocol: "openai.chat-completions.v1",
      backend: "systemd",
      node: "ai395-01",
      policy: { class: "preferred" },
      resources: { estimatedMemoryGB: 24, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
      deployment: {
        service: "qwen-tts.service",
        healthPort: 8082,
        endpoint: "http://127.0.0.1:8082",
      },
    },
  ],
  profiles: [],
  routes: [],
};

function snap(id: string, status: RuntimeSnapshot["status"], cls: RuntimeSnapshot["class"]): RuntimeSnapshot {
  return {
    id,
    status,
    class: cls,
    capability: id === "qwen-general" ? ["llm.general", "llm.reasoning"] : ["llm.general"],
    node: "ai395-01",
    backend: "systemd",
    endpoint: "http://127.0.0.1:1",
    observedAt: "2026-08-26T00:00:00.000Z",
  };
}

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

test("does not ensure worker when resident already covers llm.general", () => {
  const plan = planTransition({
    registry,
    state: state([
      snap("qwen-general", "HOT", "resident"),
      snap("qwen-worker", "COLD", "preferred"),
    ]),
    leases: [
      {
        id: "lease_1",
        capabilities: ["llm.general"],
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ],
  });
  expect(plan.ensure).toEqual([]);
  expect(plan.stop).toEqual([]);
  expect(plan.uncovered).toEqual([]);
});

test("ensures worker when resident is COLD and llm.general is desired", () => {
  const plan = planTransition({
    registry,
    state: state([
      snap("qwen-general", "COLD", "resident"),
      snap("qwen-worker", "COLD", "preferred"),
    ]),
    leases: [
      {
        id: "lease_1",
        capabilities: ["llm.general"],
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ],
  });
  expect(plan.ensure).toEqual(["qwen-worker"]);
  expect(plan.uncovered).toEqual([]);
});

test("never plans to stop a resident runtime", () => {
  const plan = planTransition({
    registry,
    state: state([
      snap("qwen-general", "HOT", "resident"),
      snap("qwen-worker", "HOT", "preferred"),
    ]),
    leases: [],
  });
  expect(plan.stop).toEqual(["qwen-worker"]);
  expect(plan.stop).not.toContain("qwen-general");
});

test("keeps extra preferred while a lease is active (hot-first)", () => {
  const plan = planTransition({
    registry,
    state: state([
      snap("qwen-general", "HOT", "resident"),
      snap("qwen-worker", "HOT", "preferred"),
    ]),
    leases: [
      {
        id: "lease_1",
        capabilities: ["llm.general"],
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ],
  });
  expect(plan.stop).toEqual([]);
});

test("does not stop worker if it is the only live llm.general", () => {
  const plan = planTransition({
    registry,
    state: state([
      snap("qwen-general", "COLD", "resident"),
      snap("qwen-worker", "HOT", "preferred"),
    ]),
    leases: [],
  });
  expect(plan.stop).toEqual([]);
});

test("marks capabilities with no runtime as uncovered", () => {
  const plan = planTransition({
    registry,
    state: state([snap("qwen-general", "HOT", "resident")]),
    leases: [
      {
        id: "lease_1",
        capabilities: ["speech.stt"],
        createdAt: "2026-08-26T00:00:00.000Z",
      },
    ],
  });
  expect(plan.uncovered).toContain("speech.stt");
});
