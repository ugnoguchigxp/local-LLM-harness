import { expect, test } from "bun:test";
import {
  isTcpConnectError,
  runQwenAgentWorkerStability,
} from "./verify-qwen-agent-worker-stability";

test("stability verifier records deterministic latency and connect failures without credentials", async () => {
  let call = 0;
  const times = [0, 10, 10, 30, 60];
  const result = await runQwenAgentWorkerStability({
    baseUrl: "http://larm.test:9810/",
    token: "test-only-token",
    requests: 3,
    now: (() => {
      const values = [Date.parse("2026-09-20T00:00:00Z"), Date.parse("2026-09-20T00:01:00Z")];
      return () => values.shift()!;
    })(),
    monotonicNow: () => times.shift()!,
    fetchImpl: (async (input, init) => {
      const url = String(input);
      expect(init?.headers).not.toEqual(expect.objectContaining({ token: expect.anything() }));
      if (url.endsWith("/health")) {
        return Response.json({
          status: "ok",
          ready: true,
          bootEpoch: "epoch-test",
          configRevision: "revision-test",
        });
      }
      if (url.endsWith("/v1/models")) {
        return Response.json({ data: [{ id: "qwen-agent-worker" }] });
      }
      call += 1;
      if (call === 2) {
        const cause = Object.assign(new Error("No route to host"), { code: "EHOSTUNREACH" });
        throw new Error("fetch failed", { cause });
      }
      return Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
    }) as typeof fetch,
  });
  expect(result).toEqual({
    schemaVersion: 1,
    kind: "qwen-agent-worker-stability",
    baseUrl: "http://larm.test:9810",
    model: "qwen-agent-worker",
    startedAt: "2026-09-20T00:00:00.000Z",
    completedAt: "2026-09-20T00:01:00.000Z",
    bootEpoch: "epoch-test",
    configRevision: "revision-test",
    requested: 3,
    succeeded: 2,
    failed: 1,
    tcpConnectErrors: 1,
    latencyMs: { min: 10, p50: 10, p95: 30, p99: 30, max: 30 },
  });
});

test("connect classifier recognizes macOS code 65 error chains", () => {
  expect(isTcpConnectError(new Error("tcp connect error", {
    cause: { code: "HostUnreachable", message: "No route to host" },
  }))).toBeTrue();
  expect(isTcpConnectError(new Error("HTTP 503"))).toBeFalse();
});
