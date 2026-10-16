import { expect, test } from "bun:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { Observability, RequestObservation } from "./observability";
import { MetricsRegistry } from "./metrics";

test("background observations outlive response, retain correlation and finish once", async () => {
  const exporter = new InMemorySpanExporter();
  const metrics = new MetricsRegistry();
  const observation = new Observability(metrics, { sampleRatio: 1, exporter });
  try {
    const request = new RequestObservation(observation, new Request("http://fixture/v1/test"));
    request.bind("runtime", "protocol", "req_test");
    const cleanup = request.operation("request_cleanup")!;
    const end = cleanup.stage("terminal_callback");
    request.finish("http_200");
    await Bun.sleep(3); end(); cleanup.finish(); cleanup.finish();
    await observation.provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const root = spans.find(span => span.name === "larm.request")!;
    const child = spans.find(span => span.name === "larm.request_cleanup")!;
    expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(child.attributes["larm.request_id"]).toBe("req_test");
    expect(Number(child.attributes["larm.duration_ms.terminal_callback"])).toBeGreaterThan(1);
    expect(spans.filter(span => span.name === "larm.request_cleanup")).toHaveLength(1);
    expect(metrics.render()).toContain('operation="request_cleanup"');
    expect(metrics.render()).not.toContain("req_test");
  } finally { await observation.shutdown(); }
});

test("operation bounds and observation expiry never cancel application work", async () => {
  const metrics = new MetricsRegistry();
  const observation = new Observability(metrics, { maxOperations: 1, maxOperationAgeMs: 1 });
  const first = observation.operation("control_task")!;
  try {
    expect(observation.operation("control_task")).toBeUndefined();
    await Bun.sleep(3); observation.collect();
    expect(metrics.render()).toContain("larm_telemetry_operations_dropped_total 1");
    expect(metrics.render()).toContain("larm_telemetry_operations_expired_total 1");
    expect(await first.run(async () => "application still runs")).toBe("application still runs");
    expect(observation.operation("control_task")).toBeDefined();
  } finally { await observation.shutdown(); }
});
