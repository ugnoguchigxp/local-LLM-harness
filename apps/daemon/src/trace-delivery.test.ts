import { expect, test } from "bun:test";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { Observability } from "./observability";

test("slow exporter has bounded queue and reports dropped spans without awaiting export", async () => {
  let blocked = true;
  const callbacks: Array<Parameters<SpanExporter["export"]>[1]> = [];
  const observation = new Observability(undefined, { sampleRatio: 1, exportQueueSize: 4, exportBatchSize: 1, exporter: {
    export(_spans, callback) { if (blocked) callbacks.push(callback); else callback({ code: 0 }); }, async shutdown() {},
  } });
  try {
    for (let i = 0; i < 100; i++) observation.provider.getTracer("test").startSpan("test").end();
    expect(callbacks).toHaveLength(0); // Encoding/export has not run inside span.end().
    const state = observation.delivery!.snapshot();
    expect(state.queued).toBeLessThanOrEqual(4);
    expect(state.inFlight).toBe(1);
    expect(state.capacityDropped).toBeGreaterThan(0);
    blocked = false;
    for (const callback of callbacks) callback({ code: 0 });
    await observation.provider.forceFlush();
    expect(observation.delivery!.snapshot()).toMatchObject({ queued: 0, inFlight: 0, failedSpans: 0 });
    expect(observation.delivery!.snapshot().exported + state.capacityDropped).toBe(100);
  } finally { await observation.shutdown(); }
});

test("stalled export times out once and ignores late completion", async () => {
  let late: Parameters<SpanExporter["export"]>[1] | undefined;
  const observation = new Observability(undefined, { sampleRatio: 1, exportTimeoutMs: 10, exporter: {
    export(_spans, callback) { late = callback; }, async shutdown() {},
  } });
  try {
    observation.provider.getTracer("test").startSpan("test").end();
    await observation.provider.forceFlush().catch(() => undefined);
    expect(observation.delivery!.snapshot()).toMatchObject({ inFlight: 0, failedBatches: 1, failedSpans: 1, exported: 0 });
    late?.({ code: 0 });
    expect(observation.delivery!.snapshot().exported).toBe(0);
  } finally { await observation.shutdown(); }
});
