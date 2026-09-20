import { expect, test } from "bun:test";
import {
  LarmApiError,
  LarmClient,
  LarmEpochChangedError,
  LarmStreamProtocolError,
} from "./index";

const allocation = {
  id: "alloc_epoch-test_1",
  bootEpoch: "epoch-test",
  status: "ready",
  requirements: [{ capability: "llm.general", route: "llm-default" }],
  bindings: [{
    capability: "llm.general",
    route: "llm-default",
    runtime: "qwen-general",
    node: "local-node",
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

function decisionConnectionFixture(
  id: string,
  expiresAt: string,
  claimExpiresAt = expiresAt,
) {
  const connection = {
    id,
    allocationId: allocation.id,
    bootEpoch: "epoch-test",
    catalogRevision: "catalog-test",
    agentProfile: "contextstill-explore",
    profileRevision: "1".repeat(64),
    audience: "same-host",
    audienceRevision: "2".repeat(64),
    status: "ready" as const,
    providers: [{
      name: "decision-default",
      capability: "llm.decision.default",
      route: "llm-decision-default",
      protocol: "openai.chat-completions.v1" as const,
      publicModel: "decision-default",
      readiness: "ready" as const,
      claimable: true,
    }],
    createdAt: "2026-08-28T00:00:00.000Z",
    expiresAt,
  };
  const claim = {
    id,
    allocationId: connection.allocationId,
    status: "ready",
    audience: connection.audience,
    providers: [{
      name: "decision-default",
      capability: "llm.decision.default",
      apiStyle: "openai",
      protocol: "openai.chat-completions.v1",
      scheme: "http",
      host: "127.0.0.1",
      port: 9810,
      baseUrl: "http://127.0.0.1:9810/v1",
      model: "decision-default",
      health: {
        url: `http://127.0.0.1:9810/v1/agent-connections/${id}/providers/decision-default/health`,
        kind: "semantic-inference",
        maxAgeMs: 10_000,
      },
      credential: {
        type: "bearer",
        token: "larm_conn_v1.refreshed.signature",
        expiresAt: claimExpiresAt,
      },
      configuration: {
        kind: "openai-provider-v1",
        fields: { baseURL: "http://127.0.0.1:9810/v1", model: "decision-default" },
        secretFields: { apiKey: "credential.token" },
      },
    }],
    expiresAt: claimExpiresAt,
  };
  return { connection, claim };
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

test("reference client calls the standard model catalog and Chat Completions without allocation headers", async () => {
  const requests: Request[] = [];
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "standard-token",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      requests.push(request);
      if (new URL(request.url).pathname === "/v1/models") {
        return json({
          object: "list",
          data: [{ id: "coding-default", object: "model", created: 0, owned_by: "larm" }],
        });
      }
      return json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "coding-default",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
      });
    },
  });

  expect((await client.listOpenAiModels()).data[0]?.id).toBe("coding-default");
  const response = await client.createChatCompletion({
    model: "coding-default",
    messages: [{ role: "user", content: "hello" }],
  });
  expect((await response.json() as { model: string }).model).toBe("coding-default");
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/v1/models",
    "/v1/chat/completions",
  ]);
  expect(requests.every((request) => request.headers.get("authorization") === "Bearer standard-token"))
    .toBeTrue();
  expect(requests.every((request) => !request.headers.has("x-larm-allocation-id"))).toBeTrue();
});

