import { expect, test } from "bun:test";
import type { Allocation } from "./allocation";
import { admitRuntimes } from "./admission";
import { promptRetentionPolicySchema } from "./prompt-retention";
import type { Registry } from "./registry";
import type { ClusterState, RuntimeSnapshot } from "./schema";

const registry: Registry = {
  nodes: [
    {
      id: "local-node",
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 64, reservedMemoryGB: 16 },
    },
  ],
  runtimes: [
    {
      id: "resident",
      capability: ["llm.general"],
      protocol: "openai.chat-completions.v1",
      backend: "systemd",
      node: "local-node",
      policy: { class: "resident" },
      resources: { estimatedMemoryGB: 24, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 100 },
      deployment: { service: "resident", healthPort: 1, endpoint: "http://127.0.0.1:1" },
    },
    {
      id: "worker",
      capability: ["llm.general", "llm.coding"],
      protocol: "openai.chat-completions.v1",
      backend: "systemd",
      node: "local-node",
      policy: { class: "preferred" },
      resources: {
        estimatedMemoryGB: 24,
        maxConcurrentAllocations: 1,
        maxConcurrentRequests: 1,
        maxQueuedRequests: 0,
        queueTimeoutMs: 100,
      },
      deployment: { service: "worker", healthPort: 2, endpoint: "http://127.0.0.1:2" },
    },
  ],
  profiles: [],
  routes: [],
};

function snapshot(id: string, status: RuntimeSnapshot["status"]): RuntimeSnapshot {
  const runtime = registry.runtimes.find((item) => item.id === id)!;
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

function state(runtimes: RuntimeSnapshot[]): ClusterState {
  return {
    generatedAt: "2026-08-28T00:00:00.000Z",
    node: {
      id: "local-node",
      online: true,
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 64, reservedMemoryGB: 16 },
    },
    runtimes,
  };
}

function allocation(runtime: string): Allocation {
  return {
    id: "alloc_existing",
    bootEpoch: "epoch-test",
    status: "ready",
    requirements: [{ capability: "llm.general", route: "llm-speed" }],
    bindings: [{
      capability: "llm.general",
      route: "llm-speed",
      runtime,
      node: "local-node",
      endpoint: "http://127.0.0.1:2",
      status: "HOT",
      candidateRank: 1,
      fallback: false,
      selectionReason: "primary-live",
    }],
    allowFallback: false,
    deploymentPolicy: "existing-only",
    createdAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2026-08-28T00:05:00.000Z",
  };
}

const gib = 1024 ** 3;
function live(runtimes: RuntimeSnapshot[] = [], free = 40) {
  const value = state(runtimes);
  value.node.telemetry = { status: "available", observedAt: value.generatedAt, source: "test",
    systemMemoryTotalBytes: 64*gib, systemMemoryAvailableBytes: free*gib };
  return value;
}
const fresh = { requiredForNonResident: true, maxAgeMs: 1000, now: Date.parse("2026-08-28T00:00:00Z") };
function check(observed = live(), extra: Partial<Parameters<typeof admitRuntimes>[0]> = {}) {
  return admitRuntimes({registry, state:observed, allocations:[], candidateRuntimeIds:["worker"], liveTelemetry:fresh, ...extra});
}
test("live admission ignores old runtime estimates, cache maxima and service reservations", () => {
  const changed = structuredClone(registry);
  changed.runtimes[0]!.resources.estimatedMemoryGB = 1000;
  changed.runtimes[1]!.resources.estimatedMemoryGB = 1000;
  changed.runtimes[0]!.promptRetention = promptRetentionPolicySchema.parse({});
  expect(check(live(), {registry:changed, serviceReservations:[{node:"local-node",bytes:1000*gib,pendingBytes:1000*gib}]}))
    .toMatchObject({ok:true,nodes:[{incrementalMemoryGB:0, liveAvailableMemoryGB:40,effectiveLiveAvailableMemoryGB:24}]});
});
test("cold starts need fresh physical headroom above the host floor", () => {
  expect(check(live([],16))).toMatchObject({ok:false,reason:"live_memory_exhausted"});
  expect(check(live([],17)).ok).toBe(true);
  expect(check(state([]))).toMatchObject({ok:false,reason:"telemetry_unavailable"});
  expect(check(live(),{liveTelemetry:{...fresh,now:fresh.now+2000}})).toMatchObject({ok:false,reason:"telemetry_unavailable"});
});
test("accelerator and system headroom are not added on UMA", () => {
  const value=live(); value.node.telemetry!.acceleratorMemoryAvailableBytes=10*gib;
  expect(check(value)).toMatchObject({ok:false,reason:"live_memory_exhausted"});
});
test("pending references do not reserve a guessed number of bytes", () => {
  expect(check(live([snapshot("resident","STARTING")]),{allocations:[allocation("resident")]}).ok).toBe(true);
});
test("warm reuse and resident lifecycle do not require a new cold allocation", () => {
  expect(check(live([snapshot("worker","HOT")],0)).ok).toBe(true);
  expect(check(state([]),{candidateRuntimeIds:["resident"]}).ok).toBe(true);
});
test("allocation capacity is enforced independently of physical memory", () => {
  expect(check(live([snapshot("worker","HOT")]),{allocations:[allocation("worker")]}))
    .toMatchObject({ok:false,reason:"runtime_capacity",runtime:"worker"});
});
test("unknown runtime and node references remain rejected", () => {
  expect(check(live(),{candidateRuntimeIds:["missing"]})).toMatchObject({ok:false,reason:"unknown_runtime"});
  expect(check(live(),{registry:{...registry,nodes:[]}})).toMatchObject({ok:false,reason:"unknown_node"});
});
test("two members of one swap group cannot be requested together", () => {
  const changed=structuredClone(registry); changed.runtimes.forEach(r=>{r.policy.swapGroup="shared";});
  expect(check(live(),{registry:changed,candidateRuntimeIds:["resident","worker"]})).toMatchObject({ok:false,reason:"swap_group_conflict"});
});
test("duplicate requirements do not duplicate physical accounting", () => {
  expect(check(live(),{candidateRuntimeIds:["worker","worker"]})).toMatchObject({ok:true,nodes:[{incrementalMemoryGB:0}]});
  expect(check(live(),{candidateRuntimeIds:["worker","worker"]}).nodes).toHaveLength(1);
});
test("offline structural validation does not fabricate a memory reservation", () => {
  expect(check(state([]),{liveTelemetry:undefined})).toEqual({ok:true,nodes:[]});
});
