export type HistogramSnapshot = Map<string, {
  family: string; labels: Record<string, string>; count: number; sum: number; buckets: Map<number, number>;
}>;
export type HistogramDelta = {
  family: string; labels: Record<string, string>; count: number; sumMs: number; meanMs: number;
  p50UpperBoundMs: number | null; p95UpperBoundMs: number | null; maxUpperBoundMs: number | null;
};

/** Parse only bounded, known observability families; never read request/response content. */
export function observationHistograms(text: string): HistogramSnapshot {
  const result: HistogramSnapshot = new Map();
  for (const line of text.split("\n")) {
    const match = /^larm_(request_stage_seconds|operation_stage_seconds)_(count|sum|bucket)(?:\{(.*)\})? ([0-9.eE+-]+)$/.exec(line);
    if (!match) continue;
    const value = Number(match[4]);
    if (!Number.isFinite(value) || value < 0) continue;
    const labels: Record<string, string> = {};
    let valid = true;
    for (const entry of (match[3] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g)) {
      try { labels[entry[1]!] = JSON.parse(`"${entry[2]}"`); } catch { valid = false; }
    }
    if (!valid) continue;
    const bound = labels.le === "+Inf" ? Infinity : Number(labels.le);
    delete labels.le;
    const family = match[1]!;
    const key = JSON.stringify([family, Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))]);
    let histogram = result.get(key);
    if (!histogram) { histogram = { family, labels, count: 0, sum: 0, buckets: new Map() }; result.set(key, histogram); }
    if (match[2] === "count") histogram.count = value;
    else if (match[2] === "sum") histogram.sum = value;
    else if (!Number.isNaN(bound) && bound >= 0) histogram.buckets.set(bound, value);
  }
  return result;
}

export function observationDelta(before: HistogramSnapshot, after: HistogramSnapshot): { histograms: HistogramDelta[]; resetDetected: boolean } {
  let resetDetected = [...before.keys()].some(key => !after.has(key));
  const histograms: HistogramDelta[] = [];
  for (const [key, current] of after) {
    const previous = before.get(key);
    const count = current.count - (previous?.count ?? 0);
    const sum = current.sum - (previous?.sum ?? 0);
    if (count < 0 || sum < 0) { resetDetected = true; continue; }
    if (count === 0) continue;
    const buckets = [...current.buckets].sort(([a], [b]) => a - b).map(([bound, value]) => [bound, value - (previous?.buckets.get(bound) ?? 0)] as const);
    if (buckets.some(([, value]) => value < 0)) { resetDetected = true; continue; }
    const upper = (fraction: number) => {
      const bound = buckets.find(([, value]) => value >= Math.ceil(count * fraction))?.[0];
      return bound !== undefined && Number.isFinite(bound) ? bound * 1000 : null;
    };
    histograms.push({ family: current.family, labels: current.labels, count, sumMs: sum * 1000, meanMs: sum * 1000 / count,
      p50UpperBoundMs: upper(0.5), p95UpperBoundMs: upper(0.95), maxUpperBoundMs: upper(1) });
  }
  return { histograms, resetDetected };
}
