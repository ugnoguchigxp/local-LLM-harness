import { describe, expect, test } from "bun:test";
import type { Allocation, Registry } from "@larm/core";
import type { RuntimeBackend } from "@larm/backends";
import { startAndVerifyAllocationRuntimes } from "./allocation-runtime-startup";

const registry = {
  nodes: [],
  profiles: [],
  routes: [],
  runtimes: [{ id: "runtime", policy: {} }],
} as unknown as Registry;

function allocation(): Allocation {
  return {
    id: "allocation",
    status: "starting",
    deploymentPolicy: "existing-only",
    bindings: [{ runtime: "runtime", status: "COLD" }],
  } as unknown as Allocation;
}

const instance = {
  id: "instance",
  runtimeId: "runtime",
  revision: "revision",
  generation: 1,
  endpoint: "http://127.0.0.1:8080",
};

function input(overrides: Record<string, unknown> = {}) {
  const candidate = allocation();
  const phases: string[] = [];
  return {
    candidate,
    phases,
    options: {
      allocation: candidate,
      registry,
      backend: { ensureInstance: true } as unknown as RuntimeBackend,
      observer: {
        getState: () => ({ runtimes: [{ id: "runtime", status: "COLD" }] }),
        tick: async () => ({ runtimes: [{ id: "runtime", status: "HOT" }] }),
      },
      providerInstances: { acquire: async () => instance },
      deadline: 100,
      signal: new AbortController().signal,
      isActive: () => true,
      deploymentPolicy: candidate.deploymentPolicy,
      now: () => 10,
      sleep: async () => {},
      pollIntervalMs: 1,
      setPhase: (phase: string) => phases.push(phase),
      ...overrides,
    },
  };
}

describe("allocation runtime startup", () => {
  test("starts each distinct runtime, records its instance, and verifies HOT readiness", async () => {
    const calls: string[] = [];
    const fixture = input({
      allocation: {
        ...allocation(),
        bindings: [
          { runtime: "runtime", status: "COLD" },
          { runtime: "runtime", status: "COLD" },
        ],
      },
      providerInstances: {
        acquire: async (...args: unknown[]) => {
          calls.push(String(args[0] && (args[0] as { id: string }).id));
          return instance;
        },
      },
    });

    const result = await startAndVerifyAllocationRuntimes(fixture.options as never);

    expect(result).toBe("ready");
    expect(calls).toEqual(["runtime"]);
    expect(fixture.options.allocation.bindings).toEqual([
      expect.objectContaining({ instanceId: "instance", providerRevision: "revision" }),
      expect.objectContaining({ instanceId: "instance", providerRevision: "revision" }),
    ]);
    expect(fixture.phases).toEqual(["starting-runtime", "verifying-runtime", "runtime-ready"]);
  });

  test("times out only after observing non-ready runtime state", async () => {
    const fixture = input({
      observer: {
        getState: () => ({ runtimes: [{ id: "runtime", status: "COLD" }] }),
        tick: async () => ({ runtimes: [{ id: "runtime", status: "COLD" }] }),
      },
      now: () => 100,
    });

    await expect(startAndVerifyAllocationRuntimes(fixture.options as never)).resolves.toBe("timed_out");
    expect(fixture.options.allocation.bindings[0]?.status).toBe("COLD");
  });

  test("fails allow-listed startup when deployment is unavailable", async () => {
    const fixture = input();
    fixture.options.allocation.deploymentPolicy = "allow-listed";
    await expect(startAndVerifyAllocationRuntimes(fixture.options as never))
      .rejects.toThrow("allow-listed deployment is not configured");
  });
});
