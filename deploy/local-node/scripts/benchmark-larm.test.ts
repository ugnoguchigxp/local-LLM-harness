import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sloBenchmarkSummarySchema } from "../../../packages/core/src/index";

const benchmark = resolve(import.meta.dir, "benchmark-larm.ts");
const commit = "a".repeat(40);
const configRevision = "b".repeat(64);

async function runBenchmark(truncated: boolean) {
  const root = await mkdtemp(join(tmpdir(), "larm-benchmark-integration-"));
  let allocationSequence = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const headers = { "x-larm-boot-epoch": "epoch-integration" };
      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          version: "0.1.0",
          releaseCommit: commit,
          configRevision,
          bootEpoch: "epoch-integration",
        }, { headers });
      }
      if (url.pathname === "/metrics") {
        return new Response([
          "larm_system_memory_available_bytes 1000000",
          "larm_accelerator_memory_available_bytes 2000000",
          'larm_execution_queued{runtime="qwen-general"} 0',
          'larm_gateway_request_total{status="429"} 0',
          "",
        ].join("\n"), { headers });
      }
      if (url.pathname === "/v1/allocations" && request.method === "POST") {
        const body = await request.json() as {
          requirements: Array<{ capability: string; route: string }>;
          allowFallback: boolean;
          deploymentPolicy: string;
        };
        allocationSequence += 1;
        return Response.json(allocation(`allocation-${allocationSequence}`, body, "ready"), { headers });
      }
      if (url.pathname.startsWith("/v1/allocations/") && request.method === "DELETE") {
        const id = url.pathname.split("/").at(-1)!;
        return Response.json(allocation(id, {
          requirements: [{ capability: "llm.general", route: "llm-default" }],
          allowFallback: false,
          deploymentPolicy: "existing-only",
        }, "released"), { headers });
      }
      if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
        const body = truncated
          ? '{"choices":[]}'
          : '{"choices":[{"message":{"content":"OK"}}]}';
        return new Response(body, { headers: { ...headers, "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404, headers });
    },
  });
  const raw = join(root, "raw.json");
  const summary = join(root, "summary.json");
  try {
    const child = Bun.spawn(["bun", "run", benchmark], {
      env: {
        ...Bun.env,
        LARM_BASE_URL: `http://127.0.0.1:${server.port}`,
        LARM_BENCHMARK_OUTPUT: raw,
        LARM_BENCHMARK_SUMMARY: summary,
        LARM_BENCHMARK_COMMIT: commit,
        LARM_BENCHMARK_ITERATIONS: "3",
        LARM_BENCHMARK_WARMUPS: "0",
        LARM_BENCHMARK_SERIES: "llm-normal",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]).then(([code, error]) => [code, error] as const);
    return { root, raw, summary, exitCode, stderr };
  } catch (cause) {
    await rm(root, { recursive: true, force: true });
    throw cause;
  } finally {
    server.stop(true);
  }
}

function allocation(
  id: string,
  request: {
    requirements: Array<{ capability: string; route: string }>;
    allowFallback: boolean;
    deploymentPolicy: string;
  },
  status: "ready" | "released",
) {
  const now = "2026-08-29T00:00:00.000Z";
  return {
    id,
    bootEpoch: "epoch-integration",
    catalogRevision: configRevision,
    status,
    requirements: request.requirements,
    bindings: request.requirements.map((requirement) => ({
      capability: requirement.capability,
      route: requirement.route,
      runtime: "qwen-general",
      node: "local-node",
      status: "HOT",
      candidateRank: 1,
      fallback: false,
      selectionReason: "primary_ready",
      release: "qwen-general-current",
    })),
    allowFallback: request.allowFallback,
    deploymentPolicy: request.deploymentPolicy,
    createdAt: now,
    expiresAt: "2026-08-29T00:02:00.000Z",
    ...(status === "released" ? { releasedAt: now } : {}),
  };
}

test("benchmark records a validated completed LLM series", async () => {
  const result = await runBenchmark(false);
  try {
    expect(result.exitCode).toBe(0);
    const summary = sloBenchmarkSummarySchema.parse(JSON.parse(await readFile(result.summary, "utf8")));
    expect(summary.series).toHaveLength(1);
    expect(summary.series[0]).toMatchObject({
      id: "llm-normal",
      iterations: 3,
      successes: 3,
      errors: 0,
      bootEpochs: ["epoch-integration"],
      runtimes: ["qwen-general"],
    });
    expect(JSON.parse(await readFile(result.raw, "utf8"))).toMatchObject({ status: "completed" });
    expect((await lstat(result.raw)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(result.root, { recursive: true, force: true });
  }
});

test("benchmark fails closed when every successful HTTP completion is invalid", async () => {
  const result = await runBenchmark(true);
  try {
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("produced no successful samples");
    expect(JSON.parse(await readFile(result.raw, "utf8"))).toMatchObject({
      status: "failed",
      error: "benchmark_request_failed",
      series: [{
        id: "llm-normal",
        samples: [],
        errors: [
          { iteration: 1, code: "llm_response_invalid" },
          { iteration: 2, code: "llm_response_invalid" },
          { iteration: 3, code: "llm_response_invalid" },
        ],
      }],
    });
  } finally {
    await rm(result.root, { recursive: true, force: true });
  }
});
