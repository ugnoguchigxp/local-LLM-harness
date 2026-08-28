import type { ControlEvent } from "./controller";

const HIGH_CARDINALITY_LABELS = new Set([
  "allocation",
  "client",
  "reasons",
  "request",
  "request_id",
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
  private readonly values = new Map<string, {
    name: string;
    labels: Record<string, string>;
    value: number;
  }>();

  record(event: ControlEvent): void {
    const labels = Object.fromEntries(
      Object.entries(event.labels ?? {}).filter(([label]) => !HIGH_CARDINALITY_LABELS.has(label)),
    );
    if (event.name.endsWith("_seconds")) {
      this.increment(metricName(`${event.name}_sum`), labels, event.value ?? 0);
      this.increment(metricName(`${event.name}_count`), labels, 1);
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
    const lines = [...this.values.values()]
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