test("reference client exposes the managed context lifecycle", async () => {
  const requests: Request[] = [];
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "context-token",
    random: () => "fixed",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/v1/context-status") {
        return json({
          enabled: true,
          state: "ACTIVE",
          runtimes: [{
            runtime: "qwen-general",
            release: "qwen-general-current",
            state: "ACTIVE",
            reason: "eligible_runtime_hot",
            modes: ["source-rebuild"],
            leaseEpoch: 1,
          }],
        });
      }
      if (path === "/v1/contexts" && request.method === "POST") {
        return json({
          schemaVersion: 1,
          id: "ctx-a",
          version: "v1",
          sourceHandle: "source-a",
          sourceDigest: "a".repeat(64),
          classification: "internal",
          byteCount: 13,
          tokenCount: 20,
          tokenizerDigest: "b".repeat(64),
          state: "active",
          createdAt: "2026-09-09T00:00:00.000Z",
          updatedAt: "2026-09-09T00:00:00.000Z",
        }, "epoch-test", 201);
      }
      if (path === "/v1/context-views") {
        return json({
          id: "view-a",
          operationId: "ctxop-a",
          allocationId: "alloc-a",
          runtime: "qwen-general",
          release: "qwen-general-current",
          state: "ready",
          mode: "source-rebuild",
          tokenCount: 30,
          inputBudgetTokens: 800,
          orderedItems: [{
            contextId: "ctx-a",
            version: "v1",
            required: true,
            utility: 1,
            tokenCount: 20,
            sourceDigest: "a".repeat(64),
          }],
          omitted: [],
          createdAt: "2026-09-09T00:00:00.000Z",
          expiresAt: "2026-09-09T00:05:00.000Z",
        }, "epoch-test", 201);
      }
      return json({ ok: true });
    },
  });
  expect((await client.getContextStatus()).runtimes[0]?.state).toBe("ACTIVE");
  await client.registerContext({
    id: "ctx-a",
    version: "v1",
    sourceHandle: "source-a",
    sourceDigest: "a".repeat(64),
    classification: "internal",
    byteCount: 13,
    tokenCount: 20,
    tokenizerDigest: "b".repeat(64),
  });
  const view = await client.createContextView({
    allocationId: "alloc-a",
    runtime: "qwen-general",
    baseInputTokens: 10,
    maxInputTokens: 800,
    deadline: "2026-09-09T00:05:00.000Z",
    canonicalizationVersion: "context-view-v1",
    items: [{ contextId: "ctx-a", version: "v1", required: true, utility: 1 }],
  });
  await client.chatWithContext("alloc-a", view.id, { model: "test", messages: [] }, "llm.reasoning");
  expect(requests[1]?.headers.get("idempotency-key")).toBe("client_fixed");
  expect(requests[3]?.headers.get("x-larm-context-view-id")).toBe("view-a");
  expect(requests.every((request) => request.headers.get("authorization") === "Bearer context-token"))
    .toBeTrue();
});

test("reference client reads the strict release convergence status with the API bearer", async () => {
  let observed: Request | undefined;
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "status-token",
    fetch: async (input, init) => {
      observed = new Request(input.toString(), init);
      return json({
        schemaVersion: 1,
        operationId: "a".repeat(64),
        desiredRelease: "b".repeat(40),
        observedRelease: "b".repeat(40),
        stage: "canary_verified",
        result: "succeeded",
        reason: null,
        updatedAt: "2026-09-06T00:00:00.000Z",
      });
    },
  });

  expect((await client.getReleaseConvergenceStatus()).stage).toBe("canary_verified");
  expect(new URL(observed!.url).pathname).toBe("/v1/release-convergence");
  expect(observed?.headers.get("authorization")).toBe("Bearer status-token");
});

test("reference client yields validated Chat Completions SSE chunks incrementally", async () => {
  const encoder = new TextEncoder();
  const chunk = (choices: unknown[]) => `data: ${JSON.stringify({
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: 1,
    model: "coding-default",
    choices,
  })}\r\n\r\n`;
  const wire = encoder.encode([
    chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: "こ" }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: "んにちは。" }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
    "data: [DONE]\r\n\r\n",
  ].join(""));
  let cancelled = false;
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "stream-token",
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < wire.byteLength; index += 3) {
          controller.enqueue(wire.slice(index, index + 3));
        }
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });

  const chunks = [];
  for await (const event of client.streamChatCompletion({
    model: "coding-default",
    messages: [{ role: "user", content: "hello" }],
  })) chunks.push(event);
  expect(chunks).toHaveLength(4);
  expect(chunks[1]?.choices[0]?.delta.content).toBe("こ");
  expect(chunks[3]?.choices[0]?.finish_reason).toBe("stop");
  expect(cancelled).toBe(false);
});

test("reference client fails closed when a Chat Completions SSE terminal is missing", async () => {
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async () => new Response(
      'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
  });
  const consume = async () => {
    for await (const _event of client.streamChatCompletion({ model: "m", messages: [] })) {
      // Consume the validated prefix; success still requires the terminal contract.
    }
  };
  await expect(consume()).rejects.toBeInstanceOf(LarmStreamProtocolError);
});

