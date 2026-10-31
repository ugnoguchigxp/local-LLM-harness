import { ActivityObservation, type ActivityName, type ObservationScope } from "./activity-observation";
import { TraceDelivery } from "./trace-delivery";
import { inferenceStatistics } from "@larm/core";
import { AsyncLocalStorage } from "node:async_hooks";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, ParentBasedSampler, TraceIdRatioBasedSampler, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { MiddlewareHandler } from "hono";
import type { MetricsRegistry } from "./metrics";

const storage = new AsyncLocalStorage<ObservationScope>();
const requests = new WeakMap<Request, RequestObservation>();
const propagator = new W3CTraceContextPropagator();
const getter = { keys: (h: Headers) => [...h.keys()], get: (h: Headers, k: string) => h.get(k) ?? undefined };
const setter = { set: (h: Headers, k: string, v: string) => h.set(k, v) };
const noop = () => {};
// Telemetry is deliberately best effort, including injected metric/export sinks.
export function safely(work: () => void): void { try { work(); } catch { /* fail open */ } }
export function currentObservation(): ObservationScope | undefined { return storage.getStore(); }
export function requestObservation(request: Request): RequestObservation | undefined { return requests.get(request); }

export class Observability {
  readonly provider: BasicTracerProvider;
  readonly delivery?: TraceDelivery;
  private readonly activities = new Set<ActivityObservation>();
  private operationDrops = 0;
  private operationExpiries = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(readonly metrics?: MetricsRegistry, private readonly options: { sampleRatio?: number; exporter?: SpanExporter; maxOperations?: number; maxOperationAgeMs?: number; exportQueueSize?: number; exportBatchSize?: number; exportTimeoutMs?: number } = {}) {
    this.delivery = options.exporter ? new TraceDelivery(options.exporter, options.exportQueueSize, options.exportBatchSize, options.exportTimeoutMs) : undefined;
    this.provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "larm" }),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.sampleRatio ?? 0.01) }),
      spanProcessors: this.delivery ? [this.delivery] : [],
      spanLimits: { attributeCountLimit: 64, eventCountLimit: 8 },
    });
    this.timer = setInterval(() => this.collect(), 1000);
    this.timer.unref();
    this.collect();
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      // Scrapes and health checks must not create traces or recursive metrics.
      if (!/^\/v[1-9][0-9]*\//.test(c.req.path) || c.req.path.startsWith("/v1/monitoring/")) return await next();
      let observation: RequestObservation | undefined;
      safely(() => { observation = new RequestObservation(this, c.req.raw); });
      if (!observation) return await next();
      const active = observation;
      requests.set(c.req.raw, active);
      await storage.run(active, async () => {
        try { await next(); }
        catch (error) { active.finish("handler_error"); throw error; }
        finally {
          safely(() => {
            if (!c.res.headers.has("x-request-id")) {
              const id = active.correlation["larm.request_id"] ?? `req_${crypto.randomUUID()}`;
              c.res.headers.set("x-request-id", id);
              active.attribute("larm.request_id", id);
            }
            active.attribute("http.response.status_code", c.res.status);
          });
          active.responseHeaders(c.res.headers);
          if (!active.deferred) active.finish(c.res.status >= 400 ? "rejected" : "complete");
        }
      });
    };
  }

  span(name: string, parent: Context, time: number): Span {
    return this.provider.getTracer("larm.gateway").startSpan(`larm.${name}`, { startTime: time }, parent);
  }
  run<T>(scope: ObservationScope, work: () => T): T { return storage.run(scope, work); }
  operation(name: ActivityName, parent = currentObservation()): ActivityObservation | undefined {
    if (this.closed) return undefined;
    if (this.activities.size >= (this.options.maxOperations ?? 1024)) { this.operationDrops++; return undefined; }
    let activity: ActivityObservation | undefined;
    safely(() => { activity = new ActivityObservation(this, name, parent?.context ?? ROOT_CONTEXT, parent?.correlation ?? {}); });
    if (activity) this.activities.add(activity);
    return activity;
  }
  completed(activity: ActivityObservation, durations: ReadonlyMap<string, number>, outcome: string): void {
    this.activities.delete(activity);
    const labels = { operation: activity.name, ...(activity.correlation["larm.runtime"] ? { runtime: activity.correlation["larm.runtime"]! } : {}), outcome };
    for (const [stage, ms] of durations) safely(() => this.metrics?.record({ name: "operation_stage_seconds", labels: { ...labels, stage }, value: ms / 1000 }));
  }
  gauge(name: string, labels: Record<string, string>, value: number): void { safely(() => this.metrics?.setGauge(name, labels, value)); }
  collect(): void {
    let oldest = 0;
    for (const activity of this.activities) {
      const age = performance.now() - activity.started;
      if (age > (this.options.maxOperationAgeMs ?? 900000)) { this.operationExpiries++; activity.finish("observation_expired"); }
      else oldest = Math.max(oldest, age);
    }
    this.gauge("telemetry_trace_export_enabled", {}, this.delivery ? 1 : 0);
    this.gauge("telemetry_operations_active", {}, this.activities.size);
    this.gauge("telemetry_operation_oldest_seconds", {}, oldest / 1000);
    this.gauge("telemetry_operations_dropped_total", {}, this.operationDrops);
    this.gauge("telemetry_operations_expired_total", {}, this.operationExpiries);
    if (this.delivery) {
      const names = { queued: "queued", inFlight: "in_flight", exported: "exported_spans_total", capacityDropped: "capacity_dropped_spans_total", failedSpans: "failed_spans_total", failedBatches: "failed_batches_total" };
      for (const [key, value] of Object.entries(this.delivery.snapshot())) this.gauge(`telemetry_trace_${names[key as keyof typeof names]}`, {}, value);
    }
  }
  async shutdown(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    for (const activity of this.activities) activity.finish("observer_shutdown");
    await this.provider.shutdown().catch(() => undefined);
    this.collect();
  }
}

