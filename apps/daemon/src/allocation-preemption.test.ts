import { expect, test } from "bun:test";
import type { Allocation, Registry } from "@larm/core";
import { AllocationPreemption } from "./allocation-preemption";

const registry = {
  nodes: [{ id: "local-node", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 32, reservedMemoryGB: 2 } }],
  profiles: [],
  runtimes: [
    { id: "resident-a", capability: ["llm.general"], protocol: "test", backend: "systemd", node: "local-node", path: "/tmp/a", deployment: "on-demand", resources: { memoryGB: 2 }, policy: { class: "resident", swapGroup: "llm" } },
    { id: "worker-b", capability: ["llm.general"], protocol: "test", backend: "systemd", node: "local-node", path: "/tmp/b", deployment: "on-demand", resources: { memoryGB: 2 }, policy: { class: "preferred", swapGroup: "llm" } },
    { id: "other", capability: ["stt"], protocol: "test", backend: "systemd", node: "local-node", path: "/tmp/c", deployment: "on-demand", resources: { memoryGB: 2 }, policy: { class: "preferred" } },
  ],
} as unknown as Registry;

function allocation(input: {
  id: string;
  runtime: string;
  priority: number;
  status?: string;
}): Allocation {
  return {
    id: input.id,
    priority: input.priority,
    status: input.status ?? "ready",
    bindings: [{ runtime: input.runtime }],
  } as unknown as Allocation;
}

test("preemption selects only admitted lower-priority allocations with exclusive resource overlap", () => {
  const preemption = new AllocationPreemption(registry);
  const calls: string[] = [];
  const resources = (runtimeIds: string[]) => new Set(runtimeIds.map((runtime) =>
    runtime === "resident-a" || runtime === "worker-b" ? "llm" : runtime
  ));

  preemption.preemptLowerPriorityConflicts({
    priority: 3_000,
    runtimeIds: ["worker-b"],
    allocations: [
      allocation({ id: "victim", runtime: "resident-a", priority: 2_000 }),
      allocation({ id: "peer", runtime: "other", priority: 1_000 }),
      allocation({ id: "equal", runtime: "resident-a", priority: 3_000 }),
      allocation({ id: "waiting", runtime: "resident-a", priority: 1_000, status: "waiting" }),
    ],
    exclusiveResourceKeys: resources,
    preempt: (id, priority) => calls.push(`${id}:${priority}`),
  });

  expect(calls).toEqual(["victim:3000"]);
});

test("foreground provider holds delay lower-priority swap-group switches and expire", () => {
  let now = 1_000;
  const events: Array<{ name: string; labels: Record<string, string> }> = [];
  const preemption = new AllocationPreemption(registry, {
    now: () => now,
    providerSwitchHoldMs: 300,
    emit: (name, labels) => events.push({ name, labels }),
  });

  preemption.holdForegroundProviders(allocation({ id: "fg", runtime: "resident-a", priority: 3_000 }));
  expect(preemption.holdUntil(["worker-b"], 2_000)).toBe(1_300);
  expect(preemption.holdUntil(["resident-a"], 2_000)).toBeUndefined();
  expect(preemption.holdUntil(["worker-b"], 3_000)).toBeUndefined();
  expect(events).toHaveLength(1);
  now = 1_300;
  expect(preemption.holdUntil(["worker-b"], 2_000)).toBeUndefined();
});

test("foreground provider holds extend monotonically and can be disabled", () => {
  let now = 10;
  const preemption = new AllocationPreemption(registry, {
    now: () => now,
    providerSwitchHoldMs: 100,
  });
  preemption.holdForegroundProviders(allocation({ id: "first", runtime: "resident-a", priority: 3_000 }));
  now = 20;
  preemption.holdForegroundProviders(allocation({ id: "second", runtime: "worker-b", priority: 4_000 }));
  expect(preemption.holdUntil(["resident-a"], 3_500)).toBe(120);
  expect(preemption.holdUntil(["resident-a"], 3_999)).toBe(120);

  const disabled = new AllocationPreemption(registry, { now: () => now, providerSwitchHoldMs: 0 });
  disabled.holdForegroundProviders(allocation({ id: "no-hold", runtime: "resident-a", priority: 4_000 }));
  expect(disabled.holdUntil(["worker-b"], 1_000)).toBeUndefined();
});