test("reference client calls standard audio endpoints without allocation headers", async () => {
  const requests: Request[] = [];
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "standard-token",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      requests.push(request);
      return new Response("ok", { headers: { "content-type": "application/octet-stream" } });
    },
  });
  const form = new FormData();
  form.append("model", "qwen3-asr-1.7b");
  form.append("file", new Blob(["audio"]), "sample.wav");
  await client.createAudioTranscription(form);
  await client.createSpeech({ model: "voicevox-core", input: "hello" });
  await client.listVoices("voicevox-core");

  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/v1/audio/transcriptions",
    "/v1/audio/speech",
    "/v1/audio/voices",
  ]);
  expect(requests.every((request) => request.headers.get("authorization") === "Bearer standard-token"))
    .toBeTrue();
  expect(requests.every((request) => !request.headers.has("x-larm-allocation-id"))).toBeTrue();
  expect(requests[0]?.headers.get("content-type")).toStartWith("multipart/form-data; boundary=");
  expect(await requests[1]?.json()).toEqual({ model: "voicevox-core", input: "hello" });
  expect(new URL(requests[2]!.url).searchParams.get("model")).toBe("voicevox-core");
  expect(requests[2]?.method).toBe("GET");
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

test("public liveness omits credentials and exposes response identity", async () => {
  const requests: Request[] = [];
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "must-not-leave-the-client",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      requests.push(request);
      const headers = {
        "content-type": "application/json",
        "x-larm-boot-epoch": "epoch-live",
        "x-larm-config-revision": "a".repeat(64),
      };
      if (new URL(request.url).pathname === "/health") {
        return new Response(JSON.stringify({
          status: "ok",
          version: "0.1.0",
          releaseCommit: "development",
          configRevision: "a".repeat(64),
          bootEpoch: "epoch-live",
        }), { headers });
      }
      return new Response(JSON.stringify({ status: "stale", ageMs: 20_000 }), {
        status: 503,
        headers,
      });
    },
  });

  expect((await client.getHealth()).status).toBe("ok");
  expect((await client.getReadiness()).status).toBe("stale");
  expect(requests.every((request) => !request.headers.has("authorization"))).toBeTrue();
  expect(client.observedBootEpoch).toBe("epoch-live");
  expect(client.observedConfigRevision).toBe("a".repeat(64));
  expect(client.hasApiToken).toBeTrue();
});

test("agent profile discovery omits Authorization when the optional API token is absent", async () => {
  let observed: Request | undefined;
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async (input, init) => {
      observed = new Request(input.toString(), init);
      return json({
        contractVersion: "agent-connection.v2",
        catalogRevision: "catalog-test",
        defaultAgentProfile: "coding-default",
        profiles: [{
          id: "coding-default",
          canonicalProfile: "coding-default",
          description: "Resident Qwen",
          selectionPolicy: "default",
          deprecated: false,
          providers: [{
            name: "llm",
            capability: "llm.coding",
            supportedCapabilities: ["llm.coding", "llm.general", "llm.reasoning"],
            protocol: "openai.chat-completions.v1",
            model: "coding-default",
          }],
        }],
        audiences: ["same-host", "saaa-desktop"],
      });
    },
  });

  expect((await client.listAgentProfiles()).audiences).toEqual(["same-host", "saaa-desktop"]);
  expect(new URL(observed!.url).pathname).toBe("/v2/agent-profiles");
  expect(client.hasApiToken).toBeFalse();
  expect(observed?.headers.has("authorization")).toBeFalse();
});

test("v3 agent profile discovery preserves advertised Chat Completions context budgets", async () => {
  let observed: Request | undefined;
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "profile-token",
    fetch: async (input, init) => {
      observed = new Request(input.toString(), init);
      return json({
        contractVersion: "agent-connection.v3",
        catalogRevision: "catalog-test",
        defaultAgentProfile: "coding",
        profiles: [{
          id: "coding",
          canonicalProfile: "coding",
          description: "Coding provider",
          selectionPolicy: "default",
          deprecated: false,
          schedulingPriority: 0,
          providers: [{
            name: "llm",
            capability: "llm.coding",
            supportedCapabilities: ["llm.coding"],
            protocol: "openai.chat-completions.v1",
            model: "qwen-agent-worker",
            contextWindow: {
              maxTokens: 65_536,
              outputReserveTokens: 4_096,
              safetyMarginTokens: 1_976,
            },
          }],
        }],
        audiences: ["same-host"],
      });
    },
  });

  expect((await client.listAgentProfilesV3()).profiles[0]!.providers[0]!.contextWindow)
    .toEqual({ maxTokens: 65_536, outputReserveTokens: 4_096, safetyMarginTokens: 1_976 });
  expect(new URL(observed!.url).pathname).toBe("/v3/agent-profiles");
  expect(observed!.headers.get("authorization")).toBe("Bearer profile-token");
});

