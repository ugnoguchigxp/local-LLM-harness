import { z } from "zod";

const finiteNonNegative = z.number().finite().nonnegative();
const positiveDuration = z.number().finite().positive();
const identity = z.string().min(1).max(200);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);

export const sloSeriesIdSchema = z.enum([
  "llm-normal",
  "llm-realtime",
  "stt",
  "tts-normal",
]);

const identityListSchema = z.array(identity).min(1).max(8)
  .refine((values) => new Set(values).size === values.length, "identity values must be unique");

export const sloSeriesSummarySchema = z.object({
  id: sloSeriesIdSchema,
  promptClass: identity,
  maxTokens: z.number().int().min(0).max(4096),
  concurrency: z.number().int().min(1).max(32),
  iterations: z.number().int().min(1).max(1000),
  successes: z.number().int().min(0).max(1000),
  errors: z.number().int().min(0).max(1000),
  errorRate: z.number().finite().min(0).max(1),
  fallbackCount: z.number().int().min(0).max(1000),
  provider429Count: z.number().int().min(0).max(1000),
  maxQueueDepth: z.number().int().min(0).max(1000),
  bootEpochs: identityListSchema,
  routes: identityListSchema,
  runtimes: identityListSchema,
  releases: identityListSchema,
  latencyMs: z.object({
    ttfbP95: positiveDuration,
    totalP95: positiveDuration,
    startupP95: finiteNonNegative,
  }).strict(),
  memoryHeadroomMinBytes: z.object({
    system: finiteNonNegative,
    accelerator: finiteNonNegative,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.successes + value.errors !== value.iterations) {
    context.addIssue({ code: "custom", message: "successes plus errors must equal iterations" });
  }
  if (Math.abs(value.errorRate - value.errors / value.iterations) > 1e-12) {
    context.addIssue({ code: "custom", message: "errorRate must equal errors divided by iterations" });
  }
});

export const sloBenchmarkSummarySchema = z.object({
  schemaVersion: z.literal(1),
  recordedAt: z.string().datetime({ offset: true }),
  commit: commitSchema,
  configRevision: identity,
  series: z.array(sloSeriesSummarySchema).min(1).max(4),
}).strict().superRefine((value, context) => {
  const ids = value.series.map((series) => series.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "benchmark series IDs must be unique" });
  }
});

const sloLimitsSchema = z.object({
  maxTtfbP95Ms: positiveDuration,
  maxTotalP95Ms: positiveDuration,
  maxStartupP95Ms: finiteNonNegative,
  minSystemMemoryHeadroomBytes: finiteNonNegative,
  minAcceleratorMemoryHeadroomBytes: finiteNonNegative,
  maxErrorRate: z.number().finite().min(0).max(1),
  maxQueueDepth: z.number().int().min(0).max(1000),
  maxProvider429Count: z.number().int().min(0).max(1000),
  allowFallback: z.boolean(),
}).strict();

const calibratedSeriesSchema = z.object({
  id: sloSeriesIdSchema,
  promptClass: identity,
  maxTokens: z.number().int().min(0).max(4096),
  concurrency: z.number().int().min(1).max(32),
  minimumIterations: z.number().int().min(3).max(1000),
  calibration: z.object({
    measuredAt: z.string().datetime({ offset: true }),
    measurementCommit: commitSchema,
    configRevision: identity,
    sampleCount: z.number().int().min(3).max(1000),
    routes: identityListSchema,
    runtimes: identityListSchema,
    releases: identityListSchema,
  }).strict(),
  limits: sloLimitsSchema,
  rollback: sloLimitsSchema,
}).strict().superRefine((value, context) => {
  if (value.calibration.sampleCount < value.minimumIterations) {
    context.addIssue({ code: "custom", message: "calibration sample count is below the minimum iteration gate" });
  }
});

const uncalibratedManifestSchema = z.object({
  schemaVersion: z.literal(1),
  node: z.literal("gnosis"),
  status: z.literal("uncalibrated"),
  series: z.tuple([]),
}).strict();

const calibratedManifestSchema = z.object({
  schemaVersion: z.literal(1),
  node: z.literal("gnosis"),
  status: z.literal("calibrated"),
  series: z.array(calibratedSeriesSchema).length(4),
}).strict().superRefine((value, context) => {
  const ids = value.series.map((series) => series.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "SLO series IDs must be unique" });
  }
  for (const required of sloSeriesIdSchema.options) {
    if (!ids.includes(required)) {
      context.addIssue({ code: "custom", message: `missing required SLO series ${required}` });
    }
  }
});

export const sloManifestSchema = z.discriminatedUnion("status", [
  uncalibratedManifestSchema,
  calibratedManifestSchema,
]);

export type SloBenchmarkSummary = z.infer<typeof sloBenchmarkSummarySchema>;
export type SloManifest = z.infer<typeof sloManifestSchema>;
export type SloFailure = {
  series?: z.infer<typeof sloSeriesIdSchema>;
  code: string;
  expected?: string | number | boolean;
  actual?: string | number | boolean;
};
export type SloComparison = { passed: boolean; failures: SloFailure[] };

function sameIdentities(left: string[], right: string[]): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

