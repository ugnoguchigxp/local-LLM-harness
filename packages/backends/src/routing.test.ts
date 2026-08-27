import { expect, test } from "bun:test";
import type { RuntimeDefinition } from "@larm/core";
import { LlamaSwapBackend } from "./llama-swap";
import { NssmBackend } from "./nssm";
import { createRuntimeBackend, RoutingBackend } from "./routing";
import { LifecycleError } from "./types";

const nssmRuntime: RuntimeDefinition = {
  id: "qwen-general",
  capability: ["llm.general"],
  backend: "nssm",
  node: "ai395-01",
  policy: { class: "resident" },
  resources: { estimatedMemoryGB: 24 },
  deployment: {
    service: "llama-qwen-27b-backend",
    healthPort: 1,
    endpoint: "http://127.0.0.1:50043",
  },
};

const swapRuntime: RuntimeDefinition = {
  id: "qwen-worker",
  capability: ["llm.general"],
  backend: "llama-swap",
  node: "ai395-01",
  policy: { class: "preferred" },
  resources: { estimatedMemoryGB: 24 },
  deployment: {
    modelId: "qwen-worker",
    listen: "http://127.0.0.1:9",
    endpoint: "http://127.0.0.1:9",
  },
};

test("routes list and lifecycle to the owning backend", async () => {
  const nssm = new NssmBackend([nssmRuntime], {
    queryService: async () => "Stopped",
  });
  const swap = new LlamaSwapBackend([swapRuntime], {
    request: async () => ({ ok: true, status: 200, body: `{"running":[]}` }),
  });
  const backend = new RoutingBackend(
    new Map([
      ["qwen-general", nssm],
      ["qwen-worker", swap],
    ]),
  );

  const listed = await backend.list();
  expect(listed.map((item) => item.runtimeId).sort()).toEqual(["qwen-general", "qwen-worker"]);

  const worker = await backend.health("qwen-worker");
  expect(worker.service).toBe("Stopped");
  expect(worker.detail).toBe("model is not running");

  await expect(backend.ensure(nssmRuntime)).rejects.toMatchObject({ code: "resident_protected" });
  await expect(backend.stop("missing")).rejects.toBeInstanceOf(LifecycleError);
});

test("createRuntimeBackend keeps production nssm runtimes on NssmBackend", async () => {
  const backend = createRuntimeBackend([nssmRuntime], {
    nssm: { queryService: async () => "Stopped" },
  });
  const listed = await backend.list();
  expect(listed).toHaveLength(1);
  expect(listed[0]?.runtimeId).toBe("qwen-general");
  expect(listed[0]?.service).toBe("Stopped");
});