test("reference client reads strict service activity and uses the optional control bearer", async () => {
  let observed: Request | undefined;
  const now = Date.parse("2026-09-05T17:45:00.500Z");
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "activity-token",
    now: () => now,
    fetch: async (input, init) => {
      observed = new Request(input.toString(), init);
      return json({
        contractVersion: "larm-service-activity.v1",
        state: "idle",
        activeWorkloads: 0,
        observedAt: "2026-09-05T17:45:00.000Z",
        validForMs: 1_000,
        retryAfterMs: 0,
        reservationGuaranteed: false,
        bootEpoch: "epoch-test",
        configRevision: "revision-test",
      });
    },
  });

  expect(await client.getServiceActivity()).toMatchObject({ state: "idle", activeWorkloads: 0 });
  expect(new URL(observed!.url).pathname).toBe("/v1/activity");
  expect(observed?.headers.get("authorization")).toBe("Bearer activity-token");
});

test("reference client rejects non-contract service activity responses", async () => {
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async () => json({
      contractVersion: "larm-service-activity.v1",
      state: "idle",
      activeWorkloads: 0,
      observedAt: "2026-09-05T17:45:00.000Z",
      validForMs: 1_000,
      retryAfterMs: 0,
      reservationGuaranteed: false,
      bootEpoch: "epoch-test",
      configRevision: "revision-test",
      runtimes: ["qwen-general"],
    }),
  });

  await expect(client.getServiceActivity()).rejects.toThrow();
});

test("reference client fails closed on expired or implausibly future activity", async () => {
  const now = Date.parse("2026-09-05T17:45:02.000Z");
  for (const observedAt of [
    "2026-09-05T17:45:00.999Z",
    "2026-09-05T17:45:03.001Z",
  ]) {
    const client = new LarmClient({
      baseUrl: "http://127.0.0.1:9810",
      now: () => now,
      fetch: async () => json({
        contractVersion: "larm-service-activity.v1",
        state: "idle",
        activeWorkloads: 0,
        observedAt,
        validForMs: 1_000,
        retryAfterMs: 0,
        reservationGuaranteed: false,
        bootEpoch: "epoch-test",
        configRevision: "revision-test",
      }),
    });
    await expect(client.getServiceActivity()).rejects.toMatchObject({
      constructor: LarmApiError,
      code: "activity_stale",
      status: 503,
    });
  }
});

test("reference client fails closed when its activity clock is invalid", async () => {
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    now: () => Number.NaN,
    fetch: async () => json({
      contractVersion: "larm-service-activity.v1",
      state: "idle",
      activeWorkloads: 0,
      observedAt: "2026-09-05T17:45:00.000Z",
      validForMs: 1_000,
      retryAfterMs: 0,
      reservationGuaranteed: false,
      bootEpoch: "epoch-test",
      configRevision: "revision-test",
    }),
  });

  await expect(client.getServiceActivity()).rejects.toMatchObject({ code: "activity_stale" });
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
    audience: "same-host",
  });
  expect(created.status).toBe("pending");
  expect(requests[0]?.headers.get("idempotency-key")).toBe("client_agent-fixed");
  expect(await requests[0]!.clone().json()).toEqual({
    explicitAgentProfile: false,
    audience: "same-host",
    ttlSeconds: 300,
    allowFallback: false,
    deploymentPolicy: "existing-only",
  });
  const ready = await client.waitForAgentConnection(created, { pollIntervalMs: 0 });
  expect(ready.status).toBe("ready");
  expect(getCount).toBe(1);
  expect((await client.getAgentConnectionHealth(ready.id)).ready).toBeFalse();
  expect((await client.claimAgentConnection(ready.id)).providers[0]?.model).toBe("coding-default");
  await client.renewAgentConnection(ready.id, 600, { idempotencyKey: "renew-agent" });
  expect(requests.at(-1)?.headers.get("idempotency-key")).toBe("renew-agent");
  await client.releaseAgentConnection(ready.id);
  expect(requests.at(-1)?.method).toBe("DELETE");
  expect(requests.every((request) => !request.headers.has("authorization"))).toBeTrue();
});

