import { expect, test } from "bun:test";
import {
  runAgentHttpSmoke,
  type AgentHttpSmokeFetch,
} from "./smoke-agent-http";

const releaseCommit = "a".repeat(40);
const configRevision = "b".repeat(64);
const observedAt = "2030-01-01T00:00:00.000Z";
const connectionId = "aconn_epoch_1";
const expiresAt = "2030-01-01T00:05:00.000Z";
const providerToken = "larm_conn_v1.secret.signature";

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "x-larm-boot-epoch": "epoch",
      "x-larm-config-revision": configRevision,
    },
  });
}

function fixtureFetch(options: { badSse?: boolean } = {}): {
  fetch: AgentHttpSmokeFetch;
  requests: Array<{ url: string; method: string; body?: unknown }>;
  released: () => boolean;
} {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  let released = false;
  const connection = {
    id: connectionId,
    allocationId: "alloc_epoch_1",
    bootEpoch: "epoch",
    catalogRevision: configRevision,
    agentProfile: "contextstill-background",
    profileRevision: "1".repeat(64),
    audience: "saaa-desktop",
    audienceRevision: "2".repeat(64),
    status: "ready",
    providers: [{
      name: "llm",
      capability: "llm.coding",
      route: "llm-agent-worker",
      protocol: "openai.chat-completions.v1",
      publicModel: "qwen-agent-worker",
      readiness: "ready",
      claimable: true,
    }],
    createdAt: observedAt,
    expiresAt,
  };
  const providerHealthUrl = `http://larm.test:9810/v1/agent-connections/${connectionId}/providers/llm/health`;

  return {
    requests,
    released: () => released,
    fetch: async (input, init) => {
      const request = new Request(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        init,
      );
      const url = new URL(request.url);
      const recorded = { url: request.url, method: request.method } as {
        url: string;
        method: string;
        body?: unknown;
      };
      requests.push(recorded);
      const authorization = request.headers.get("authorization");
      if (url.pathname === "/health") {
        return json({
          status: "ok",
          version: "0.1.0",
          releaseCommit,
          configRevision,
          bootEpoch: "epoch",
        });
      }
      if (url.pathname === "/ready") return json({ status: "ready" });
      if (url.pathname === "/v1/activity") {
        return json({
          contractVersion: "larm-service-activity.v1",
          state: "idle",
          activeWorkloads: 0,
          observedAt,
          validForMs: 1_000,
          retryAfterMs: 0,
          reservationGuaranteed: false,
          bootEpoch: "epoch",
          configRevision,
        });
      }
      if (url.pathname === "/v2/agent-profiles") {
        return json({
          contractVersion: "agent-connection.v2",
          catalogRevision: configRevision,
          defaultAgentProfile: "coding-default",
          profiles: [
            {
              id: "coding-default",
              canonicalProfile: "coding-default",
              description: "default",
              selectionPolicy: "default",
              deprecated: false,
              providers: [{
                name: "llm",
                capability: "llm.coding",
                supportedCapabilities: ["llm.coding"],
                protocol: "openai.chat-completions.v1",
                model: "coding-default",
                streamingProtocol: "saaa.llm-stream.v1",
              }],
            },
            {
              id: "contextstill-background",
              canonicalProfile: "contextstill-background",
              description: "background",
              selectionPolicy: "explicit-only",
              deprecated: false,
              providers: [{
                name: "llm",
                capability: "llm.coding",
                supportedCapabilities: ["llm.coding"],
                protocol: "openai.chat-completions.v1",
                model: "qwen-agent-worker",
              }],
            },
          ],
          audiences: ["saaa-desktop"],
        });
      }
      if (url.pathname === "/v1/agent-connections" && request.method === "POST") {
        recorded.body = await request.json();
        return json(connection, 201);
      }
      if (url.pathname === `/v1/agent-connections/${connectionId}/claim`) {
        return json({
          id: connectionId,
          allocationId: connection.allocationId,
          status: "ready",
          audience: "saaa-desktop",
          providers: [{
            name: "llm",
            capability: "llm.coding",
            apiStyle: "openai",
            protocol: "openai.chat-completions.v1",
            scheme: "http",
            host: "larm.test",
            port: 9810,
            baseUrl: "http://larm.test:9810/v1",
            model: "qwen-agent-worker",
            health: { url: providerHealthUrl, kind: "semantic-inference", maxAgeMs: 10_000 },
            credential: { type: "bearer", token: providerToken, expiresAt },
            configuration: {
              kind: "openai-provider-v1",
              fields: { baseURL: "http://larm.test:9810/v1", model: "qwen-agent-worker" },
              secretFields: { apiKey: "credential.token" },
            },
          }],
          expiresAt,
        });
      }
      if (url.pathname === `/v1/agent-connections/${connectionId}` && request.method === "DELETE") {
        released = true;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `/v1/agent-connections/${connectionId}`) {
        return json(released
          ? { ...connection, status: "released", releasedAt: "2030-01-01T00:00:10.000Z" }
          : connection);
      }
      if (url.toString() === providerHealthUrl) {
        if (authorization !== `Bearer ${providerToken}` || released) return json({ error: "unauthorized" }, 401);
        return json({
          name: "llm",
          capability: "llm.coding",
          ready: true,
          acceptingRequests: true,
          probe: {
            kind: "semantic-inference",
            protocol: "openai.chat-completions.v1",
            latencyMs: 1,
            validated: true,
            cached: true,
            observedAt,
          },
        });
      }
      if (url.pathname === "/v1/chat/completions" && authorization === `Bearer ${providerToken}`) {
        const body = await request.json() as { stream?: boolean };
        recorded.body = body;
        if (!body.stream) {
          return json({ choices: [{ index: 0, message: { role: "assistant", content: "OK" } }] });
        }
        const value = options.badSse
          ? 'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n'
          : [
            'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n',
            'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ].join("");
        return new Response(value, { headers: { "content-type": "text/event-stream" } });
      }
      return json({ error: `unexpected ${request.method} ${url.pathname}` }, 500);
    },
  };
}

test("generic Agent HTTP smoke validates profile, claim, JSON, SSE, release, and revocation", async () => {
  const fixture = fixtureFetch();
  const result = await runAgentHttpSmoke({
    baseUrl: "http://larm.test:9810",
    apiToken: "control-token",
    agentProfile: "contextstill-background",
    audience: "saaa-desktop",
    client: "contextstill",
    expectedModel: "qwen-agent-worker",
    expectedReleaseCommit: releaseCommit,
    fetch: fixture.fetch,
    now: () => Date.parse(observedAt),
    random: () => "fixed",
  });
  expect(result).toMatchObject({
    ok: true,
    agentProfile: "contextstill-background",
    model: "qwen-agent-worker",
    jsonValidated: true,
    sse: { chunks: 2, deltas: 1, finishReasons: 1 },
    finalActivity: "idle",
    released: true,
    credentialRevoked: true,
  });
  expect(JSON.stringify(result)).not.toContain(providerToken);
  const create = fixture.requests.find((request) =>
    new URL(request.url).pathname === "/v1/agent-connections" && request.method === "POST"
  );
  expect(create?.body).toEqual({
    agentProfile: "contextstill-background",
    explicitAgentProfile: true,
    audience: "saaa-desktop",
    client: "contextstill",
    ttlSeconds: 300,
    allowFallback: false,
    deploymentPolicy: "existing-only",
  });
});

test("generic Agent HTTP smoke rejects an empty incomplete stream and still releases", async () => {
  const fixture = fixtureFetch({ badSse: true });
  const error = await runAgentHttpSmoke({
    baseUrl: "http://larm.test:9810",
    agentProfile: "contextstill-background",
    audience: "saaa-desktop",
    client: "contextstill",
    fetch: fixture.fetch,
    now: () => Date.parse(observedAt),
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("missing_delta");
  expect((error as Error).message).not.toContain(providerToken);
  expect(fixture.released()).toBeTrue();
});
