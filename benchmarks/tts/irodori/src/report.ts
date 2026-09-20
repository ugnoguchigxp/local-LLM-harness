import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { percentile, readJsonlRecovering, writeJsonAtomic } from "./lib";

type Run = {
  profile: string;
  category: string;
  ok: boolean;
  rtf?: number | null;
  xRealtime?: number | null;
  latencyMs?: { firstAudioReady: number; firstResponseByte: number; generationComplete: number };
  error?: string;
};

const inputIndex = process.argv.indexOf("--input");
const input = inputIndex < 0 ? undefined : process.argv[inputIndex + 1];
if (!input || !isAbsolute(input)) throw new Error("--input must be an absolute result directory");
const { rows, recoveredFinalLine } = await readJsonlRecovering<Run>(join(input, "runs.jsonl"));
const measured = rows.filter((row) => row.ok && row.latencyMs);
const failed = rows.filter((row) => !row.ok);
const values = (read: (row: Run) => number | null | undefined) => measured.map(read).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
const stats = (numbers: number[]) => ({ p50: percentile(numbers, 0.5), p90: percentile(numbers, 0.9), p95: percentile(numbers, 0.95), max: numbers.length ? Math.max(...numbers) : null });
const rowStats = (selected: Run[]) => ({
  count: selected.length,
  ttfaMs: stats(selected.map((row) => row.latencyMs?.firstAudioReady).filter((value): value is number => typeof value === "number")),
  rtf: stats(selected.map((row) => row.rtf).filter((value): value is number => typeof value === "number")),
});
const ttfa = stats(values((row) => row.latencyMs?.firstAudioReady));
const ttfb = stats(values((row) => row.latencyMs?.firstResponseByte));
const total = stats(values((row) => row.latencyMs?.generationComplete));
const rtf = stats(values((row) => row.rtf));
const interactive = rowStats(measured.filter((row) => row.category === "short" || row.category === "medium"));
const tier = classify(interactive.ttfaMs.p95, interactive.rtf.p95);
const byCategory = Object.fromEntries([...new Set(measured.map((row) => row.category))].sort()
  .map((category) => [category, rowStats(measured.filter((row) => row.category === category))]));
const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  profile: rows[0]?.profile ?? "unknown",
  counts: { total: rows.length, successes: measured.length, failures: failed.length },
  recoveredFinalLine,
  latencyMs: { ttfb, ttfa, total },
  rtf,
  xRealtime: stats(values((row) => row.xRealtime)),
  interactive,
  byCategory,
  tier,
  failures: failed.map((row) => ({ category: row.category, error: row.error })),
};
await mkdir(input, { recursive: true });
await writeJsonAtomic(join(input, "summary.json"), summary);
const csv = [
  "profile,successes,failures,ttfa_p50_ms,ttfa_p95_ms,rtf_p50,rtf_p95,tier",
  [summary.profile, summary.counts.successes, summary.counts.failures, interactive.ttfaMs.p50, interactive.ttfaMs.p95, interactive.rtf.p50, interactive.rtf.p95, tier].join(","),
].join("\n") + "\n";
await writeFile(join(input, "summary.csv"), csv, { mode: 0o600 });
await writeFile(join(input, "summary.md"), `# ${summary.profile}\n\n- Tier (short + medium): ${tier}\n- Success: ${summary.counts.successes}/${summary.counts.total}\n- All TTFA p50/p95: ${format(ttfa.p50)} / ${format(ttfa.p95)} ms\n- All RTF p50/p95: ${format(rtf.p50)} / ${format(rtf.p95)}\n- Interactive TTFA p50/p95: ${format(interactive.ttfaMs.p50)} / ${format(interactive.ttfaMs.p95)} ms\n- Interactive RTF p50/p95: ${format(interactive.rtf.p50)} / ${format(interactive.rtf.p95)}\n`, { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));

function classify(ttfaP95: number | null, rtfP95: number | null) {
  if (ttfaP95 === null || rtfP95 === null) return "unrated";
  if (ttfaP95 <= 1_000 && rtfP95 <= 0.7) return "A";
  if (ttfaP95 <= 2_000 && rtfP95 <= 1.0) return "B";
  if (ttfaP95 <= 3_000 && rtfP95 <= 1.5) return "C";
  return "D";
}

function format(value: number | null) { return value === null ? "n/a" : value.toFixed(3); }
