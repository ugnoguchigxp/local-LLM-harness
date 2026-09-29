import { expect, test } from "bun:test";
import type { ContextSourceProvider } from "@larm/backends";
import { ContextControllerError } from "./context-controller-errors";
import { measureCanonicalRequest } from "./context-request-measurement";

const runtime = {
  id: "managed-runtime",
  deployment: { endpoint: "http://127.0.0.1:8000" },
  context: {
    class: "managed-context",
    outputReserveTokens: 100,
    safetyMarginTokens: 50,
  },
};
const release = {
  id: "release-1",
  contextCertification: {
    contextLimitTokens: 2_000,
    tokenizerDigest: "a".repeat(64),
    chatTemplateDigest: "b".repeat(64),
  },
};

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    registry: { runtimes: [runtime] },
    getAllocation: () => ({
      status: "ready",
      bindings: [{ runtime: runtime.id, release: release.id }],
    }),
    getActivation: () => ({ state: "ACTIVE", release: release.id, leaseEpoch: 7 }),
    getRelease: () => release,
    getDescriptor: () => undefined,
    sourceProvider: { read: async () => ({ content: "source", bytes: 6 }) } as unknown as ContextSourceProvider,
    sourceMaxBytes: 1024,
    materializedMaxBytes: 4096,
    countChatTokens: async () => 123,
    now: () => Date.parse("2026-09-29T00:00:00.000Z"),
    ...overrides,
  } as unknown as Parameters<typeof measureCanonicalRequest>[1];
}

const request = {
  principal: "principal-a",
  allocationId: "allocation-a",
  runtime: runtime.id,
  request: { messages: [{ role: "user", content: "hello" }] },
};

test("measures the materialized chat against the active certified runtime", async () => {
  const countChatTokens = async (endpoint: string, body: Record<string, unknown>) => {
    expect(endpoint).toBe(runtime.deployment.endpoint);
    expect(body.messages).toEqual(request.request.messages);
    return 123;
  };
  const measured = await measureCanonicalRequest(request, fixture({ countChatTokens }));
  expect(measured).toEqual({
    inputTokens: 123,
    inputBudgetTokens: 1_850,
    release: release.id,
    leaseEpoch: 7,
    tokenizerDigest: release.contextCertification.tokenizerDigest,
    chatTemplateDigest: release.contextCertification.chatTemplateDigest,
    sourceDigests: [],
  });
});

test("fails closed when context, allocation, binding, activation, or certification is unavailable", async () => {
  const cases = [
    [fixture({ enabled: false }), 503, "context_subsystem_degraded"],
    [fixture({ getAllocation: () => undefined }), 409, "no_eligible_runtime_active"],
    [fixture({ getAllocation: () => ({ status: "pending", bindings: [] }) }), 409, "no_eligible_runtime_active"],
    [fixture({ getAllocation: () => ({ status: "ready", bindings: [] }) }), 409, "no_eligible_runtime_active"],
    [fixture({ getActivation: () => ({ state: "FAILED", release: release.id, leaseEpoch: 7 }) }), 409, "no_eligible_runtime_active"],
    [fixture({ getActivation: () => ({ state: "ACTIVE", release: "old-release", leaseEpoch: 7 }) }), 409, "no_eligible_runtime_active"],
    [fixture({ registry: { runtimes: [{ ...runtime, context: { class: "standard" } }] } }), 409, "no_eligible_runtime_active"],
    [fixture({ getRelease: () => undefined }), 409, "no_eligible_runtime_active"],
  ] as const;
  for (const [deps, status, code] of cases) {
    await expect(measureCanonicalRequest(request, deps)).rejects.toMatchObject({ status, code });
  }
});

test("wraps tokenizer failures but preserves request cancellation", async () => {
  await expect(measureCanonicalRequest(request, fixture({
    countChatTokens: async () => { throw new Error("provider unavailable"); },
  }))).rejects.toMatchObject({
    status: 503,
    code: "context_subsystem_degraded",
    message: "canonical chat tokenization failed: provider unavailable",
  });

  const abort = new AbortController();
  abort.abort();
  await expect(measureCanonicalRequest({ ...request, signal: abort.signal }, fixture({
    countChatTokens: async () => { throw new Error("aborted transport"); },
  }))).rejects.toBeInstanceOf(DOMException);
  expect(new ContextControllerError(503, "context_subsystem_degraded", "degraded").name)
    .toBe("ContextControllerError");
});
