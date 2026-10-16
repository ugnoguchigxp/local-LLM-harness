import { expect, test } from "bun:test";
import { observationHistograms, observationDelta } from "./performance-observation";

test("scenario snapshots subtract prior traffic and label percentiles as bucket upper bounds", () => {
  const before = observationHistograms('larm_operation_stage_seconds_count{stage="queue_wait"} 1\nlarm_operation_stage_seconds_sum{stage="queue_wait"} 0.001\nlarm_operation_stage_seconds_bucket{stage="queue_wait",le="0.001"} 1\nlarm_operation_stage_seconds_bucket{stage="queue_wait",le="0.005"} 1\nlarm_operation_stage_seconds_bucket{stage="queue_wait",le="+Inf"} 1');
  const after = observationHistograms('larm_operation_stage_seconds_count{stage="queue_wait"} 3\nlarm_operation_stage_seconds_sum{stage="queue_wait"} 0.009\nlarm_operation_stage_seconds_bucket{stage="queue_wait",le="0.001"} 1\nlarm_operation_stage_seconds_bucket{stage="queue_wait",le="0.005"} 3\nlarm_operation_stage_seconds_bucket{stage="queue_wait",le="+Inf"} 3');
  expect(observationDelta(before, after)).toEqual({ resetDetected: false, histograms: [{ family: "operation_stage_seconds", labels: { stage: "queue_wait" }, count: 2, sumMs: 8, meanMs: 4, p50UpperBoundMs: 5, p95UpperBoundMs: 5, maxUpperBoundMs: 5 }] });
  expect(observationDelta(after, before).resetDetected).toBe(true);
});

test("unbounded final bucket remains unknown and unrelated metrics are excluded", () => {
  const current = observationHistograms('larm_request_stage_seconds_count{stage="total"} 1\nlarm_request_stage_seconds_sum{stage="total"} 500\nlarm_request_stage_seconds_bucket{stage="total",le="+Inf"} 1\nlarm_prompt_text_total{secret="excluded"} 9');
  expect(observationDelta(new Map(), current).histograms[0]).toMatchObject({ p95UpperBoundMs: null, maxUpperBoundMs: null });
  expect(current.size).toBe(1);
});
