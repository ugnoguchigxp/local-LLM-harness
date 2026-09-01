import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  agentConnectionClaimSchema,
  loadAgentConnectionCatalogForRegistry,
  parseAgentConnectionCatalog,
  resolveAgentAudienceBaseUrl,
} from "./agent-connection";
import { loadRegistry } from "./registry";

const configDir = join(import.meta.dir, "../../../config/local-node");
const registry = loadRegistry(configDir);

test("production agent profiles compile to strict protocol-aware provider contracts", () => {
  const catalog = loadAgentConnectionCatalogForRegistry(configDir, registry);
  expect(catalog.profiles.map((profile) => profile.id)).toEqual([
    "coding-default",
    "coding-worker",
    "deep-reasoning-35b",
  ]);
  expect(catalog.audiences.map((audience) => audience.id)).toEqual([
    "saaa-desktop",
    "same-host",
  ]);
  expect(catalog.audiences.find((audience) => audience.id === "saaa-desktop"))
    .toMatchObject({
      network: "host-private",
      baseUrl: "request-origin",
    });
  expect(catalog.profiles.find((profile) => profile.id === "deep-reasoning-35b"))
    .toMatchObject({
      providers: [{
        capability: "llm.reasoning",
        route: "llm-agent-35b",
        protocol: "openai.chat-completions.v1",
        readiness: "llm-inference",
      }],
    });
  expect(catalog.profiles.every((profile) => /^[a-f0-9]{64}$/.test(profile.revision))).toBeTrue();
});

test("agent profile compilation rejects unknown fields and semantic protocol drift", () => {
  const base = {
    version: 1 as const,
    audiences: {
      local: { network: "loopback" as const, baseUrl: "http://127.0.0.1:9810/v1" },
    },
    agentProfiles: {
      coding: {
        description: "coding",
        providers: [{
          name: "llm",
          capability: "llm.coding",
          route: "llm-default",
          publicModel: "coding",
          readiness: "llm-inference" as const,
        }],
      },
    },
  };
  expect(parseAgentConnectionCatalog(base, registry).profiles[0]?.providers[0]?.protocol)
    .toBe("openai.chat-completions.v1");
  expect(() => parseAgentConnectionCatalog({ ...base, unexpected: true }, registry)).toThrow(
    /Unrecognized key/,
  );
  expect(() => parseAgentConnectionCatalog({
    ...base,
    agentProfiles: {
      coding: {
        ...base.agentProfiles.coding,
        providers: [{ ...base.agentProfiles.coding.providers[0]!, readiness: "stt-transcription" }],
      },
    },
  }, registry)).toThrow(/readiness does not match/);
  expect(() => parseAgentConnectionCatalog({
    ...base,
    audiences: { local: { network: "loopback", baseUrl: "http://example.com:9810/v1" } },
  }, registry)).toThrow(/baseUrl is not canonical/);
  expect(() => parseAgentConnectionCatalog({
    ...base,
    audiences: { local: { network: "host-private", baseUrl: "http://127.0.0.1:9810/v1" } },
  }, registry)).toThrow(/baseUrl is not canonical/);
  expect(() => parseAgentConnectionCatalog({
    ...base,
    audiences: { local: { network: "loopback", baseUrl: "request-origin" } },
  }, registry)).toThrow(/request-origin is only valid for host-private/);
});

test("request-origin audiences derive a canonical Gateway URL from the authenticated ingress", () => {
  const catalog = loadAgentConnectionCatalogForRegistry(configDir, registry);
  const audience = catalog.audiences.find((item) => item.id === "saaa-desktop")!;

  expect(resolveAgentAudienceBaseUrl(
    audience,
    "http://gnosis.local:9810/v1/agent-connections?ignored=true",
  )).toBe("http://gnosis.local:9810/v1");
  expect(resolveAgentAudienceBaseUrl(
    audience,
    "http://192.168.50.23:9810/v1/agent-connections",
  )).toBe("http://192.168.50.23:9810/v1");
  expect(resolveAgentAudienceBaseUrl(
    audience,
    "http://127.0.0.1:9810/v1/agent-connections",
  )).toBeUndefined();
  expect(resolveAgentAudienceBaseUrl(
    audience,
    "http://0.0.0.0:9810/v1/agent-connections",
  )).toBeUndefined();
});

