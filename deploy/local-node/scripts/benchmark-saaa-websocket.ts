import { encodeSaaaDelta } from "../../../packages/core/src/index";

const DEFAULT_ITERATIONS = 10_000;
const MIN_ITERATIONS = 1_000;
const MAX_DURATION_MS_AT_10K = 250;
const MAX_RSS_DELTA_BYTES = 16 * 1024 * 1024;

function percentile(sorted: Float64Array, fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function runSaaaCodecBenchmark(iterations = DEFAULT_ITERATIONS) {
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > 1_000_000) {
    throw new Error("benchmark iterations must be an integer in 1000..1000000");
  }
  const payload = new TextEncoder().encode("x".repeat(20));
  for (let index = 0; index < 1_000; index += 1) encodeSaaaDelta(index + 1, payload);
  Bun.gc(true);
  const rssBefore = process.memoryUsage.rss();
  let peakRss = rssBefore;
  const samples = new Float64Array(iterations);
  let wireBytes = 0;
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const sampleStartedAt = performance.now();
    const frame = encodeSaaaDelta(index + 1, payload);
    samples[index] = (performance.now() - sampleStartedAt) * 1_000;
    if (frame.byteLength !== 36) throw new Error("binary delta overhead is not exactly 16 bytes");
    wireBytes += frame.byteLength;
    if ((index & 63) === 0) peakRss = Math.max(peakRss, process.memoryUsage.rss());
  }
  const durationMs = performance.now() - startedAt;
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  Bun.gc(true);
  const settledRss = process.memoryUsage.rss();
  peakRss = Math.max(peakRss, settledRss);
  samples.sort();
  const scaledDurationLimitMs = MAX_DURATION_MS_AT_10K * (iterations / DEFAULT_ITERATIONS);
  const report = {
    benchmark: "saaa.llm-stream.v1-binary-delta",
    iterations,
    payloadBytes: payload.byteLength,
    headerBytes: 16,
    wireBytes,
    durationMs,
    latencyMicroseconds: {
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      p99: percentile(samples, 0.99),
    },
    memory: {
      rssBefore,
      peakRss,
      settledRss,
      peakDeltaBytes: Math.max(0, peakRss - rssBefore),
      settledDeltaBytes: Math.max(0, settledRss - rssBefore),
    },
    limits: {
      durationMs: scaledDurationLimitMs,
      peakRssDeltaBytes: MAX_RSS_DELTA_BYTES,
    },
  };
  if (durationMs > scaledDurationLimitMs) {
    throw new Error(`SAAA binary delta duration ${durationMs.toFixed(2)} ms exceeds ${scaledDurationLimitMs} ms`);
  }
  if (report.memory.peakDeltaBytes > MAX_RSS_DELTA_BYTES) {
    throw new Error(`SAAA binary delta RSS growth ${report.memory.peakDeltaBytes} exceeds ${MAX_RSS_DELTA_BYTES}`);
  }
  return report;
}

if (import.meta.main) {
  const iterations = Number(process.env.LARM_SAAA_BENCHMARK_ITERATIONS ?? DEFAULT_ITERATIONS);
  console.log(JSON.stringify(runSaaaCodecBenchmark(iterations), null, 2));
}