test("agent connection refresh renews before reclaiming a coherent provider credential", async () => {
  const requests: Request[] = [];
  const { connection, claim } = decisionConnectionFixture(
    "aconn_epoch-test_refresh",
    "2026-08-28T00:10:00.000Z",
  );
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      requests.push(request);
      return new URL(request.url).pathname.endsWith("/renew")
        ? json(connection)
        : json(claim);
    },
  });

  const refreshed = await client.refreshAgentConnection(connection.id, {
    ttlSeconds: 600,
    claimFormat: "openai-provider-v1",
    idempotencyKey: "refresh-contextstill",
  });

  expect(refreshed.connection.expiresAt).toBe(connection.expiresAt);
  expect(refreshed.claim.providers[0]?.credential.token).toBe("larm_conn_v1.refreshed.signature");
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    `/v1/agent-connections/${connection.id}/renew`,
    `/v1/agent-connections/${connection.id}/claim`,
  ]);
  expect(requests[0]?.headers.get("idempotency-key")).toBe("refresh-contextstill");
  expect(await requests[0]!.clone().json()).toEqual({ ttlSeconds: 600 });
  expect(await requests[1]!.clone().json()).toEqual({ format: "openai-provider-v1" });
});

test("agent connection refresh rejects a stale claim", async () => {
  const { connection, claim } = decisionConnectionFixture(
    "aconn_epoch-test_refresh-mismatch",
    "2026-08-28T00:10:00.000Z",
    "2026-08-28T00:05:00.000Z",
  );
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      return new URL(request.url).pathname.endsWith("/renew")
        ? json(connection)
        : json(claim);
    },
  });

  await expect(client.refreshAgentConnection(connection.id)).rejects.toMatchObject({
    status: 502,
    code: "connection_refresh_mismatch",
  });
});

test("typed embedding client uses the claimed endpoint and semantic-space contract", async () => {
  const expiresAt = "2026-08-28T00:05:00.000Z";
  const claim = {
    id: "aconn_epoch-test_embedding",
    allocationId: "alloc_epoch-test_embedding",
    status: "ready" as const,
    audience: "same-host",
    providers: [{
      name: "embedding",
      capability: "embedding.multilingual-e5-small",
      apiStyle: "larm-embedding" as const,
      protocol: "larm.embedding.v1" as const,
      scheme: "http" as const,
      host: "127.0.0.1",
      port: 9810,
      baseUrl: "http://127.0.0.1:9810/v1",
      endpoint: "http://127.0.0.1:9810/v1/embed",
      model: "multilingual-e5-small",
      embeddingSpace: {
        contractVersion: "larm-embedding.v1" as const,
        workload: "embedding" as const,
        model: {
          id: "intfloat/multilingual-e5-small",
          revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
          artifactDigest: "6".repeat(64),
        },
        dimension: 384,
        inputTypes: ["query", "passage"] as ["query", "passage"],
        prefixes: { query: "query: ", passage: "passage: " },
        normalization: "l2" as const,
        tokenization: {
          kind: "sentencepiece-bpe",
          tokenizerDigest: "0".repeat(64),
          maxTokens: 512,
          truncation: "end" as const,
          pooling: "mean" as const,
        },
      },
      capacity: {
        ready: true as const,
        activeRequests: 0,
        maxConcurrentRequests: 1,
        queueDepth: 0,
        maxQueuedRequests: 32,
        queueTimeoutMs: 1_000,
        retryAfterMs: 0,
        completionGuaranteed: false as const,
      },
      health: {
        url: "http://127.0.0.1:9810/v1/agent-connections/aconn_epoch-test_embedding/providers/embedding/health",
        kind: "semantic-inference" as const,
        maxAgeMs: 10_000 as const,
      },
      credential: { type: "bearer" as const, token: "larm_conn_v1.payload.signature", expiresAt },
      configuration: {
        kind: "larm-embedding-provider-v1" as const,
        fields: {
          daemonURL: "http://127.0.0.1:9810/v1",
          model: "multilingual-e5-small",
          dimension: 384,
        },
        secretFields: { accessToken: "credential.token" as const },
      },
    }],
    expiresAt,
  };
  const requests: Request[] = [];
  let wrongDimension = false;
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "control-token",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      requests.push(request);
      if (new URL(request.url).pathname.endsWith("/claim")) return json(claim);
      const dimension = wrongDimension ? 383 : 384;
      return json({
        embeddings: [[1, ...Array.from({ length: dimension - 1 }, () => 0)]],
        dimension,
        count: 1,
        type: "passage",
        normalize: true,
        queueWaitMs: 0,
        encodeMs: 1,
      });
    },
  });
  const claimed = await client.claimAgentConnection(
    claim.id,
    "larm-embedding-provider-v1",
  );
  expect(await requests[0]!.clone().json()).toEqual({ format: "larm-embedding-provider-v1" });
  const provider = claimed.providers[0]!;
  if (provider.apiStyle !== "larm-embedding") throw new Error("expected embedding provider");
  const result = await client.embed(provider, {
    texts: ["document"],
    type: "passage",
    normalize: true,
    priority: "normal",
  });
  expect(result).toMatchObject({ dimension: 384, type: "passage" });
  expect(requests[1]?.url).toBe(provider.endpoint);
  expect(requests[1]?.headers.get("authorization")).toBe(`Bearer ${provider.credential.token}`);
  expect(requests[1]?.redirect).toBe("manual");
  expect(await requests[1]!.clone().json()).toEqual({
    texts: ["document"], type: "passage", normalize: true, priority: "normal",
  });
  wrongDimension = true;
  await expect(client.embed(provider, {
    texts: ["document"], type: "passage", normalize: true, priority: "low",
  })).rejects.toMatchObject({ code: "embedding_dimension_mismatch", responseBody: undefined });
});