test("agent claim validation accepts canonical WS and rejects inconsistent remote descriptors", () => {
  const expiresAt = "2026-08-29T12:10:00.000Z";
  const claim = {
    id: "aconn_epoch-test_1",
    allocationId: "alloc_epoch-test_1",
    status: "ready" as const,
    audience: "saaa-desktop",
    providers: [{
      name: "llm",
      capability: "llm.reasoning",
      apiStyle: "openai" as const,
      protocol: "openai.chat-completions.v1" as const,
      scheme: "http" as const,
      host: "192.0.2.42",
      port: 9810,
      baseUrl: "http://192.0.2.42:9810/v1",
      model: "deep-reasoning-35b",
      health: {
        url: "http://192.0.2.42:9810/v1/agent-connections/aconn_epoch-test_1/providers/llm/health",
        kind: "semantic-inference" as const,
        maxAgeMs: 10_000 as const,
      },
      credential: { type: "bearer" as const, token: "short-lived", expiresAt },
      configuration: {
        kind: "openai-provider-v1" as const,
        fields: { baseURL: "http://192.0.2.42:9810/v1", model: "deep-reasoning-35b" },
        secretFields: { apiKey: "credential.token" as const },
      },
    }],
    expiresAt,
  };

  expect(agentConnectionClaimSchema.parse(claim).providers[0]?.port).toBe(9810);
  expect(agentConnectionClaimSchema.safeParse({
    ...claim,
    providers: [{ ...claim.providers[0]!, baseUrl: "not-a-url" }],
  }).success).toBeFalse();
  expect(() => agentConnectionClaimSchema.parse({
    ...claim,
    providers: [{ ...claim.providers[0]!, port: 8080 }],
  })).toThrow(/port must match baseUrl/);
  expect(() => agentConnectionClaimSchema.parse({
    ...claim,
    providers: [{
      ...claim.providers[0]!,
      configuration: {
        ...claim.providers[0]!.configuration,
        fields: { ...claim.providers[0]!.configuration.fields, model: "wrong-model" },
      },
    }],
  })).toThrow(/configuration model must match model/);
  expect(() => agentConnectionClaimSchema.parse({
    ...claim,
    providers: [{
      ...claim.providers[0]!,
      health: { ...claim.providers[0]!.health, url: "http://127.0.0.1:9810/health" },
    }],
  })).toThrow(/health URL must match/);
  expect(agentConnectionClaimSchema.parse({
    ...claim,
    providers: [{
      ...claim.providers[0]!,
      host: "127.example",
      baseUrl: "http://127.example:9810/v1",
      health: {
        ...claim.providers[0]!.health,
        url: "http://127.example:9810/v1/agent-connections/aconn_epoch-test_1/providers/llm/health",
      },
      configuration: {
        ...claim.providers[0]!.configuration,
        fields: {
          ...claim.providers[0]!.configuration.fields,
          baseURL: "http://127.example:9810/v1",
        },
      },
      streaming: {
        protocol: "saaa.llm-stream.v1" as const,
        url: "ws://127.example:9810/v1/llm/stream",
        encoding: "json-control+binary-delta-v1" as const,
        compression: "none" as const,
        maxConcurrentRuns: 1,
        maxConnections: 1,
        resumeWindowMs: 120_000,
        upstreamTransport: "native" as const,
      },
    }],
  }).providers[0]?.streaming?.url).toBe("ws://127.example:9810/v1/llm/stream");
  expect(() => agentConnectionClaimSchema.parse({
    ...claim,
    providers: [{
      ...claim.providers[0]!,
      protocol: "openai.audio-transcriptions.v1",
      streaming: {
        protocol: "saaa.llm-stream.v1" as const,
        url: "ws://192.0.2.42:9810/v1/llm/stream",
        encoding: "json-control+binary-delta-v1" as const,
        compression: "none" as const,
        maxConcurrentRuns: 1,
        maxConnections: 1,
        resumeWindowMs: 120_000,
        upstreamTransport: "native" as const,
      },
    }],
  })).toThrow(/native SAAA streaming requires openai\.chat-completions\.v1/);
});