export function compareSlo(
  manifestInput: unknown,
  summaryInput: unknown,
  expected: { commit: string; configRevision?: string },
): SloComparison {
  const failures: SloFailure[] = [];
  const manifestResult = sloManifestSchema.safeParse(manifestInput);
  const summaryResult = sloBenchmarkSummarySchema.safeParse(summaryInput);
  if (!manifestResult.success) failures.push({ code: "invalid_manifest" });
  if (!summaryResult.success) failures.push({ code: "invalid_summary" });
  if (!manifestResult.success || !summaryResult.success) return { passed: false, failures };
  const manifest = manifestResult.data;
  const summary = summaryResult.data;
  if (manifest.status !== "calibrated") {
    return { passed: false, failures: [{ code: "manifest_uncalibrated" }] };
  }
  if (summary.commit !== expected.commit) {
    failures.push({ code: "commit_mismatch", expected: expected.commit, actual: summary.commit });
  }
  if (expected.configRevision && summary.configRevision !== expected.configRevision) {
    failures.push({
      code: "config_revision_mismatch",
      expected: expected.configRevision,
      actual: summary.configRevision,
    });
  }
  const expectedIds = manifest.series.map((series) => series.id).sort();
  const actualIds = summary.series.map((series) => series.id).sort();
  if (!sameIdentities(expectedIds, actualIds)) {
    failures.push({ code: "series_set_mismatch", expected: expectedIds.join(","), actual: actualIds.join(",") });
  }
  for (const threshold of manifest.series) {
    const sample = summary.series.find((series) => series.id === threshold.id);
    if (!sample) continue;
    const fail = (code: string, expectedValue?: string | number | boolean, actualValue?: string | number | boolean) => {
      failures.push({ series: threshold.id, code, expected: expectedValue, actual: actualValue });
    };
    if (summary.configRevision !== threshold.calibration.configRevision) {
      fail("calibration_config_revision_mismatch", threshold.calibration.configRevision, summary.configRevision);
    }
    if (sample.promptClass !== threshold.promptClass) fail("prompt_class_mismatch", threshold.promptClass, sample.promptClass);
    if (sample.maxTokens !== threshold.maxTokens) fail("max_tokens_mismatch", threshold.maxTokens, sample.maxTokens);
    if (sample.concurrency !== threshold.concurrency) fail("concurrency_mismatch", threshold.concurrency, sample.concurrency);
    if (sample.iterations < threshold.minimumIterations) fail("insufficient_samples", threshold.minimumIterations, sample.iterations);
    if (sample.bootEpochs.length !== 1) fail("boot_epoch_changed", 1, sample.bootEpochs.length);
    if (!sameIdentities(sample.routes, threshold.calibration.routes)) {
      fail("route_identity_mismatch", threshold.calibration.routes.join(","), sample.routes.join(","));
    }
    if (!sameIdentities(sample.runtimes, threshold.calibration.runtimes)) {
      fail("runtime_identity_mismatch", threshold.calibration.runtimes.join(","), sample.runtimes.join(","));
    }
    if (!sameIdentities(sample.releases, threshold.calibration.releases)) {
      fail("release_identity_mismatch", threshold.calibration.releases.join(","), sample.releases.join(","));
    }
    if (!threshold.limits.allowFallback && sample.fallbackCount !== 0) fail("fallback_forbidden", 0, sample.fallbackCount);
    if (sample.latencyMs.ttfbP95 > threshold.limits.maxTtfbP95Ms) fail("ttfb_p95_exceeded", threshold.limits.maxTtfbP95Ms, sample.latencyMs.ttfbP95);
    if (sample.latencyMs.totalP95 > threshold.limits.maxTotalP95Ms) fail("total_p95_exceeded", threshold.limits.maxTotalP95Ms, sample.latencyMs.totalP95);
    if (sample.latencyMs.startupP95 > threshold.limits.maxStartupP95Ms) fail("startup_p95_exceeded", threshold.limits.maxStartupP95Ms, sample.latencyMs.startupP95);
    if (sample.memoryHeadroomMinBytes.system < threshold.limits.minSystemMemoryHeadroomBytes) fail("system_memory_headroom_below_minimum", threshold.limits.minSystemMemoryHeadroomBytes, sample.memoryHeadroomMinBytes.system);
    if (sample.memoryHeadroomMinBytes.accelerator < threshold.limits.minAcceleratorMemoryHeadroomBytes) fail("accelerator_memory_headroom_below_minimum", threshold.limits.minAcceleratorMemoryHeadroomBytes, sample.memoryHeadroomMinBytes.accelerator);
    if (sample.errorRate > threshold.limits.maxErrorRate) fail("error_rate_exceeded", threshold.limits.maxErrorRate, sample.errorRate);
    if (sample.maxQueueDepth > threshold.limits.maxQueueDepth) fail("queue_depth_exceeded", threshold.limits.maxQueueDepth, sample.maxQueueDepth);
    if (sample.provider429Count > threshold.limits.maxProvider429Count) fail("provider_429_exceeded", threshold.limits.maxProvider429Count, sample.provider429Count);
  }
  return { passed: failures.length === 0, failures };
}
