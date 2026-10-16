import { PerformanceObserver } from "node:perf_hooks";
import type { MetricsRegistry } from "./metrics";
import { safely } from "./observability";

/** Low frequency, process-local measurements. CPU 1.0 means one fully used core. */
export function startProcessMetrics(metrics: MetricsRegistry, intervalMs = 1000): () => void {
  let previous = performance.now();
  let cpu = process.cpuUsage();
  let gc: PerformanceObserver | undefined;
  safely(() => {
    if (!PerformanceObserver.supportedEntryTypes.includes("gc")) return;
    gc = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) safely(() => metrics.record({ name: "process_gc_pause_seconds", value: entry.duration / 1000 }));
    });
    gc.observe({ entryTypes: ["gc"] });
  });
  const timer = setInterval(() => safely(() => {
    const now = performance.now();
    const elapsed = now - previous;
    const nextCpu = process.cpuUsage();
    metrics.record({ name: "event_loop_delay_seconds", value: Math.max(0, elapsed - intervalMs) / 1000 });
    metrics.setGauge("process_cpu_cores", {}, (nextCpu.user + nextCpu.system - cpu.user - cpu.system) / (elapsed * 1000));
    const memory = process.memoryUsage();
    metrics.setGauge("process_resident_memory_bytes", {}, memory.rss);
    metrics.setGauge("process_heap_used_bytes", {}, memory.heapUsed);
    previous = now;
    cpu = nextCpu;
  }), intervalMs);
  timer.unref();
  return () => { clearInterval(timer); gc?.disconnect(); };
}
