import { expect, test } from "bun:test";
import type { Registry } from "@larm/core";
import type { RuntimeBackend, RuntimeHealth } from "@larm/backends";
import { Observer } from "./observer";

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
        service: "llama-server.service",
        healthPort: 8080,
        endpoint: "http://127.0.0.1:8080",
      },
    },
  ],
  profiles: [],
};

function stub(probe: RuntimeHealth): RuntimeBackend {
  return {
    list: async () => [probe],
    health: async () => probe,
    ensure: async () => probe,
    stop: async () => undefined,
  };
}

const startingProbe: RuntimeHealth = {
  runtimeId: "qwen-general",
  service: "Running",
  listening: true,
  healthOk: false,
  busy: false,
};

test("STARTING becomes FAILED after grace", async () => {
  let now = 1_000;
  const observer = new Observer(registry, stub(startingProbe), {
    graceMs: 300_000,
    now: () => now,
  });

  expect((await observer.tick()).runtimes[0]?.status).toBe("STARTING");
  now = 1_000 + 300_000;
  expect((await observer.tick()).runtimes[0]?.status).toBe("FAILED");
});
