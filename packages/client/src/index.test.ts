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

test("typed agent connection client creates, polls, checks, claims, renews, and releases", async () => {
  const requests: Request[] = [];
  const connection = {
    id: "aconn_epoch-test_1",
    allocationId: allocation.id,
    bootEpoch: "epoch-test",
    catalogRevision: "catalog-test",
    agentProfile: "coding-default",
    profileRevision: "1".repeat(64),
    audience: "same-host",
    audienceRevision: "2".repeat(64),
    status: "ready" as const,
    providers: [{
      name: "llm",
      capability: "llm.coding",
      route: "llm-default",
      protocol: "openai.chat-completions.v1" as const,
      publicModel: "coding-default",
      readiness: "ready" as const,
      claimable: true,
    }],
    createdAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2026-08-28T00:05:00.000Z",
  };
  const claim = {
    id: connection.id,
    allocationId: connection.allocationId,
    status: "ready",
    audience: "same-host",
    providers: [{
      name: "llm",
      capability: "llm.coding",
      apiStyle: "openai",
      protocol: "openai.chat-completions.v1",
      scheme: "http",
      host: "127.0.0.1",
      port: 9810,
      baseUrl: "http://127.0.0.1:9810/v1",
      model: "coding-default",
      health: {
        url: `http://127.0.0.1:9810/v1/agent-connections/${connection.id}/providers/llm/health`,
        kind: "semantic-inference",
        maxAgeMs: 10_000,
      },
      credential: { type: "bearer", token: "larm_conn_v1.payload.signature", expiresAt: connection.expiresAt },
      configuration: {
        kind: "openai-provider-v1",
        fields: { baseURL: "http://127.0.0.1:9810/v1", model: "coding-default" },
        secretFields: { apiKey: "credential.token" },
      },
    }],
    expiresAt: connection.expiresAt,
  };
  let getCount = 0;
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "api",
    random: () => "agent-fixed",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (request.method === "DELETE") {
        return new Response(null, { status: 204, headers: { "x-larm-boot-epoch": "epoch-test" } });
      }
      if (path.endsWith("/claim")) return json(claim);
      if (path.endsWith("/health")) {
        return json({
          id: connection.id,
          status: "ready",
          ready: false,
          acceptingRequests: false,
          checkedAt: "2026-08-28T00:00:01.000Z",
          providers: [{
            name: "llm",
            capability: "llm.coding",
            ready: false,
            acceptingRequests: false,
            reason: "provider_busy",
          }],
        }, "epoch-test", 503);
      }
      if (request.method === "GET") {
        getCount += 1;
        return json({ ...connection, status: "ready" });
      }
      if (path.endsWith("/renew")) return json(connection);
      return json({ ...connection, status: "pending", providers: [{
        ...connection.providers[0], readiness: "pending", claimable: false,
      }] }, "epoch-test", 202);
    },
  });

  const created = await client.createAgentConnection({
    agentProfile: "coding-default",
    audience: "same-host",
  });
  expect(created.status).toBe("pending");
  expect(requests[0]?.headers.get("idempotency-key")).toBe("client_agent-fixed");
  const ready = await client.waitForAgentConnection(created, { pollIntervalMs: 0 });
  expect(ready.status).toBe("ready");
  expect(getCount).toBe(1);
  expect((await client.getAgentConnectionHealth(ready.id)).ready).toBeFalse();
  expect((await client.claimAgentConnection(ready.id)).providers[0]?.model).toBe("coding-default");
  await client.renewAgentConnection(ready.id, 600, { idempotencyKey: "renew-agent" });
  expect(requests.at(-1)?.headers.get("idempotency-key")).toBe("renew-agent");
  await client.releaseAgentConnection(ready.id);
  expect(requests.at(-1)?.method).toBe("DELETE");
  expect(requests.every((request) => request.headers.get("authorization") === "Bearer api")).toBeTrue();
});
