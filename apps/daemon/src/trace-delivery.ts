import { TraceFlags } from "@opentelemetry/api";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Bounded SDK batching with independent delivery health; never blocks span.end(). */
export class TraceDelivery implements SpanProcessor {
  private readonly batch: BatchSpanProcessor;
  private closed = false;
  private queued = 0;
  private inFlight = 0;
  private exported = 0;
  private capacityDropped = 0;
  private failedSpans = 0;
  private failedBatches = 0;
  private readonly pending = new Set<Promise<void>>();

  constructor(exporter: SpanExporter, private readonly limit = 2048, batchSize = 256, timeoutMs = 2000) {
    const monitored: SpanExporter = {
      export: (spans, callback) => {
        this.queued -= spans.length;
        this.inFlight += spans.length;
        let settle!: () => void;
        const pending = new Promise<void>(resolve => { settle = resolve; });
        this.pending.add(pending);
        let done = false;
        const complete: typeof callback = result => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.inFlight -= spans.length;
          this.pending.delete(pending); settle();
          if (result.code === 0) this.exported += spans.length;
          else { this.failedSpans += spans.length; this.failedBatches++; }
          callback(result);
        };
        const timer = setTimeout(() => complete({ code: 1, error: new Error("trace export timeout") }), timeoutMs);
        timer.unref?.();
        // Some OTLP encoders serialize synchronously in export(). Leave the
        // response/slot-release call stack before beginning that batch work.
        setImmediate(() => {
          if (done) return;
          try { exporter.export(spans, complete); }
          catch { complete({ code: 1, error: new Error("trace exporter unavailable") }); }
        });
      },
      shutdown: () => exporter.shutdown(),
    };
    this.batch = new BatchSpanProcessor(monitored, {
      maxQueueSize: limit, maxExportBatchSize: Math.min(batchSize, limit),
      scheduledDelayMillis: 1000, exportTimeoutMillis: timeoutMs + 100,
    });
  }

  onStart(..._args: Parameters<SpanProcessor["onStart"]>): void {}
  onEnd(span: ReadableSpan): void {
    if (this.closed || !(span.spanContext().traceFlags & TraceFlags.SAMPLED)) return;
    if (this.queued >= this.limit) { this.capacityDropped++; return; }
    this.queued++;
    try { this.batch.onEnd(span); }
    catch { this.queued--; this.capacityDropped++; }
  }
  snapshot() {
    return { queued: this.queued, inFlight: this.inFlight, exported: this.exported,
      capacityDropped: this.capacityDropped, failedSpans: this.failedSpans, failedBatches: this.failedBatches };
  }
  async forceFlush(): Promise<void> {
    try { await this.batch.forceFlush(); }
    finally { await Promise.all([...this.pending]); }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    try { await this.batch.shutdown(); }
    finally { await Promise.all([...this.pending]); }
  }
}
