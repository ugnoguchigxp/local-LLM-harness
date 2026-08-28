import { expect, test } from "bun:test";
import { LarmApiError, LarmClient, LarmEpochChangedError } from "./index";

const allocation = {
  id: "alloc_epoch-test_1",
  bootEpoch: "epoch-test",
  status: "ready",
  requirements: [{ capability: "llm.general", route: "llm-default" }],
  bindings: [{
    capability: "llm.general",
    route: "llm-default",
    runtime: "qwen-general",
    node: "gnosis",
    status: "HOT",
    candidateRank: 1,
    fallback: false,
    selectionReason: "primary-live",
  }],
  allowFallback: false,
  deploymentPolicy: "existing-only",
  createdAt: "2026-08-28T00:00:00.000Z",
  expiresAt: "2026-08-28T00:05:00.000Z",
};

function json(body: unknown, epoch = "epoch-test", status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-larm-boot-epoch": epoch },
  });
}

test("reference client sends idempotency and always releases withAllocation", async () => {
  const requests: Request[] = [];
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    random: () => "fixed",
    fetch: async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      requests.push(request);
      return json(requests.length === 2 ? { ...allocation, status: "released", releasedAt: "2026-08-28T00:01:00.000Z" } : allocation);
    },
  });
  const result = await client.withAllocation({
    requirements: [{ capability: "llm.general", route: "llm-default" }],
    allowFallback: false,
    ttlSeconds: 300,
    deploymentPolicy: "existing-only",
  }, async (ready) => ready.bindings[0]?.runtime);
  expect(result).toBe("qwen-general");
  expect(requests[0]?.headers.get("idempotency-key")).toBe("client_fixed");
  expect(requests[1]?.method).toBe("DELETE");
});

test("reference client rejects invalid timeout configuration", async () => {
  expect(() => new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    timeoutMs: Number.NaN,
  })).toThrow(/positive finite/);
  const client = new LarmClient({ baseUrl: "http://127.0.0.1:9810" });
  await expect(client.waitForOperation("op_test", { pollIntervalMs: -1 })).rejects.toThrow(
    /nonnegative finite/,
  );
});

test("reference client reports boot epoch changes instead of retrying silently", async () => {
  let calls = 0;
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async () => json(allocation, calls++ === 0 ? "epoch-one" : "epoch-two"),
  });
  await client.getAllocation(allocation.id);
  await expect(client.getAllocation(allocation.id)).rejects.toBeInstanceOf(LarmEpochChangedError);
  expect(client.observedBootEpoch).toBe("epoch-two");
});

test("reference client keeps management credentials off ordinary requests", async () => {
  const headers: Headers[] = [];
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "api-secret",
    managementToken: "management-secret",
    fetch: async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      headers.push(request.headers);
      return json(allocation);
    },
  });
  await client.allocate({
    requirements: [{ capability: "llm.general", route: "llm-default" }],
    deploymentPolicy: "existing-only",
    allowFallback: false,
    ttlSeconds: 300,
  }, { idempotencyKey: "safe" });
  expect(headers[0]?.get("authorization")).toBe("Bearer api-secret");
  expect(headers[0]?.has("x-larm-management-token")).toBeFalse();
});

test("withAllocation releases a failed pending allocation exactly once", async () => {
  const methods: string[] = [];
  let calls = 0;
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      methods.push(request.method);
      calls += 1;
      if (calls === 1) return json({ ...allocation, status: "pending" });
      if (calls === 2) return json({
        ...allocation,
        status: "failed",
        error: { code: "start_failed", message: "failed" },
      });
      return json({ ...allocation, status: "released", releasedAt: "2026-08-28T00:01:00.000Z" });
    },
  });
  await expect(client.withAllocation({
    requirements: [{ capability: "llm.general", route: "llm-default" }],
    deploymentPolicy: "existing-only",
    allowFallback: false,
    ttlSeconds: 300,
  }, async () => undefined, { pollIntervalMs: 0 })).rejects.toMatchObject({ code: "start_failed" });
  expect(methods).toEqual(["POST", "GET", "DELETE"]);
});

test("client cancellation aborts an in-flight lifecycle request", async () => {
  const abort = new AbortController();
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });
  const request = client.getAllocation(allocation.id, abort.signal);
  abort.abort(new Error("cancelled"));
  await expect(request).rejects.toThrow("cancelled");
});

test("client timeout remains active until a streaming response completes", async () => {
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    timeoutMs: 2,
    fetch: async () => new Response(new ReadableStream({ start() {} }), {
      headers: { "x-larm-boot-epoch": "epoch-test" },
    }),
  });
  const response = await client.chat(allocation.id, { stream: true });
  await expect(response.text()).rejects.toThrow();
});

