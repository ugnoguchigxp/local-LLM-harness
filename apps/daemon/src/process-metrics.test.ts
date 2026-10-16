import { expect, test } from "bun:test";
import { MetricsRegistry } from "./metrics";
import { startProcessMetrics } from "./process-metrics";

test("process sampler reports finite local measurements and stops its timer", async () => {
  const metrics = new MetricsRegistry();
  const stop = startProcessMetrics(metrics, 5);
  try { await Bun.sleep(20); } finally { stop(); }
  const rendered = metrics.render();
  expect(rendered).toContain("larm_process_resident_memory_bytes ");
  expect(rendered).toContain("larm_process_cpu_cores ");
  expect(rendered).toContain("larm_event_loop_delay_seconds_count ");
  expect(rendered).not.toMatch(/NaN|Infinity/);
  await Bun.sleep(10);
  expect(metrics.render()).toBe(rendered);
});
