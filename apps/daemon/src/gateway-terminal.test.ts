import { expect, test } from "bun:test";
import type { RuntimeDefinition } from "@larm/core";
import { ExecutionGate } from "./execution-gate";
import { proxyGateway } from "./gateway";
import { RequestTracker } from "./metrics";
import { AllocationLifecycleError } from "./allocation-lifecycle";

const runtime = {
  id: "qwen-worker-agent",
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
    modelId: "qwen-agent",
    listen: "http://127.0.0.1:8083",
    endpoint: "http://127.0.0.1:8083/upstream/qwen-agent",
    backendEndpoint: "http://127.0.0.1:8083/upstream/qwen-agent",
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

test("gateway runs finish callback only after a streaming response terminates", async () => {
  let finishes = 0;
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
    executionGate: new ExecutionGate(),
    revalidate: () => ({
      ok: true,
      binding: { endpoint: runtime.deployment.endpoint, runtime: runtime.id },
    }),
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    })),
    onFinish: () => { finishes += 1; },
  });
  expect(finishes).toBe(0);
  expect(await response.text()).toBe("chunk");
  await Bun.sleep(0);
  expect(finishes).toBe(1);
});

test("generation attempt cancellation is observable and terminates the upstream transport", async () => {
  const gate = new ExecutionGate();
  const attempt = new AbortController();
  let markFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  let forwarded = 0;
  let terminal: { outcome: string; upstreamStatus?: number } | undefined;
  const pending = proxyGateway({
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
    attemptSignal: attempt.signal,
    requestId: "req_attempt-1",
    revalidate: () => ({ ok: true, binding: { endpoint: runtime.deployment.endpoint, runtime: runtime.id } }),
    onForwarded: () => { forwarded += 1; },
    onTerminal: (value) => { terminal = value; },
    fetchImpl: async (_input, init) => {
      markFetchStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
  await fetchStarted;
  attempt.abort(new Error("cancelled by receipt"));
  const response = await pending;
  expect(response.status).toBe(409);
  expect(response.headers.get("x-request-id")).toBe("req_attempt-1");
  expect(await response.json()).toEqual({
    error: { code: "request_cancelled", message: "generation attempt was cancelled" },
  });
  await Bun.sleep(0);
  expect(forwarded).toBe(1);
  expect(terminal).toEqual({ outcome: "attempt_cancelled" });
  expect(gate.snapshot(runtime.id)).toEqual({ active: 0, queued: 0 });
});

test("foreground preemption returns a distinctive retryable ContextStill error", async () => {
  const gate = new ExecutionGate();
  const lifecycle = new AbortController();
  let markFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  const pending = proxyGateway({
    request: new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen-agent-worker", messages: [], stream: false }),
    }),
    allocationId: "allocation-contextstill",
    protocol: "openai.chat-completions.v1",
    upstreamPath: "/v1/chat/completions",
    runtime,
    bodyMode: "buffered",
    maxBodyBytes: 1024,
    timeoutMs: 1_000,
    bootEpoch: "boot-1",
    executionGate: gate,
    lifecycleSignal: lifecycle.signal,
    requestId: "req_contextstill-1",
    revalidate: () => ({ ok: true, binding: { endpoint: runtime.deployment.endpoint, runtime: runtime.id } }),
    fetchImpl: async (_input, init) => {
      markFetchStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
  await fetchStarted;
  lifecycle.abort(new AllocationLifecycleError(
    "foreground_preempted",
    "request stopped because a higher-priority foreground task requires the provider",
  ));
  const response = await pending;
  expect(response.status).toBe(409);
  expect(response.headers.get("retry-after")).toBe("1");
  expect(response.headers.get("x-larm-preemption-reason")).toBe("higher-priority-foreground-task");
  expect(await response.json()).toEqual({
    error: {
      code: "foreground_preempted",
      message: "request stopped because a higher-priority foreground task requires the provider",
    },
  });
  expect(gate.snapshot(runtime.id)).toEqual({ active: 0, queued: 0 });
});
