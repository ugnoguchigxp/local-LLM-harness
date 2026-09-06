import { expect, test } from "bun:test";
import type { AgentConnectionCatalog } from "../../../packages/core/src/index";
import {
  verifyLiveContract,
  type ExpectedLiveContract,
} from "./verify-live-contract";

const expected: ExpectedLiveContract = {
  commit: "a".repeat(40),
  version: "0.1.0",
  configRevision: "b".repeat(64),
  agentConnections: {
    version: 1,
    defaultAgentProfile: "coding-default",
    audiences: [{
      id: "saaa-desktop",
      network: "host-private",
      baseUrl: "request-origin",
      revision: "1".repeat(64),
    }],
    profiles: [{
      id: "coding-default",
      canonicalProfile: "coding-default",
      description: "resident",
      selectionPolicy: "default",
      deprecated: false,
      revision: "2".repeat(64),
      providers: [{
        name: "llm",
        capability: "llm.coding",
        supportedCapabilities: ["llm.coding"],
        route: "llm-default",
        publicModel: "coding-default",
        readiness: "llm-inference",
        protocol: "openai.chat-completions.v1",
        streamingProtocol: "saaa.llm-stream.v1",
      }],
    }],
  } satisfies AgentConnectionCatalog,
};

function response(path: string, model = "coding-default"): Response {
  if (path === "/health") {
    return Response.json({
      status: "ok",
      version: expected.version,
      releaseCommit: expected.commit,
      configRevision: expected.configRevision,
      bootEpoch: "epoch",
    });
  }
  if (path === "/ready") return Response.json({ status: "ready" });
  if (path === "/v1/activity") {
    return Response.json({
      contractVersion: "larm-service-activity.v1",
      state: "idle",
      activeWorkloads: 0,
      observedAt: "2030-01-01T00:00:00.000Z",
      validForMs: 1_000,
      retryAfterMs: 0,
      reservationGuaranteed: false,
      bootEpoch: "epoch",
      configRevision: expected.configRevision,
    });
  }
  if (path === "/v2/agent-profiles") {
    return Response.json({
      contractVersion: "agent-connection.v2",
      catalogRevision: expected.configRevision,
      defaultAgentProfile: "coding-default",
      profiles: [{
        id: "coding-default",
        canonicalProfile: "coding-default",
        description: "resident",
        selectionPolicy: "default",
        deprecated: false,
        providers: [{
          name: "llm",
          capability: "llm.coding",
          supportedCapabilities: ["llm.coding"],
          protocol: "openai.chat-completions.v1",
          model,
          streamingProtocol: "saaa.llm-stream.v1",
        }],
      }],
      audiences: ["saaa-desktop"],
    });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

test("post-activation contract verifies identity, activity, and the complete Agent Profile catalog", async () => {
  const paths: string[] = [];
  const result = await verifyLiveContract({
    baseUrl: "http://127.0.0.1:9810",
    expected,
    fetch: async (input) => {
      const path = new URL(input.toString()).pathname;
      paths.push(path);
      return response(path);
    },
    now: () => Date.parse("2030-01-01T00:00:00.000Z"),
  });
  expect(result).toEqual({
    ok: true,
    releaseCommit: expected.commit,
    configRevision: expected.configRevision,
    bootEpoch: "epoch",
    activity: "idle",
    agentProfiles: 1,
  });
  expect(paths).toEqual(["/health", "/ready", "/v1/activity", "/v2/agent-profiles"]);
});

test("post-activation contract rejects live catalog drift", async () => {
  const error = await verifyLiveContract({
    baseUrl: "http://127.0.0.1:9810",
    expected,
    fetch: async (input) => {
      const path = new URL(input.toString()).pathname;
      return response(path, path === "/v2/agent-profiles" ? "stale-model" : "coding-default");
    },
    now: () => Date.parse("2030-01-01T00:00:00.000Z"),
  }).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("live Agent Profile catalog does not match the candidate release");
});
