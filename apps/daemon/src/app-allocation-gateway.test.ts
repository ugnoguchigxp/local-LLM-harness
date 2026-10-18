import { expect, test } from "bun:test";
import { Hono } from "hono";
import { allocationSchema, type Registry } from "@larm/core";
import { resolveGatewayAllocation } from "./app-allocation-gateway";

function fixture() {
  const registry: Registry = {
    nodes: [{ id: "node", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 32, reservedMemoryGB: 2 } }], profiles: [], routes: [],
    runtimes: [{ id: "llm", capability: ["llm.general"], protocol: "openai.chat-completions.v1", backend: "systemd", node: "node",
      policy: { class: "resident" }, resources: { estimatedMemoryGB: 2, maxConcurrentRequests: 1, maxQueuedRequests: 1, queueTimeoutMs: 100 },
      deployment: { service: "fixture.service", healthPort: 8080, endpoint: "http://127.0.0.1:8080" } }],
  };
  const allocation = allocationSchema.parse({ id: "alloc_test", bootEpoch: "test", status: "ready", requirements: [{ capability: "llm.general", route: "default" }],
    bindings: [{ capability: "llm.general", route: "default", runtime: "llm", node: "node", endpoint: "http://127.0.0.1:8080", status: "HOT", candidateRank: 1, fallback: false, selectionReason: "primary-live" }],
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), allowFallback: false, deploymentPolicy: "existing-only" });
  type Input = Omit<Parameters<typeof resolveGatewayAllocation>[0], "context">;
  const input: Input = { registry, declaredAllocationId: allocation.id, protocol: "openai.chat-completions.v1", control: {
    getAllocation: () => allocation,
    allocationLookupError: () => ({ status: 404, body: { error: { code: "allocation_not_found", message: "missing" } } }),
    resolveAllocation: () => ({ status: 200, body: allocation.bindings[0]! }),
  } };
  const request = (changes: Partial<Input> = {}) => {
    const app = new Hono();
    app.get("/", c => {
      const result = resolveGatewayAllocation({ ...input, ...changes, context: c });
      return result.ok ? c.json({ ready: true, runtime: result.runtime.id }) : result.response;
    });
    return app.request("/");
  };
  return { input, allocation, registry, request };
}

test("gateway refuses capabilities and protocols that were never allocated", async () => {
  const { request } = fixture();
  const capability = await request({ capabilityHeader: "speech.tts" });
  expect(capability.status).toBe(404);
  expect(await capability.json()).toMatchObject({ error: { code: "capability_not_allocated" } });
  const protocol = await request({ protocol: "openai.audio-speech.v1" });
  expect(protocol.status).toBe(404);
  expect(await protocol.json()).toMatchObject({ error: { code: "protocol_not_allocated" } });
});

test("gateway refuses stale context views and a runtime that changes protocol during resolution", async () => {
  const { request, input, allocation } = fixture();
  const stale = await request({ contextViewId: "view_stale" });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "context_view_stale" } });
  const missing = await request({ control: { ...input.control, resolveAllocation: () => ({ status: 200, body: { ...allocation.bindings[0]!, runtime: "replaced" } }) } });
  expect(missing.status).toBe(409);
  expect(await missing.json()).toMatchObject({ error: { code: "protocol_mismatch" } });
});

test("gateway preserves resolver failures and rejects provider-specific options on another protocol", async () => {
  const { request, input } = fixture();
  const failed = await request({ control: { ...input.control, resolveAllocation: () => ({ status: 503, body: { error: { code: "runtime_not_ready", message: "stopped" } } }) } });
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ error: { code: "runtime_not_ready" } });
  const unsupported = await request({ voicevoxOnlyParameter: "speedScale" });
  expect(unsupported.status).toBe(400);
  expect(await unsupported.json()).toMatchObject({ error: { code: "unsupported_parameter", param: "speedScale" } });
});