test("agent connection polling deadline aborts an in-flight HTTP request", async () => {
  const connection = {
    id: "aconn_epoch-test_stalled",
    allocationId: allocation.id,
    bootEpoch: "epoch-test",
    catalogRevision: "catalog-test",
    agentProfile: "coding-default",
    profileRevision: "1".repeat(64),
    audience: "same-host",
    audienceRevision: "2".repeat(64),
    status: "pending" as const,
    providers: [{
      name: "llm",
      capability: "llm.coding",
      route: "llm-default",
      protocol: "openai.chat-completions.v1" as const,
      publicModel: "coding-default",
      readiness: "pending" as const,
      claimable: false,
    }],
    createdAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2026-08-28T00:05:00.000Z",
  };
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "api",
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });

  const startedAt = performance.now();
  await expect(client.waitForAgentConnection(connection, {
    timeoutMs: 5,
    pollIntervalMs: 0,
  })).rejects.toMatchObject({ code: "connection_timeout" });
  expect(performance.now() - startedAt).toBeLessThan(1_000);
});

test("withAgentConnection claims and releases with a fresh cleanup signal", async () => {
  const requests: Request[] = [];
  const connection = {
    id: "aconn_epoch-test_with-helper",
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
      credential: {
        type: "bearer",
        token: "larm_conn_v1.payload.signature",
        expiresAt: connection.expiresAt,
      },
      configuration: {
        kind: "openai-provider-v1",
        fields: { baseURL: "http://127.0.0.1:9810/v1", model: "coding-default" },
        secretFields: { apiKey: "credential.token" },
      },
    }],
    expiresAt: connection.expiresAt,
  };
  const abort = new AbortController();
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "api",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (request.method === "DELETE") {
        expect(request.signal.aborted).toBeFalse();
        return new Response(null, {
          status: 204,
          headers: { "x-larm-boot-epoch": "epoch-test" },
        });
      }
      if (path.endsWith("/claim")) return json(claim);
      return json(connection);
    },
  });

  await expect(client.withAgentConnection({
    audience: "same-host",
  }, async (_ready, receivedClaim) => {
    expect(receivedClaim.providers[0]?.model).toBe("coding-default");
    abort.abort(new Error("cancelled"));
    throw abort.signal.reason;
  }, { signal: abort.signal })).rejects.toThrow("cancelled");
  expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "DELETE"]);
});

