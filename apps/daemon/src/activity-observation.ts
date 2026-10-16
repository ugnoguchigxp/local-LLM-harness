import { SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";

// Names are bounded by the instrumentation, never supplied by HTTP input.
export type ActivityName = "request_cleanup" | "control_task" | "runtime_startup" | "runtime_start" | "runtime_mutation";
export interface ObservationScope {
  readonly context: Context;
  readonly correlation: Readonly<Record<string, string>>;
  stage(name: string): () => void;
  measure(name: string, milliseconds: number): void;
  attribute(name: string, value: string | number): void;
  operation(name: ActivityName): ActivityObservation | undefined;
}
export interface ActivityOwner {
  span(name: string, parent: Context, time: number): Span;
  operation(name: ActivityName, parent?: ObservationScope): ActivityObservation | undefined;
  run<T>(scope: ObservationScope, work: () => T): T;
  completed(activity: ActivityObservation, durations: ReadonlyMap<string, number>, outcome: string): void;
}
const safe = (work: () => void) => { try { work(); } catch { /* observation only */ } };

export class ActivityObservation implements ObservationScope {
  readonly started = performance.now();
  private readonly epoch = Date.now();
  readonly context: Context;
  readonly correlation: Record<string, string>;
  private readonly root: Span;
  private ended = false;
  private readonly durations = new Map<string, number>();
  private readonly pending = new Set<() => void>();

  constructor(private readonly owner: ActivityOwner, readonly name: ActivityName, parent: Context, correlation: Readonly<Record<string, string>>) {
    this.correlation = { ...correlation };
    this.root = owner.span(name, parent, this.epoch);
    this.context = trace.setSpan(parent, this.root);
    safe(() => this.root.setAttributes(this.correlation));
  }
  private time(): number { return this.epoch + performance.now() - this.started; }
  run<T>(work: () => T): T { return this.owner.run(this, work); }
  operation(name: ActivityName): ActivityObservation | undefined { return this.owner.operation(name, this); }
  attribute(name: string, value: string | number): void {
    if (this.ended) return;
    safe(() => this.root.setAttribute(name, value));
    if (typeof value === "string" && ["larm.runtime", "larm.protocol", "larm.request_id", "larm.allocation_id", "larm.route", "larm.capability", "larm.runtime_release"].includes(name)) this.correlation[name] = value;
  }
  measure(name: string, milliseconds: number): void {
    if (!this.ended && Number.isFinite(milliseconds) && milliseconds >= 0) this.durations.set(name, (this.durations.get(name) ?? 0) + milliseconds);
  }
  stage(name: string): () => void {
    if (this.ended) return () => {};
    const started = performance.now();
    let span: Span | undefined;
    safe(() => { span = this.owner.span(name, this.context, this.time()); });
    let done = false;
    const end = () => {
      if (done) return;
      done = true; this.pending.delete(end);
      this.measure(name, performance.now() - started);
      safe(() => span?.end(this.time()));
    };
    this.pending.add(end);
    return end;
  }
  finish(outcome = "complete"): void {
    if (this.ended) return;
    for (const end of [...this.pending]) end();
    this.measure("total", performance.now() - this.started);
    this.ended = true;
    for (const [stage, ms] of this.durations) safe(() => this.root.setAttribute(`larm.duration_ms.${stage}`, ms));
    safe(() => {
      this.root.setAttribute("larm.outcome", outcome);
      if (outcome !== "complete") this.root.setStatus({ code: SpanStatusCode.ERROR });
      this.root.end(this.time());
    });
    safe(() => this.owner.completed(this, this.durations, outcome));
  }
}
