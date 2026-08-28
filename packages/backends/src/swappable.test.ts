import { expect, test } from "bun:test";
import type { RuntimeBackend } from "./types";
import { SwappableRuntimeBackend } from "./swappable";

function backend(id: string): RuntimeBackend {
  return {
    list: async () => [{
      runtimeId: id,
      service: "Running",
      listening: true,
      healthOk: true,
      busy: false,
    }],
    health: async (runtimeId) => ({
      runtimeId,
      service: "Running",
      listening: true,
      healthOk: true,
      busy: false,
    }),
    ensure: async (runtime) => ({
      runtimeId: runtime.id,
      service: "Running",
      listening: true,
      healthOk: true,
      busy: false,
    }),
    stop: async () => undefined,
  };
}

test("swappable runtime backend changes delegates atomically", async () => {
  const routed = new SwappableRuntimeBackend(backend("old"));
  expect((await routed.list())[0]?.runtimeId).toBe("old");
  routed.replace(backend("new"));
  expect((await routed.list())[0]?.runtimeId).toBe("new");
});
