import { expect, test } from "bun:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import type { Registry } from "@larm/core";
import type { RuntimeBackend, RuntimeHealth } from "@larm/backends";
import { ControlPlane } from "./controller";
import { Observer } from "./observer";
import { Observability } from "./observability";
import { MetricsRegistry } from "./metrics";

const registry: Registry = {
  nodes: [{ id: "test", displayName: "test", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 128, reservedMemoryGB: 16 } }], profiles: [],
  runtimes: ["a", "b"].map(id => ({ id, capability: [`llm.${id}`], protocol: "openai.chat-completions.v1", backend: "systemd", node: "test", policy: { class: "preferred" },
    resources: { estimatedMemoryGB: 1, maxConcurrentRequests: 1, maxQueuedRequests: 1, queueTimeoutMs: 1000 },
    deployment: { service: `${id}.service`, healthPort: 8080, endpoint: `http://127.0.0.1/${id}`, backendEndpoint: `http://127.0.0.1/${id}` } })),
  routes: ["a", "b"].map(id => ({ id: `route-${id}`, capabilities: [`llm.${id}`], explicitOnly: true, candidates: [{ runtime: id, purpose: "primary" }] })),
};

test("control queue observes head-of-line waiting and preserves allocation startup order", async () => {
  const exporter = new InMemorySpanExporter(); const metrics = new MetricsRegistry();
  const observability = new Observability(metrics, { exporter, sampleRatio: 1 });
  let unblock!: () => void; const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let entered!: () => void; const firstStarted = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = []; const running = new Set<string>();
  const health = (id: string): RuntimeHealth => ({ runtimeId: id, service: running.has(id) ? "Running" : "Stopped", listening: running.has(id), healthOk: running.has(id), busy: false });
  const backend: RuntimeBackend = {
    list: async () => [health("a"), health("b")], health: async id => health(id),
    ensure: async runtime => { calls.push(runtime.id); if (runtime.id === "a") { entered(); await blocked; } running.add(runtime.id); return health(runtime.id); },
    stop: async id => { running.delete(id); },
  };
  const observer = new Observer(registry, backend); await observer.tick();
  const control = new ControlPlane(registry, backend, observer, { observability, pollIntervalMs: 1, idleTtlMs: 0 });
  const allocate = (id: string) => control.allocate({ requirements: [{ capability: `llm.${id}`, route: `route-${id}` }], allowFallback: false, deploymentPolicy: "existing-only", ttlSeconds: 30, priority: 0, capacityPolicy: "reject" });
  try {
    expect((await allocate("a")).status).toBe(202); await firstStarted;
    expect((await allocate("b")).status).toBe(202);
    await Bun.sleep(5);
    expect(metrics.render()).toContain("larm_control_tasks_queued 1");
    expect(calls).toEqual(["a"]);
    unblock(); await control.flush();
    expect(calls).toEqual(["a", "b"]);
    await observability.provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const queued = spans.filter(span => span.name === "larm.control_task");
    expect(queued).toHaveLength(2);
    expect(queued.some(span => Number(span.attributes["larm.duration_ms.queue_wait"]) >= 4)).toBe(true);
    expect(spans.some(span => span.name === "larm.runtime_startup" && span.attributes["larm.health_probe_count"] === 1)).toBe(true);
    expect(metrics.render()).toContain("larm_control_tasks_active 0");
  } finally { unblock(); control.beginDrain(); await control.flush(); await observability.shutdown(); }
});