test("Personal State client uses the claimed provider credential for every durable lifecycle API", async () => {
  const requests: Request[] = [];
  const digest = "a".repeat(64);
  const subjectDigest = "b".repeat(64);
  const createdAt = "2026-09-13T00:00:00.000Z";
  const expiresAt = "2026-09-13T00:10:00.000Z";
  const scopes = [
    "context.source.provision",
    "context.measure",
    "context.view.create",
    "context.generate",
    "context.attempt.cancel",
    "context.forget",
    "context.operation.read",
  ];
  const sourceReceipt = {
    contractVersion: "larm-personal-state.v1",
    operationId: "psop-source",
    incarnation: "inc-1",
    subjectDigest,
    allocationId: "alloc-1",
    runtime: "runtime-1",
    release: "release-1",
    sourceHandle: "ps-source",
    sourceDigest: digest,
    byteCount: 6,
    tokenCount: 2,
    tokenizerDigest: "c".repeat(64),
    chatTemplateDigest: "d".repeat(64),
    leaseEpoch: 1,
    dataEpoch: 0,
    state: "succeeded",
    createdAt,
    updatedAt: createdAt,
    expiresAt,
  };
  const measurementReceipt = {
    contractVersion: "larm-personal-state.v1",
    measurementId: "measure-1",
    subjectDigest,
    allocationId: "alloc-1",
    runtime: "runtime-1",
    release: "release-1",
    requestDigest: "e".repeat(64),
    baseInputTokens: 10,
    maxInputTokens: 100,
    tokenizerDigest: "c".repeat(64),
    chatTemplateDigest: "d".repeat(64),
    leaseEpoch: 1,
    dataEpoch: 0,
    createdAt,
    expiresAt,
  };
  const descriptor = {
    schemaVersion: 1,
    id: "ctx-1",
    version: "v1",
    sourceHandle: sourceReceipt.sourceHandle,
    sourceDigest: digest,
    classification: "restricted",
    byteCount: sourceReceipt.byteCount,
    tokenCount: sourceReceipt.tokenCount,
    tokenizerDigest: sourceReceipt.tokenizerDigest,
    state: "active",
    createdAt,
    updatedAt: createdAt,
  };
  const view = {
    id: "view-1",
    operationId: "ctxop-1",
    allocationId: "alloc-1",
    runtime: "runtime-1",
    release: "release-1",
    state: "ready",
    mode: "source-rebuild",
    canonicalizationVersion: "context-view-v2",
    requestDigest: measurementReceipt.requestDigest,
    dataEpoch: 0,
    tokenCount: 12,
    inputBudgetTokens: 100,
    orderedItems: [],
    omitted: [],
    createdAt,
    expiresAt,
  };
  const viewReceipt = {
    contractVersion: "larm-personal-state.v1",
    viewRequestId: "view-request-1",
    subjectDigest,
    requestDigest: measurementReceipt.requestDigest,
    planDigest: "f".repeat(64),
    idempotencyKeyDigest: "1".repeat(64),
    viewId: view.id,
    operationId: view.operationId,
    allocationId: view.allocationId,
    runtime: view.runtime,
    release: view.release,
    bootEpoch: "11111111-1111-4111-8111-111111111111",
    dataEpoch: 0,
    state: "ready",
    createdAt,
    updatedAt: createdAt,
    expiresAt,
  };
  const attempt = {
    contractVersion: "larm-personal-state.v1",
    attemptId: "attempt-1",
    subjectDigest,
    allocationId: "alloc-1",
    runtime: "runtime-1",
    release: "release-1",
    viewId: view.id,
    requestDigest: measurementReceipt.requestDigest,
    larmRequestId: "req-1",
    dataEpoch: 0,
    state: "cancelled",
    stopState: "backend_stopped",
    createdAt,
    updatedAt: createdAt,
    terminalAt: createdAt,
    outcome: "backend_stopped",
  };
  const phase = { state: "absent", updatedAt: createdAt, affected: 0 };
  const forget = {
    contractVersion: "larm-personal-state.v1",
    forgetId: "forget-1",
    operationId: "psop-forget",
    subjectDigest,
    requestDigest: digest,
    targets: { incarnation: "inc-1", contextIds: [], sourceHandles: [], attemptIds: [] },
    fenceEpoch: 1,
    state: "succeeded",
    phases: {
      attempts: phase,
      views: phase,
      runtime: phase,
      snapshots: phase,
      registry: phase,
      sources: phase,
      audit: phase,
    },
    absenceVerified: true,
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
    expiresAt,
  };
  const client = new LarmClient({
    baseUrl: "http://127.0.0.1:9810",
    apiToken: "must-not-replace-provider",
    fetch: async (input, init) => {
      const request = new Request(input.toString(), init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/v1/personal-state/capability") {
        return json({
          contractVersion: "larm-personal-state.v1",
          bootEpoch: "11111111-1111-4111-8111-111111111111",
          subjectDigest,
          allocationId: "alloc-1",
          runtime: "runtime-1",
          release: "release-1",
          leaseEpoch: 1,
          leaseExpiresAt: expiresAt,
          credentialExpiresAt: expiresAt,
          tokenizerDigest: "c".repeat(64),
          chatTemplateDigest: "d".repeat(64),
          contextLimitTokens: 1000,
          outputReserveTokens: 100,
          safetyMarginTokens: 10,
          sourceTokenLimit: 10_000,
          maxSourceBytes: 1024,
          maxTotalSourceBytes: 4096,
          maxMaterializedBytes: 2048,
          scopes,
        });
      }
      if (path === "/v1/context-sources" || path.includes("context-source-operations")) {
        return json(sourceReceipt, "epoch-test", request.method === "POST" ? 201 : 200);
      }
      if (path === "/v1/contexts") return json(descriptor, "epoch-test", 201);
      if (path === "/v1/context-measurements" || path.includes("context-measurements/")) {
        return json(measurementReceipt, "epoch-test", request.method === "POST" ? 201 : 200);
      }
      if (path === "/v2/context-views") return json(view, "epoch-test", 201);
      if (path.includes("/v2/context-views/")) return json(viewReceipt);
      if (path === "/v1/chat/completions") return json({ id: "completion-1" });
      if (path.includes("generation-attempts")) return json(attempt);
      if (path.includes("context-forget-operations")) return json(forget);
      throw new Error(`unexpected request ${request.method} ${path}`);
    },
  });
  const options = { providerToken: "larm_conn_v1.payload.signature" };
  await client.getPersonalStateCapability("alloc-1", "runtime-1", options);
  await client.provisionContextSource({
    incarnation: "inc-1",
    allocationId: "alloc-1",
    runtime: "runtime-1",
    sourceDigest: digest,
    content: "source",
  }, options);
  await client.getContextSourceOperation("inc-1", options);
  await client.registerPersonalStateContext({
    id: "ctx-1",
    version: "v1",
    sourceHandle: sourceReceipt.sourceHandle,
    sourceDigest: digest,
    classification: "restricted",
    byteCount: sourceReceipt.byteCount,
    tokenCount: sourceReceipt.tokenCount,
    tokenizerDigest: sourceReceipt.tokenizerDigest,
  }, { ...options, idempotencyKey: "register-key" });
  const chatRequest = { model: "model-1", messages: [{ role: "user", content: "hello" }] };
  await client.createContextMeasurement({
    measurementId: "measure-1",
    allocationId: "alloc-1",
    runtime: "runtime-1",
    maxInputTokens: 100,
    request: chatRequest,
  }, options);
  await client.getContextMeasurement("measure-1", options);
  await client.createPersonalStateView({
    viewRequestId: "view-request-1",
    measurementId: "measure-1",
    allocationId: "alloc-1",
    runtime: "runtime-1",
    maxInputTokens: 100,
    deadline: expiresAt,
    canonicalizationVersion: "context-view-v2",
    request: chatRequest,
    items: [{ contextId: "ctx-1", version: "v1", required: true, utility: 1 }],
  }, { ...options, idempotencyKey: "view-key" });
  await client.getPersonalStateViewReceipt("view-request-1", options);
  await client.chatPersonalState({
    allocationId: "alloc-1",
    attemptId: "attempt-1",
    viewId: "view-1",
    body: chatRequest,
  }, options);
  await client.getGenerationAttempt("attempt-1", options);
  await client.cancelGenerationAttempt("attempt-1", options);
  await client.forgetPersonalState({ forgetId: "forget-1", incarnation: "inc-1" }, options);
  await client.getForgetOperation("forget-1", options);

  expect(requests).toHaveLength(13);
  expect(requests.every((request) =>
    request.headers.get("authorization") === "Bearer larm_conn_v1.payload.signature"
  )).toBe(true);
  const sourceRequest = requests.find((request) => new URL(request.url).pathname === "/v1/context-sources")!;
  expect(sourceRequest.headers.get("x-larm-source-incarnation")).toBe("inc-1");
  expect(sourceRequest.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  const viewRequest = requests.find((request) => new URL(request.url).pathname === "/v2/context-views")!;
  expect(viewRequest.headers.get("idempotency-key")).toBe("view-key");
  const registrationRequest = requests.find((request) => new URL(request.url).pathname === "/v1/contexts")!;
  expect(registrationRequest.headers.get("idempotency-key")).toBe("register-key");
  const generationRequest = requests.find((request) => new URL(request.url).pathname === "/v1/chat/completions")!;
  expect(generationRequest.headers.get("x-larm-attempt-id")).toBe("attempt-1");
});