export class RequestObservation {
  readonly started = performance.now();
  private readonly epoch = Date.now();
  private readonly root: Span;
  readonly context: Context;
  readonly correlation: Record<string, string> = {};
  private readonly durations = new Map<string, number>();
  private readonly pending = new Set<() => void>();
  private readonly numeric = new Map<string, number>();
  private readonly labels: Record<string, string> = {};
  private ended = false;
  deferred = false;
  private upstream?: Span;
  private firstBody = false;
  private relayTotal = 0;
  private relayMax = 0;
  private relayCount = 0;

  constructor(private readonly owner: Observability, request: Request) {
    const parent = propagator.extract(ROOT_CONTEXT, request.headers, getter);
    this.root = owner.provider.getTracer("larm.gateway").startSpan("larm.request", {
      kind: SpanKind.SERVER, startTime: this.epoch,
      attributes: { "http.request.method": request.method },
    }, parent);
    this.context = trace.setSpan(parent, this.root);
    this.attribute("larm.request_id", `req_${crypto.randomUUID()}`);
    const callerId = request.headers.get("x-request-id");
    if (callerId && /^[a-zA-Z0-9._-]{1,128}$/.test(callerId)) this.attribute("larm.caller_request_id", callerId);
  }

  bind(runtime: string, protocol: string, requestId: string): void {
    this.deferred = true;
    this.labels.runtime = runtime;
    this.labels.protocol = protocol;
    this.attribute("larm.runtime", runtime); this.attribute("larm.protocol", protocol); this.attribute("larm.request_id", requestId);
  }

  operation(name: ActivityName): ActivityObservation | undefined { return this.owner.operation(name, this); }

  attribute(name: string, value: string | number): void {
    if (typeof value === "string" && ["larm.runtime", "larm.protocol", "larm.request_id", "larm.allocation_id", "larm.route", "larm.capability", "larm.runtime_release"].includes(name)) this.correlation[name] = value;
    safely(() => this.root.setAttribute(name, value));
    if (["larm.audio_seconds", "larm.audio_input_seconds", "larm.upstream_rtf", "larm.input_characters"].includes(name) && typeof value === "number" && Number.isFinite(value)) this.numeric.set(name, value);
  }
  private time(): number { return this.epoch + performance.now() - this.started; }

