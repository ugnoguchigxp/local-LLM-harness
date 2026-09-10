import { expect, test } from "bun:test";
import type { RuntimeDefinition } from "@larm/core";
import { ExecutionGate } from "./execution-gate";
import { proxyGateway } from "./gateway";
import { RequestTracker } from "./metrics";

const runtime = {
  id: "qwen-worker-quality",
  capability: ["llm.reasoning"],
  protocol: "openai.chat-completions.v1",
  backend: "llama-swap",
  node: "local-node",
  policy: { class: "preferred", swapGroup: "qwen-worker-slot" },
  resources: {
    estimatedMemoryGB: 40,
    maxConcurrentRequests: 1,
    maxQueuedRequests: 1,
    queueTimeoutMs: 1_000,
  },
  deployment: {
    modelId: "qwen-quality",
    listen: "http://127.0.0.1:8083",
    endpoint: "http://127.0.0.1:8083/upstream/qwen-quality",
    backendEndpoint: "http://127.0.0.1:8083/upstream/qwen-quality",
  },
} as RuntimeDefinition;

test("gateway retains the execution slot until the terminal snapshot callback finishes", async () => {
  const gate = new ExecutionGate();
  const tracker = new RequestTracker();
  let releaseTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  let observed: { outcome: string; upstreamStatus?: number } | undefined;
  const response = await proxyGateway({
    request: new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen", messages: [] }),
    }),
    allocationId: "allocation-1",
    protocol: "openai.chat-completions.v1",
    upstreamPath: "/v1/chat/completions",
    runtime,
    bodyMode: "buffered",
    maxBodyBytes: 1024,
    timeoutMs: 1_000,
    bootEpoch: "boot-1",
    executionGate: gate,
    requestTracker: tracker,
    revalidate: () => ({ ok: true, binding: { endpoint: runtime.deployment.endpoint, runtime: runtime.id } }),
    fetchImpl: async () => Response.json({ choices: [] }),
    onTerminal: async (value) => {
      observed = value;
      await terminal;
    },
  });
  expect(response.status).toBe(200);
  await response.text();
  await Bun.sleep(0);
  expect(observed).toEqual({ outcome: "http_200", upstreamStatus: 200 });
  expect(gate.snapshot(runtime.id)).toEqual({ active: 1, queued: 0 });
  expect(tracker.count()).toBe(1);
  releaseTerminal?.();
  await Bun.sleep(0);
  expect(gate.snapshot(runtime.id)).toEqual({ active: 0, queued: 0 });
  expect(tracker.count()).toBe(0);
});
