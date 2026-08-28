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
  ],
  profiles: [],
  routes: [],
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

test("concurrent ticks share one backend observation", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend: RuntimeBackend = {
    list: async () => {
      calls += 1;
      await gate;
      return [];
    },
    health: async () => ({
      runtimeId: "qwen-general",
      service: "Unknown",
      listening: false,
      healthOk: false,
      busy: false,
    }),
    ensure: async () => { throw new Error("not used"); },
    stop: async () => undefined,
  };
  const observer = new Observer(registry, backend);
  const first = observer.tick();
  const second = observer.tick();
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
});

test("telemetry failure degrades telemetry without losing runtime observation", async () => {
  const observer = new Observer(registry, stub({
    ...startingProbe,
    healthOk: true,
  }), {
    telemetry: { observe: async () => { throw new Error("sensor unavailable"); } },
  });
  const state = await observer.tick();
  expect(state.runtimes[0]?.status).toBe("HOT");
  expect(state.node.telemetry).toMatchObject({
    status: "unavailable",
    source: "observer",
    detail: "sensor unavailable",
  });
});
