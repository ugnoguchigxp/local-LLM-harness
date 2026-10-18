import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { monitoringEventSchema, MONITORING_RETENTION_MS, MONITORING_VERSION, type MonitoringCoverage, type MonitoringEvent, type MonitoringEvents } from "./monitoring";

export class MonitoringCursorError extends Error {
  constructor(readonly status: 400 | 409 | 410, readonly code: "invalid_request" | "monitoring_epoch_changed" | "monitoring_cursor_expired", readonly reason: string) { super(code); }
}
type Entry = { event: MonitoringEvent; mono: number; bytes: number; seq: number };
type Cursor = { v: 1; stream: string; next: number; high: number | null; from: string; through: string };

/** Process-local, non-consuming journal. Pruning is producer-owned; readers never mutate it. */
export class MonitoringEventStore {
  private readonly key = randomBytes(32);
  private readonly entries: Entry[] = [];
  private head = 0;
  private bytes = 0;
  private sequence = 0;
  private dropped = 0n;
  private capacityFloor = 0;
  private capacitySince?: string;
  private readonly started: number;
  private readonly startedAt: string;
  constructor(readonly streamId: string, private readonly options: { now?: () => number; monotonic?: () => number; maxEvents?: number; maxBytes?: number } = {}) {
    this.started = this.mono(); this.startedAt = this.iso();
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private mono(): number { return this.options.monotonic?.() ?? performance.now(); }
  private iso(): string { return new Date(this.now()).toISOString(); }
  append(input: Omit<MonitoringEvent, "id" | "sequence" | "streamId" | "recordedAt">): MonitoringEvent {
    const seq = this.sequence + 1;
    const event = monitoringEventSchema.parse({ ...input, id: `${this.streamId}:${seq}`, sequence: String(seq), streamId: this.streamId, recordedAt: this.iso() });
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > 1024) throw new Error("monitoring_event_too_large");
    this.sequence = seq;
    this.entries.push({ event, mono: this.mono(), bytes, seq }); this.bytes += bytes;
    this.prune();
    return structuredClone(event);
  }
  prune(): void {
    const cutoff = this.mono() - MONITORING_RETENTION_MS;
    while (this.entries[this.head] && this.entries[this.head]!.mono <= cutoff) this.remove(false);
    while (this.entries.length - this.head > (this.options.maxEvents ?? 100_000) || this.bytes > (this.options.maxBytes ?? 67_108_864)) this.remove(true);
    if (this.head > 4096 && this.head * 2 > this.entries.length) { this.entries.splice(0, this.head); this.head = 0; }
  }
  private remove(capacity: boolean): void {
    const entry = this.entries[this.head++];
    if (!entry) return;
    this.bytes -= entry.bytes;
    if (capacity) { this.dropped++; this.capacityFloor = entry.seq; this.capacitySince = entry.event.recordedAt; }
  }
  noteLoss(): void { this.dropped++; this.capacityFloor = ++this.sequence; this.capacitySince = this.iso(); }
  metadata(): MonitoringEvents["eventStream"] {
    const elapsed = Math.max(0, this.mono() - this.started);
    const since = new Date(this.now() - Math.min(elapsed, MONITORING_RETENTION_MS)).toISOString();
    return { streamId: this.streamId, retentionTargetMs: MONITORING_RETENTION_MS, availableSince: this.capacitySince && this.capacitySince > since ? this.capacitySince : since,
      previousBootHistory: false, continuity: this.dropped > 0n ? "gap" : "complete_since_start", droppedEventsTotal: String(this.dropped), capacityEvents: 100_000, capacityBytes: 67_108_864 };
  }
  private sign(body: string): string { return createHmac("sha256", this.key).update(body).digest("base64url"); }
  private encode(cursor: Cursor): string { const body = Buffer.from(JSON.stringify(cursor)).toString("base64url"); return `${body}.${this.sign(body)}`; }
  private decode(token: string): Cursor {
    if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new MonitoringCursorError(400, "invalid_request", "invalid_cursor");
    const [body, signature] = token.split(".") as [string, string];
    let c: Cursor;
    try { c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new MonitoringCursorError(400, "invalid_request", "invalid_cursor"); }
    if (!c || c.v !== 1 || typeof c.stream !== "string" || c.stream.length > 192 || !Number.isSafeInteger(c.next) || c.next < 1
      || (c.high !== null && (!Number.isSafeInteger(c.high) || c.high < 0)) || typeof c.from !== "string" || !Number.isFinite(Date.parse(c.from))
      || typeof c.through !== "string" || !Number.isFinite(Date.parse(c.through)) || Object.keys(c).sort().join() !== "from,high,next,stream,through,v") throw new MonitoringCursorError(400, "invalid_request", "invalid_cursor");
    // A previous boot's signing key is deliberately gone, but its reset is still explicit.
    if (c.stream !== this.streamId) throw new MonitoringCursorError(409, "monitoring_epoch_changed", "daemon_restart");
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(this.sign(body)))) throw new MonitoringCursorError(400, "invalid_request", "invalid_cursor");
    if (c.next > this.sequence + 1 || (c.high !== null && (c.high > this.sequence || c.next > c.high + 1))) throw new MonitoringCursorError(400, "invalid_request", "invalid_cursor");
    return c;
  }
  read(token: string | undefined = undefined, limit = 500, coverage: MonitoringCoverage[] = []): MonitoringEvents {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new MonitoringCursorError(400, "invalid_request", "invalid_limit");
    const cutoff = this.mono() - MONITORING_RETENTION_MS;
    const retained = this.entries.slice(this.head).filter(e => e.mono > cutoff);
    const floor = retained[0]?.seq ?? this.sequence + 1;
    let c = token ? this.decode(token) : undefined;
    if (c && c.next < floor) throw new MonitoringCursorError(410, "monitoring_cursor_expired", c.next <= this.capacityFloor ? "capacity_evicted" : "retention_expired");
    if (c && c.next <= this.capacityFloor && (c.high ?? this.sequence) >= this.capacityFloor) throw new MonitoringCursorError(410, "monitoring_cursor_expired", "capacity_evicted");
    if (!c || c.high === null) c = { v: 1, stream: this.streamId, next: c?.next ?? floor, high: this.sequence, from: c?.through ?? this.metadata().availableSince, through: this.iso() };
    const page = retained.filter(e => e.seq >= c.next && e.seq <= c.high!).slice(0, limit);
    const next = page.length ? page[page.length - 1]!.seq + 1 : c.high! + 1;
    const more = next <= c.high!;
    return { contractVersion: MONITORING_VERSION, generatedAt: this.iso(), bootEpoch: this.streamId, eventStream: this.metadata(),
      window: { from: c.from, through: c.through, highWaterSequence: String(c.high) }, events: structuredClone(page.map(e => e.event)),
      nextCursor: this.encode({ ...c, next, high: more ? c.high : null }), hasMore: more, coverage: structuredClone(coverage) };
  }
}
