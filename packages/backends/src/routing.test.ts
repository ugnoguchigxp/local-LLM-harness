import { expect, test } from "bun:test";
import type { RuntimeDefinition } from "@larm/core";
import { LlamaSwapBackend } from "./llama-swap";
import { SystemdBackend } from "./systemd";
import { createRuntimeBackend, RoutingBackend } from "./routing";
import { LifecycleError, type RuntimeBackend } from "./types";

const systemdRuntime: RuntimeDefinition = {
  id: "qwen-asr",
  capability: ["speech.stt"],
  protocol: "openai.audio-transcriptions.v1",
  backend: "systemd",
  node: "gnosis",
  policy: { class: "resident" },
  resources: { estimatedMemoryGB: 5, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
  deployment: {
    service: "qwen-asr.service",
    healthPort: 1,
    endpoint: "http://127.0.0.1:8081",
  },
};

const swapRuntime: RuntimeDefinition = {
  id: "qwen-worker",
  capability: ["llm.general"],
  protocol: "openai.chat-completions.v1",
  backend: "llama-swap",
  node: "ai395-01",
  policy: { class: "preferred" },
  resources: { estimatedMemoryGB: 24, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
  deployment: {
    modelId: "qwen-worker",
    listen: "http://127.0.0.1:9",
    endpoint: "http://127.0.0.1:9",
  },
};

test("routes list and lifecycle to the owning backend", async () => {
  const systemd = new SystemdBackend([systemdRuntime], {
    queryService: async () => "Stopped",
  });
  const swap = new LlamaSwapBackend([swapRuntime], {
    request: async () => ({ ok: true, status: 200, body: `{"running":[]}` }),
  });
  const backend = new RoutingBackend(
    new Map<string, RuntimeBackend>([
      ["qwen-asr", systemd],
      ["qwen-worker", swap],
    ]),
  );

  const listed = await backend.list();
  expect(listed.map((item) => item.runtimeId).sort()).toEqual(["qwen-asr", "qwen-worker"]);

  const worker = await backend.health("qwen-worker");
  expect(worker.service).toBe("Stopped");
  expect(worker.detail).toBe("model is not running");

  await expect(backend.ensure(systemdRuntime)).rejects.toMatchObject({ code: "resident_protected" });
  await expect(backend.stop("missing")).rejects.toBeInstanceOf(LifecycleError);
});

test("createRuntimeBackend routes Linux services to SystemdBackend", async () => {
  const backend = createRuntimeBackend([systemdRuntime], {
    systemd: { queryService: async () => "Stopped" },
  });
  const listed = await backend.list();
  expect(listed).toHaveLength(1);
  expect(listed[0]?.runtimeId).toBe("qwen-asr");
  expect(listed[0]?.service).toBe("Stopped");
});

test("routing isolates a failed backend observation", async () => {
  const failed: RuntimeBackend = {
    list: async () => { throw new Error("probe crashed"); },
    health: async () => { throw new Error("probe crashed"); },
    ensure: async () => { throw new Error("not used"); },
    stop: async () => undefined,
  };
  const healthy: RuntimeBackend = {
    list: async () => [{
      runtimeId: "healthy",
      service: "Running",
      listening: true,
      healthOk: true,
      busy: false,
    }],
    health: async () => ({
      runtimeId: "healthy",
      service: "Running",
      listening: true,
      healthOk: true,
      busy: false,
    }),
    ensure: async () => { throw new Error("not used"); },
    stop: async () => undefined,
  };
  const backend = new RoutingBackend(new Map([
    ["failed", failed],
    ["healthy", healthy],
  ]));
  expect(await backend.list()).toEqual([
    expect.objectContaining({
      runtimeId: "failed",
      service: "Unknown",
      detail: "backend observation failed: probe crashed",
    }),
    expect.objectContaining({ runtimeId: "healthy", healthOk: true }),
  ]);
});
