import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { RuntimeDefinition } from "@larm/core";
import { ExecutionGate } from "./execution-gate";
import { proxyGateway } from "./gateway";
import { UsageCoordinator } from "./usage-coordinator";
import { usagePolicy } from "./usage-policy";
import { agentPrincipal } from "./agent-connection-controller";

const runtime: RuntimeDefinition = {
  id: "test", node: "test", capability: ["llm.general"], protocol: "openai.chat-completions.v1", backend: "systemd",
  policy: { class: "preferred" }, resources: { estimatedMemoryGB: 1, maxConcurrentRequests: 1, maxQueuedRequests: 0, queueTimeoutMs: 1000 },
  deployment: { endpoint: "http://provider", service: "test.service", healthPort: 9000 },
};

function fixture(maxQueuedRequests = 0) {
  let now = 0;
  const usage = new UsageCoordinator(() => now);
  const gate = new ExecutionGate();
  const app = new Hono();
  app.use("*", usagePolicy(usage, "consumer", undefined, "shared"));
  app.post("/v1/chat/completions", c => proxyGateway({
    request: c.req.raw, runtime: { ...runtime, resources: { ...runtime.resources, maxQueuedRequests } }, protocol: runtime.protocol, allocationId: "alloc_test", upstreamPath: "/v1/chat/completions",
    bodyMode: "buffered", maxBodyBytes: 2, timeoutMs: 1000, bootEpoch: "test", executionGate: gate,
    revalidate: () => ({ ok: true, binding: { endpoint: runtime.deployment.endpoint, runtime: runtime.id } }),
    fetchImpl: async () => new Response("ok"),
  }));
  const prepare = async () => {
    // Discover the same authenticated principal that the middleware will use.
    app.get("/prepare-test", c => { usage.prepare(600_000)(true); return c.body(null, 204); });
    await app.request("/prepare-test", { headers: { authorization: "Bearer consumer" } });
    now = 100_000;
  };
  const post = (body = "too large", token = "consumer") => app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${token}` }, body });
  return { usage, gate, prepare, post };
}

test("gateway body rejection releases activity without extending protection", async () => {
  const f = fixture(); await f.prepare();
  const response = await f.post();
  expect(response.status).toBe(413);
  await response.text();
  expect(f.usage.protection.snapshot()).toMatchObject({ activeRequests: 0, remainingMs: 500_000 });
});

test("gateway queue rejection releases activity without extending protection", async () => {
  const f = fixture(); await f.prepare();
  const release = await f.gate.acquire(runtime.id, runtime.resources, new AbortController().signal);
  try {
    const response = await f.post();
    expect(response.status).toBe(429);
    await response.text();
    expect(f.usage.protection.snapshot()).toMatchObject({ activeRequests: 0, remainingMs: 500_000 });
  } finally { release(); }
});

test("a queued request rechecks protection and includes Retry-After without forwarding", async () => {
  const f = fixture(1);
  const release = await f.gate.acquire(runtime.id, runtime.resources, new AbortController().signal);
  const pending = f.post("{}", "shared");
  try {
    await Bun.sleep(0);
    expect(f.gate.snapshot(runtime.id).queued).toBe(1);
    f.usage.run(agentPrincipal("consumer"), () => f.usage.prepare(600_000)(true));
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("600");
    expect(await response.json()).toMatchObject({ error: { code: "foreground_protected" } });
    expect(f.gate.snapshot(runtime.id)).toEqual({ active: 0, queued: 0 });
  } finally { release(); await pending; }
});
