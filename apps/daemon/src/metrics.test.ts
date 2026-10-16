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
      releases: "qwen-general-r1,qwen-worker-r2",
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
      releases: "qwen-general-r1",
      reasons: "primary-live",
    },
  });
  expect(metrics.render()).toBe('larm_allocation_ready_total{route="llm-default"} 2\n');
});

test("metrics expose duration samples as sum and count", () => {
  const metrics = new MetricsRegistry();
  metrics.record({ name: "gateway_duration_seconds", value: 1.25 });
  metrics.record({ name: "gateway_duration_seconds", value: 0.75 });
  const rendered = metrics.render();
  expect(rendered).toContain("larm_gateway_duration_seconds_count 2\n");
  expect(rendered).toContain("larm_gateway_duration_seconds_sum 2\n");
  expect(rendered).toContain('larm_gateway_duration_seconds_bucket{le="1"} 1\n');
  expect(rendered).toContain('larm_gateway_duration_seconds_bucket{le="2.5"} 2\n');
  expect(rendered).toContain('larm_gateway_duration_seconds_bucket{le="+Inf"} 2\n');
});

test("duration metrics clamp clock regressions to zero", () => {
  const metrics = new MetricsRegistry();
  metrics.record({ name: "gateway_ttfb_seconds", value: -1 });
  const rendered = metrics.render();
  expect(rendered).toContain("larm_gateway_ttfb_seconds_sum 0\n");
  expect(rendered).toContain('larm_gateway_ttfb_seconds_bucket{le="0.01"} 1\n');
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


test("compact histograms preserve cumulative boundaries across repeated scrapes and reject nonfinite samples", () => {
  const metrics = new MetricsRegistry();
  for (const value of [0.0001, 0.000101, 300, 301, NaN, Infinity]) metrics.record({ name: "sample_seconds", value });
  const first = metrics.render(); expect(metrics.render()).toBe(first);
  expect(first).toContain('larm_sample_seconds_bucket{le="0.0001"} 1');
  expect(first).toContain('larm_sample_seconds_bucket{le="0.00025"} 2');
  expect(first).toContain('larm_sample_seconds_bucket{le="300"} 3');
  expect(first).toContain('larm_sample_seconds_bucket{le="+Inf"} 4');
  expect(first).toContain("larm_sample_seconds_count 4");
  metrics.record({ name: "sample_seconds", value: 0 });
  expect(metrics.render()).toContain('larm_sample_seconds_bucket{le="0.0001"} 2');
});
test("compiled duration recorder and general observations share cumulative histogram semantics", () => {
  const metrics = new MetricsRegistry();
  const record = metrics.durationRecorder("probe_seconds");
  record(0.0001); record(0.001); record(Number.NaN);
  metrics.record({ name: "probe_seconds", value: 1 });
  expect(metrics.render()).toContain("larm_probe_seconds_count 3");
  expect(metrics.render()).toContain('larm_probe_seconds_bucket{le="0.001"} 2');
  expect(metrics.render()).toContain('larm_probe_seconds_bucket{le="1"} 3');
  expect(metrics.render()).toBe(metrics.render());
});
