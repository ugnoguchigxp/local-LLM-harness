import { describe, expect, test } from "bun:test";
import type { AgentConnectionClaim } from "../../../packages/core/src/index";
import { loadSoakConfig } from "./soak-saaa-websocket";

const environment = {
  LARM_BASE_URL: "http://127.0.0.1:9810",
  LARM_API_TOKEN: "test-control-token",
  LARM_SAAA_CONNECTION_ID: "aconn_soak_test",
};

function claim(generation: number, overrides: {
  model?: string;
  streamUrl?: string;
} = {}): AgentConnectionClaim {
  const expiresAt = "2026-09-01T00:00:00.000Z";
  const model = overrides.model ?? "coding-default";
  const streamUrl = overrides.streamUrl ?? "ws://127.0.0.1:9810/v1/llm/stream";
  return {
    id: "aconn_soak_test",
    allocationId: "alloc_soak_test",
    status: "ready",
    audience: "same-host",
    expiresAt,
    providers: [{
      name: "llm",
      capability: "llm.coding",
      apiStyle: "openai",
      protocol: "openai.chat-completions.v1",
      scheme: "http",
      host: "127.0.0.1",
      port: 9810,
      baseUrl: "http://127.0.0.1:9810/v1",
      model,
      health: {
        url: "http://127.0.0.1:9810/v1/agent-connections/aconn_soak_test/providers/llm/health",
        kind: "semantic-inference",
        maxAgeMs: 10_000,
      },
      credential: { type: "bearer", token: `provider-token-${generation}`, expiresAt },
      configuration: {
        kind: "openai-provider-v1",
        fields: { baseURL: "http://127.0.0.1:9810/v1", model },
        secretFields: { apiKey: "credential.token" },
      },
      streaming: {
        protocol: "saaa.llm-stream.v1",
        url: streamUrl,
        encoding: "json-control+binary-delta-v1",
        compression: "none",
        maxConcurrentRuns: 1,
        maxConnections: 1,
        resumeWindowMs: 120_000,
        upstreamTransport: "native",
      },
    }],
  };
}

describe("SAAA WebSocket soak configuration", () => {
  test("renews and reclaims the Agent Connection for every credential rotation", async () => {
    let generation = 0;
    let renewals = 0;
    let claims = 0;
    const config = await loadSoakConfig(environment, () => ({
      renewAgentConnection: async () => {
        renewals += 1;
        generation += 1;
        return {} as never;
      },
      claimAgentConnection: async () => {
        claims += 1;
        return claim(generation);
      },
    }));

    expect(config.turns).toBe(1_000);
    expect(config.minimumDurationMs).toBe(30 * 60 * 1_000);
    expect(config.token).toBe("provider-token-1");
    expect(await config.rotateCredential()).toBe("provider-token-2");
    expect({ renewals, claims }).toEqual({ renewals: 2, claims: 2 });
  });

  test("fails closed when a renewed claim changes a run invariant", async () => {
    let generation = 0;
    const config = await loadSoakConfig(environment, () => ({
      renewAgentConnection: async () => {
        generation += 1;
        return {} as never;
      },
      claimAgentConnection: async () => claim(generation, generation > 1
        ? { model: "different-model" }
        : {}),
    }));

    await expect(config.rotateCredential()).rejects.toThrow(
      "renewed SAAA claim changed a connection or Provider invariant",
    );
  });

  test("accepts a cleartext non-loopback control URL for a local-network audience", async () => {
    let clientBaseUrl = "";
    const config = await loadSoakConfig({
      ...environment,
      LARM_BASE_URL: "http://192.0.2.10:9810",
    }, (options) => {
      clientBaseUrl = options.baseUrl;
      return {
        renewAgentConnection: async () => ({} as never),
        claimAgentConnection: async () => claim(1),
      };
    });
    expect(clientBaseUrl).toBe("http://192.0.2.10:9810/");
    expect(config.url).toBe("ws://127.0.0.1:9810/v1/llm/stream");
  });
});
