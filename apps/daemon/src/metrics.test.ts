import { expect, test } from "bun:test";
import { MetricsRegistry, RequestTracker } from "./metrics";

test("metrics aggregate counters without logging request content", () => {
  const metrics = new MetricsRegistry();
  metrics.record({ name: "allocation_ready", labels: { route: "llm-default" } });
  metrics.record({ name: "allocation_ready", labels: { route: "llm-default" } });
  expect(metrics.render()).toBe('larm_allocation_ready_total{route="llm-default"} 2\n');
});

test("metrics discard identifiers and combinatorial labels to bound cardinality", () => {
  const metrics = new MetricsRegistry();
  metrics.record({
    name: "allocation_ready",
    labels: {
      route: "llm-default",
      allocation: "alloc_1",
      client: "client_1",
      routes: "llm-default,llm-speed",
      runtimes: "qwen-general,qwen-worker",
      reasons: "primary-live,fallback-live",
    },
  });
  metrics.record({
    name: "allocation_ready",
    labels: {
      route: "llm-default",
      allocation: "alloc_2",
      client: "client_2",
      routes: "llm-default",
      runtimes: "qwen-general",
      reasons: "primary-live",
    },
  });
  expect(metrics.render()).toBe('larm_allocation_ready_total{route="llm-default"} 2\n');
});

test("metrics expose duration samples as sum and count", () => {
  const metrics = new MetricsRegistry();
  metrics.record({ name: "gateway_duration_seconds", value: 1.25 });
  metrics.record({ name: "gateway_duration_seconds", value: 0.75 });
  expect(metrics.render()).toBe(
    "larm_gateway_duration_seconds_count 2\nlarm_gateway_duration_seconds_sum 2\n",
  );
});

test("execution gauges replace their current value and discard high-cardinality labels", () => {
  const metrics = new MetricsRegistry();
  metrics.setGauge("execution_active", { runtime: "qwen-general", request: "one" }, 1);
  metrics.setGauge("execution_active", { runtime: "qwen-general", request: "two" }, 0);
  expect(metrics.render()).toBe('larm_execution_active{runtime="qwen-general"} 0\n');
});

test("request tracker drains after all requests finish", async () => {
  const tracker = new RequestTracker();
  const finish = tracker.begin();
  const draining = tracker.drain(1_000);
  expect(tracker.count()).toBe(1);
  finish();
  expect(await draining).toBe(true);
  expect(tracker.count()).toBe(0);
});

test("request tracker can drain successfully after an earlier drain timeout", async () => {
  const tracker = new RequestTracker();
  const finish = tracker.begin();
  expect(await tracker.drain(0)).toBe(false);
  const draining = tracker.drain(1_000);
  finish();
  expect(await draining).toBe(true);
});