  stage(name: string): () => void {
    if (this.ended) return noop;
    const started = performance.now();
    let span: Span | undefined;
    safely(() => { span = this.owner.provider.getTracer("larm.gateway").startSpan(`larm.${name}`, { startTime: this.time() }, this.context); });
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      this.pending.delete(end);
      this.measure(name, performance.now() - started);
      safely(() => span?.end(this.time()));
    };
    this.pending.add(end);
    return end;
  }

  measure(name: string, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || this.ended) return;
    this.durations.set(name, (this.durations.get(name) ?? 0) + milliseconds);
  }

  startUpstream(headers: Headers): void {
    safely(() => {
      this.upstream = this.owner.provider.getTracer("larm.gateway").startSpan("larm.upstream", {
        kind: SpanKind.CLIENT, startTime: this.time(),
      }, this.context);
      propagator.inject(trace.setSpan(this.context, this.upstream), headers, setter);
    });
  }

  endUpstream(): void { safely(() => this.upstream?.end(this.time())); this.upstream = undefined; }

  responseHeaders(headers: Headers): void {
    safely(() => {
      propagator.inject(this.context, headers, setter);
      headers.set("x-larm-trace-id", this.root.spanContext().traceId);
      headers.set("server-timing", [...this.durations].map(([name, ms]) => `${name};dur=${ms.toFixed(3)}`).join(", "));
    });
  }

  bodyReceived(): number {
    const received = performance.now();
    if (!this.firstBody) { this.firstBody = true; this.measure("first_body", received - this.started); }
    return received;
  }
  relayed(received: number): void {
    const elapsed = performance.now() - received;
    this.relayTotal += elapsed;
    this.relayMax = Math.max(this.relayMax, elapsed);
    this.relayCount++;
  }

  engine(value: unknown): void {
    for (const [key, number] of Object.entries(inferenceStatistics(value))) {
      if (typeof number === "number" && Number.isFinite(number) && number >= 0) {
        this.attribute(`larm.engine.${key}`, number);
        safely(() => this.owner.metrics?.setGauge(`engine_reported_${key}`, this.labels, number));
      }
    }
  }

  finish(outcome: string): void {
    if (this.ended) return;
    for (const end of [...this.pending]) end();
    this.measure("total", performance.now() - this.started);
    if (this.relayCount) {
      this.measure("relay_sum", this.relayTotal);
      this.measure("relay_max", this.relayMax);
      this.attribute("larm.relay_chunks", this.relayCount);
    }
    this.ended = true;
    for (const [name, value] of this.numeric) safely(() => this.owner.metrics?.setGauge(`request_${name.slice(5)}`, this.labels, value));
    for (const [stage, ms] of this.durations) {
      safely(() => this.owner.metrics?.record({ name: "request_stage_seconds", labels: { ...this.labels, stage, outcome }, value: ms / 1000 }));
      safely(() => this.root.setAttribute(`larm.duration_ms.${stage}`, ms));
    }
    safely(() => this.owner.metrics?.record({ name: "observed_request", labels: { ...this.labels, outcome } }));
    safely(() => {
      this.root.setAttribute("larm.outcome", outcome);
      if (outcome.includes("error") || outcome.includes("timeout") || outcome.startsWith("http_5")) this.root.setStatus({ code: SpanStatusCode.ERROR });
      this.endUpstream();
      this.root.end(this.time());
    });
  }
}

export function observabilityFromEnvironment(metrics: MetricsRegistry, env = process.env): Observability | undefined {
  if (env.LARM_OBSERVABILITY_ENABLED !== "true") return undefined;
  const ratio = Number(env.LARM_TRACE_SAMPLE_RATIO ?? "0.01");
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error("LARM_TRACE_SAMPLE_RATIO must be between 0 and 1");
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  return new Observability(metrics, { sampleRatio: ratio, exporter: endpoint ? new OTLPTraceExporter({ url: endpoint, timeoutMillis: 2000 }) : undefined });
}