test("reference client polls operations to a terminal result", async () => {
  let calls = 0;
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async () => json({
      id: "op_test",
      kind: "allocation",
      allocationId: allocation.id,
      status: calls++ === 0 ? "pending" : "succeeded",
      ready: calls > 1,
      desired: ["llm.general"],
      ensure: [],
      createdAt: "2026-08-28T00:00:00.000Z",
      ...(calls > 1 ? { completedAt: "2026-08-28T00:00:01.000Z" } : {}),
    }),
  });
  expect((await client.waitForOperation("op_test", { pollIntervalMs: 0 })).status).toBe("succeeded");
  expect(calls).toBe(2);
});

test("reference client surfaces renew failures without retrying", async () => {
  let calls = 0;
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async () => {
      calls += 1;
      return json({ error: { code: "allocation_expired", message: "expired" } }, "epoch-test", 409);
    },
  });
  await expect(client.renew(allocation.id)).rejects.toMatchObject({
    constructor: LarmApiError,
    code: "allocation_expired",
  });
  expect(calls).toBe(1);
});

test("withAllocation releases exactly once when the handler fails", async () => {
  const methods: string[] = [];
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      methods.push(request.method);
      return json(request.method === "DELETE"
        ? { ...allocation, status: "released", releasedAt: "2026-08-28T00:01:00.000Z" }
        : allocation);
    },
  });
  await expect(client.withAllocation({
    requirements: [{ capability: "llm.general", route: "llm-default" }],
    deploymentPolicy: "existing-only",
    allowFallback: false,
    ttlSeconds: 300,
  }, async () => { throw new Error("handler failed"); })).rejects.toThrow("handler failed");
  expect(methods).toEqual(["POST", "DELETE"]);
});

test("operation polling has a bounded overall timeout", async () => {
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async () => json({
      id: "op_stalled",
      kind: "allocation",
      allocationId: allocation.id,
      status: "pending",
      ready: false,
      desired: ["llm.general"],
      ensure: [],
      createdAt: "2026-08-28T00:00:00.000Z",
    }),
  });
  await expect(client.waitForOperation("op_stalled", { timeoutMs: 0 })).rejects.toMatchObject({
    code: "operation_timeout",
  });
});

test("operation polling deadline aborts an in-flight HTTP request", async () => {
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });
  const startedAt = performance.now();
  await expect(client.waitForOperation("op_stalled", { timeoutMs: 5 })).rejects.toMatchObject({
    code: "operation_timeout",
  });
  expect(performance.now() - startedAt).toBeLessThan(1_000);
});

test("allocation polling has a bounded overall timeout and still releases once", async () => {
  const methods: string[] = [];
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      methods.push(request.method);
      return json(request.method === "DELETE"
        ? { ...allocation, status: "released", releasedAt: "2026-08-28T00:01:00.000Z" }
        : { ...allocation, status: "pending" });
    },
  });
  await expect(client.withAllocation({
    requirements: [{ capability: "llm.general", route: "llm-default" }],
    deploymentPolicy: "existing-only",
    allowFallback: false,
    ttlSeconds: 300,
  }, async () => undefined, { timeoutMs: 0 })).rejects.toMatchObject({
    code: "allocation_timeout",
  });
  expect(methods).toEqual(["POST", "DELETE"]);
});

test("withAllocation reports release failure after a successful handler", async () => {
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      return request.method === "DELETE"
        ? json({ error: { code: "release_failed", message: "not released" } }, "epoch-test", 503)
        : json(allocation);
    },
  });
  await expect(client.withAllocation({
    requirements: [{ capability: "llm.general", route: "llm-default" }],
    deploymentPolicy: "existing-only",
    allowFallback: false,
    ttlSeconds: 300,
  }, async () => "done")).rejects.toMatchObject({ code: "release_failed" });
});

test("withAllocation preserves both handler and release failures", async () => {
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      return request.method === "DELETE"
        ? json({ error: { code: "release_failed", message: "not released" } }, "epoch-test", 503)
        : json(allocation);
    },
  });
  const failure = await client.withAllocation({
    requirements: [{ capability: "llm.general", route: "llm-default" }],
    deploymentPolicy: "existing-only",
    allowFallback: false,
    ttlSeconds: 300,
  }, async () => { throw new Error("handler failed"); }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    expect.objectContaining({ message: "handler failed" }),
    expect.objectContaining({ code: "release_failed" }),
  ]);
});
