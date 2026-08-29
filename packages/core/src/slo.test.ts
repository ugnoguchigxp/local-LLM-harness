import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "bun:test";
import { compareSlo, sloBenchmarkSummarySchema, sloManifestSchema } from "./slo";

const commit = "a".repeat(40);
const ids = ["llm-normal", "llm-realtime", "stt", "tts-normal"] as const;

function manifest() {
  return {
    schemaVersion: 1,
    node: "gnosis",
    status: "calibrated",
    series: ids.map((id) => ({
      id,
      promptClass: `${id}-fixed-control`,
      maxTokens: id.startsWith("llm") ? 32 : 0,
      concurrency: 1,
      minimumIterations: 3,
      calibration: {
        measuredAt: "2026-08-29T00:00:00Z",
        measurementCommit: commit,
        configRevision: "config-r1",
        sampleCount: 5,
        routes: [id === "stt" ? "stt-default" : id === "tts-normal" ? "tts-default" : "llm-default"],
        runtimes: [id === "stt" ? "qwen-asr" : id === "tts-normal" ? "voicevox-tts" : "qwen-general"],
        releases: [id === "stt" ? "qwen-asr-current" : id === "tts-normal" ? "unmanaged" : "qwen-general-current"],
      },
      limits: {
        maxTtfbP95Ms: 100,
        maxTotalP95Ms: 200,
        maxStartupP95Ms: 20,
        minSystemMemoryHeadroomBytes: 1_000,
        minAcceleratorMemoryHeadroomBytes: 2_000,
        maxErrorRate: 0,
        maxQueueDepth: 0,
        maxProvider429Count: 0,
        allowFallback: false,
      },
      rollback: {
        maxTtfbP95Ms: 120,
        maxTotalP95Ms: 240,
        maxStartupP95Ms: 30,
        minSystemMemoryHeadroomBytes: 900,
        minAcceleratorMemoryHeadroomBytes: 1_800,
        maxErrorRate: 0,
        maxQueueDepth: 0,
        maxProvider429Count: 0,
        allowFallback: false,
      },
    })),
  };
}

function summary() {
  return {
    schemaVersion: 1,
    recordedAt: "2026-08-29T00:01:00Z",
    commit,
    configRevision: "config-r1",
    series: ids.map((id) => ({
      id,
      promptClass: `${id}-fixed-control`,
      maxTokens: id.startsWith("llm") ? 32 : 0,
      concurrency: 1,
      iterations: 3,
      successes: 3,
      errors: 0,
      errorRate: 0,
      fallbackCount: 0,
      provider429Count: 0,
      maxQueueDepth: 0,
      bootEpochs: ["epoch-1"],
      routes: [id === "stt" ? "stt-default" : id === "tts-normal" ? "tts-default" : "llm-default"],
      runtimes: [id === "stt" ? "qwen-asr" : id === "tts-normal" ? "voicevox-tts" : "qwen-general"],
      releases: [id === "stt" ? "qwen-asr-current" : id === "tts-normal" ? "unmanaged" : "qwen-general-current"],
      latencyMs: { ttfbP95: 80, totalP95: 180, startupP95: 10 },
      memoryHeadroomMinBytes: { system: 1_100, accelerator: 2_100 },
    })),
  };
}

describe("SLO schemas", () => {
  test("versioned gnosis manifest starts fail-closed until production calibration", async () => {
    const path = resolve(import.meta.dir, "../../../deploy/gnosis/slo.yaml");
    expect(sloManifestSchema.parse(parse(await readFile(path, "utf8")))).toEqual({
      schemaVersion: 1,
      node: "gnosis",
      status: "uncalibrated",
      series: [],
    });
  });

  test("accept strict calibrated documents", () => {
    expect(sloManifestSchema.parse(manifest()).status).toBe("calibrated");
    expect(sloBenchmarkSummarySchema.parse(summary()).series).toHaveLength(4);
  });

  test("reject unit drift, partial summaries, NaN, and inconsistent counts", () => {
    expect(sloBenchmarkSummarySchema.safeParse({ ...summary(), durationSeconds: 1 }).success).toBeFalse();
    expect(sloBenchmarkSummarySchema.safeParse({ ...summary(), series: summary().series.slice(0, 1) }).success).toBeTrue();
    const nonFinite = summary();
    nonFinite.series[0]!.latencyMs.totalP95 = Number.NaN;
    expect(sloBenchmarkSummarySchema.safeParse(nonFinite).success).toBeFalse();
    const inconsistent = summary();
    inconsistent.series[0]!.errors = 1;
    expect(sloBenchmarkSummarySchema.safeParse(inconsistent).success).toBeFalse();
  });
});

describe("compareSlo", () => {
  test("accepts exact boundary values", () => {
    const input = summary();
    for (const series of input.series) {
      series.latencyMs = { ttfbP95: 100, totalP95: 200, startupP95: 20 };
      series.memoryHeadroomMinBytes = { system: 1_000, accelerator: 2_000 };
    }
    expect(compareSlo(manifest(), input, { commit, configRevision: "config-r1" })).toEqual({
      passed: true,
      failures: [],
    });
  });

  test.each([
    ["commit mismatch", (value: ReturnType<typeof summary>) => { value.commit = "b".repeat(40); }, "commit_mismatch"],
    ["old config", (value: ReturnType<typeof summary>) => { value.configRevision = "config-old"; }, "config_revision_mismatch"],
    ["partial summary", (value: ReturnType<typeof summary>) => { value.series.pop(); }, "series_set_mismatch"],
    ["sample shortage", (value: ReturnType<typeof summary>) => { const series = value.series[0]!; series.iterations = 2; series.successes = 2; }, "insufficient_samples"],
    ["epoch change", (value: ReturnType<typeof summary>) => { value.series[0]!.bootEpochs.push("epoch-2"); }, "boot_epoch_changed"],
    ["route identity", (value: ReturnType<typeof summary>) => { value.series[0]!.routes = ["llm-speed"]; }, "route_identity_mismatch"],
    ["fallback", (value: ReturnType<typeof summary>) => { value.series[0]!.fallbackCount = 1; }, "fallback_forbidden"],
    ["latency", (value: ReturnType<typeof summary>) => { value.series[0]!.latencyMs.totalP95 = 201; }, "total_p95_exceeded"],
    ["memory", (value: ReturnType<typeof summary>) => { value.series[0]!.memoryHeadroomMinBytes.accelerator = 1_999; }, "accelerator_memory_headroom_below_minimum"],
    ["queue", (value: ReturnType<typeof summary>) => { value.series[0]!.maxQueueDepth = 1; }, "queue_depth_exceeded"],
    ["provider 429", (value: ReturnType<typeof summary>) => { value.series[0]!.provider429Count = 1; }, "provider_429_exceeded"],
  ])("rejects %s", (_name, mutate, code) => {
    const input = summary();
    mutate(input);
    expect(compareSlo(manifest(), input, { commit, configRevision: "config-r1" }).failures)
      .toContainEqual(expect.objectContaining({ code }));
  });

  test("rejects uncalibrated manifests", () => {
    const result = compareSlo(
      { schemaVersion: 1, node: "gnosis", status: "uncalibrated", series: [] },
      summary(),
      { commit },
    );
    expect(result).toEqual({ passed: false, failures: [{ code: "manifest_uncalibrated" }] });
  });
});
