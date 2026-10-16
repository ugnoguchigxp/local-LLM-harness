import type { ControlEvent } from "./controller";

const HIGH_CARDINALITY_LABELS = new Set([
  "allocation",
  "client",
  "reasons",
  "request",
  "request_id",
  "trace_id",
  "span_id",
  "releases",
  "routes",
  "runtimes",
]);

function metricName(name: string): string {
  return `larm_${name.replace(/[^a-zA-Z0-9_:]/g, "_")}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function keyOf(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([name, entries]);
}

export class MetricsRegistry {
  private static readonly DURATION_BUCKETS = [0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
  private readonly values = new Map<string, {
    name: string;
    labels: Record<string, string>;
    value: number;
  }>();

  private readonly histograms = new Map<string, {
    name: string; labels: Record<string, string>; sum: number; count: number; bins: number[];
  }>();

  /** Compile a bounded-label histogram once for a high-frequency measurement. */
  durationRecorder(name: string): (seconds: number) => void {
    if (!name.endsWith("_seconds")) throw new Error("duration histogram name must end in _seconds");
    const normalized = metricName(name);
    const key = keyOf(normalized, {});
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = { name: normalized, labels: {}, sum: 0, count: 0, bins: Array(MetricsRegistry.DURATION_BUCKETS.length + 1).fill(0) };
      this.histograms.set(key, histogram);
    }
    return seconds => {
      if (!Number.isFinite(seconds)) return;
      const value = Math.max(0, seconds);
      histogram.sum += value;
      histogram.count++;
      let index = MetricsRegistry.DURATION_BUCKETS.findIndex(bound => value <= bound);
      if (index < 0) index = MetricsRegistry.DURATION_BUCKETS.length;
      histogram.bins[index]++;
    };
  }

  record(event: ControlEvent): void {
    const labels = Object.fromEntries(
      Object.entries(event.labels ?? {}).filter(([label]) => !HIGH_CARDINALITY_LABELS.has(label)),
    );
    if (event.name.endsWith("_seconds")) {
      if (!Number.isFinite(event.value ?? 0)) return;
      const value = Math.max(0, event.value ?? 0);
      const name = metricName(event.name);
      const key = keyOf(name, labels);
      let histogram = this.histograms.get(key);
      if (!histogram) {
        histogram = { name, labels, sum: 0, count: 0, bins: Array(MetricsRegistry.DURATION_BUCKETS.length + 1).fill(0) };
        this.histograms.set(key, histogram);
      }
      histogram.sum += value;
      histogram.count++;
      // Store one exclusive bin per sample; expand cumulative buckets only on scrape.
      let index = MetricsRegistry.DURATION_BUCKETS.findIndex(bound => value <= bound);
      if (index < 0) index = MetricsRegistry.DURATION_BUCKETS.length;
      histogram.bins[index]++;
      return;
    }
    this.increment(metricName(`${event.name}_total`), labels, event.value ?? 1);
  }

  setGauge(name: string, labels: Record<string, string>, value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const safeLabels = Object.fromEntries(
      Object.entries(labels).filter(([label]) => !HIGH_CARDINALITY_LABELS.has(label)),
    );
    const normalized = metricName(name);
    this.values.set(keyOf(normalized, safeLabels), {
      name: normalized,
      labels: safeLabels,
      value,
    });
  }

  private increment(name: string, labels: Record<string, string>, value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const key = keyOf(name, labels);
    const current = this.values.get(key);
    if (current) {
      current.value += value;
      return;
    }
    this.values.set(key, { name, labels, value });
  }

  render(): string {
    const expanded = [...this.values.values()];
    for (const histogram of this.histograms.values()) {
      expanded.push({ name: `${histogram.name}_sum`, labels: histogram.labels, value: histogram.sum });
      expanded.push({ name: `${histogram.name}_count`, labels: histogram.labels, value: histogram.count });
      let count = 0;
      for (let i = 0; i < histogram.bins.length; i++) {
        count += histogram.bins[i]!;
        // Match the existing exposition: do not emit untouched zero buckets.
        if (count > 0) expanded.push({ name: `${histogram.name}_bucket`, labels: { ...histogram.labels, le: String(MetricsRegistry.DURATION_BUCKETS[i] ?? "+Inf") }, value: count });
      }
    }
    const lines = expanded
      .sort((a, b) => keyOf(a.name, a.labels).localeCompare(keyOf(b.name, b.labels)))
      .map((metric) => {
        const labels = Object.entries(metric.labels)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
          .join(",");
        return `${metric.name}${labels ? `{${labels}}` : ""} ${metric.value}`;
      });
    return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
  }
}

export class RequestTracker {
  private active = 0;
  private waiters = new Set<() => void>();

  begin(): () => void {
    this.active += 1;
    let finished = false;
    return () => {
      if (finished) {
        return;
      }
      finished = true;
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.waiters) {
          resolve();
        }
        this.waiters.clear();
      }
    };
  }

  count(): number {
    return this.active;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (this.active === 0) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const complete = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      const timeout = setTimeout(() => {
        this.waiters.delete(complete);
        resolve(false);
      }, Math.max(0, timeoutMs));
      timeout.unref?.();
      this.waiters.add(complete);
    });
  }
}
