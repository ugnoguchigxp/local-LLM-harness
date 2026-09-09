import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  agentConnectionRequestSchema,
  agentConnectionClaimSchema,
  loadAgentConnectionCatalogForRegistry,
  parseAgentConnectionCatalog,
  publicAgentProfileListSchema,
  publicAgentProfileListV1Schema,
  publicAgentProfileListV3Schema,
  resolveAgentAudienceBaseUrl,
} from "./agent-connection";
import { loadRegistry } from "./registry";

const configDir = join(import.meta.dir, "../../../config/local-node");
const registry = loadRegistry(configDir);

test("production agent profiles compile to strict protocol-aware provider contracts", () => {
  const catalog = loadAgentConnectionCatalogForRegistry(configDir, registry);
  expect(catalog.defaultAgentProfile).toBe("coding-default");
  expect(catalog.profiles.map((profile) => profile.id)).toEqual([
    "asr-qwen",
    "coding-default",
    "contextstill-background",
    "contextstill-embedding",
    "deep-reasoning-35b",
    "nightworker-background",
    "tts-default",
    "tts-expressive",
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
  expect(catalog.profiles.find((profile) => profile.id === "coding-default"))
    .toMatchObject({
      selectionPolicy: "default",
      canonicalProfile: "coding-default",
      deprecated: false,
      schedulingPriority: 3000,
      providers: [{
        capability: "llm.coding",
        supportedCapabilities: ["llm.coding", "llm.general", "llm.reasoning"],
        route: "llm-default",
        protocol: "openai.chat-completions.v1",
        readiness: "llm-inference",
      }],
    });
  expect(catalog.profiles.find((profile) => profile.id === "deep-reasoning-35b"))
    .toMatchObject({
      canonicalProfile: "coding-default",
      selectionPolicy: "compatibility",
      deprecated: true,
      schedulingPriority: 3000,
      providers: [{
        capability: "llm.reasoning",
        publicModel: "coding-default",
        route: "llm-default",
      }],
    });
  const contextStill = catalog.profiles.find((profile) => profile.id === "contextstill-background");
  expect(contextStill)
    .toMatchObject({
      canonicalProfile: "contextstill-background",
      selectionPolicy: "explicit-only",
      deprecated: false,
      schedulingPriority: 1000,
      providers: [{
        capability: "llm.coding",
        supportedCapabilities: ["llm.coding", "llm.general", "llm.reasoning"],
        route: "llm-agent-worker",
        protocol: "openai.chat-completions.v1",
        publicModel: "qwen-agent-worker",
        readiness: "llm-inference",
      }],
    });
  expect(catalog.profiles.find((profile) => profile.id === "contextstill-embedding"))
    .toMatchObject({
      selectionPolicy: "explicit-only",
      schedulingPriority: 1500,
      providers: [{
        capability: "embedding.multilingual-e5-small",
        protocol: "larm.embedding.v1",
        publicModel: "multilingual-e5-small",
        readiness: "embedding",
        embeddingSpace: {
          model: {
            id: "intfloat/multilingual-e5-small",
            revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
          },
          dimension: 384,
          prefixes: { query: "query: ", passage: "passage: " },
          normalization: "l2",
          tokenization: { maxTokens: 512, truncation: "end", pooling: "mean" },
        },
      }],
    });
  expect(catalog.profiles.find((profile) => profile.id === "nightworker-background"))
    .toMatchObject({
      schedulingPriority: 2000,
      providers: [{ publicModel: "qwen-nightworker", route: "llm-agent-worker" }],
    });
  expect(catalog.profiles.find((profile) => profile.id === "asr-qwen"))
    .toMatchObject({
      selectionPolicy: "explicit-only",
      providers: [{
        capability: "speech.stt",
        route: "stt-qwen",
        protocol: "openai.audio-transcriptions.v1",
        publicModel: "qwen3-asr-1.7b",
        readiness: "stt-transcription",
      }],
    });
  expect(catalog.profiles.find((profile) => profile.id === "tts-default"))
    .toMatchObject({
      selectionPolicy: "explicit-only",
      providers: [{
        capability: "speech.tts",
        route: "tts-voicevox",
        protocol: "openai.audio-speech.v1",
        publicModel: "voicevox-core",
        readiness: "tts-speech",
      }],
    });
  expect(catalog.profiles.every((profile) => /^[a-f0-9]{64}$/.test(profile.revision))).toBeTrue();
});

test("agent profile compilation rejects unknown fields and semantic protocol drift", () => {
  const base = {
    version: 1 as const,
    defaultAgentProfile: "coding",
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
    defaultAgentProfile: "missing",
  }, registry)).toThrow(/default profile missing does not exist/);
  expect(() => parseAgentConnectionCatalog({
    ...base,
    defaultAgentProfile: "speed",
    agentProfiles: {
      speed: {
        ...base.agentProfiles.coding,
        providers: [{ ...base.agentProfiles.coding.providers[0]!, route: "llm-speed" }],
      },
    },
  }, registry)).toThrow(/default agent profile speed cannot use explicit-only route llm-speed/);
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
  expect(() => parseAgentConnectionCatalog({
    ...base,
    compatibilityAliases: {
      legacy: {
        canonicalProfile: "missing",
        description: "invalid target",
      },
    },
  }, registry)).toThrow(/unknown canonical profile missing/);
  expect(() => parseAgentConnectionCatalog({
    ...base,
    compatibilityAliases: {
      legacy: {
        canonicalProfile: "coding",
        description: "invalid provider override",
        providerCapabilities: { missing: "llm.general" },
      },
    },
  }, registry)).toThrow(/overrides unknown provider missing/);
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

test("public Agent Profile metadata identifies one capable HTTP default", () => {
  const response = {
    contractVersion: "agent-connection.v2" as const,
    catalogRevision: "catalog-test",
    defaultAgentProfile: "coding-default",
    profiles: [{
      id: "coding-default",
      canonicalProfile: "coding-default",
      description: "Resident Qwen",
      selectionPolicy: "default" as const,
      deprecated: false,
      providers: [{
        name: "llm",
        capability: "llm.coding",
        supportedCapabilities: ["llm.coding", "llm.general", "llm.reasoning"],
        protocol: "openai.chat-completions.v1" as const,
        model: "coding-default",
      }],
    }],
    audiences: ["saaa-desktop"],
  };
  expect(publicAgentProfileListSchema.parse(response).defaultAgentProfile).toBe("coding-default");
  expect(publicAgentProfileListSchema.safeParse({
    ...response,
    defaultAgentProfile: "missing",
  }).success).toBeFalse();
  expect(publicAgentProfileListSchema.safeParse({
    ...response,
    profiles: [{
      ...response.profiles[0]!,
      providers: [{
        ...response.profiles[0]!.providers[0]!,
        supportedCapabilities: ["llm.reasoning"],
      }],
    }],
  }).success).toBeFalse();
});

test("v3 discovery carries the immutable embedding space without changing v2", () => {
  const catalog = loadAgentConnectionCatalogForRegistry(configDir, registry);
  const embedding = catalog.profiles.find((profile) => profile.id === "contextstill-embedding")!;
  const response = {
    contractVersion: "agent-connection.v3" as const,
    catalogRevision: "catalog-test",
    defaultAgentProfile: catalog.defaultAgentProfile,
    profiles: catalog.profiles.map((profile) => ({
      id: profile.id,
      canonicalProfile: profile.canonicalProfile,
      description: profile.description,
      selectionPolicy: profile.selectionPolicy,
      deprecated: profile.deprecated,
      schedulingPriority: profile.schedulingPriority,
      providers: profile.providers.map((provider) => ({
        name: provider.name,
        capability: provider.capability,
        supportedCapabilities: provider.supportedCapabilities,
        protocol: provider.protocol,
        model: provider.publicModel,
        ...(provider.embeddingSpace ? { embeddingSpace: provider.embeddingSpace } : {}),
      })),
    })),
    audiences: catalog.audiences.map((audience) => audience.id),
  };
  expect(publicAgentProfileListV3Schema.parse(response).profiles)
    .toContainEqual(expect.objectContaining({ id: embedding.id }));
  expect(publicAgentProfileListSchema.safeParse({
    ...response,
    contractVersion: "agent-connection.v2",
  }).success).toBeFalse();
});

test("embedding failover candidates must preserve the exact semantic space", () => {
  const primary = registry.runtimes.find((runtime) => runtime.id === "multilingual-e5-small")!;
  const fake = structuredClone(primary);
  fake.id = "mismatched-embedding";
  fake.embedding = { ...fake.embedding!, dimension: 768 };
  const mismatchedRegistry = structuredClone(registry);
  mismatchedRegistry.runtimes.push(fake);
  const route = mismatchedRegistry.routes.find((candidate) =>
    candidate.id === "embedding-multilingual-e5-small"
  )!;
  route.explicitOnly = false;
  route.candidates.push({ runtime: fake.id, purpose: "primary" });
  expect(() => parseAgentConnectionCatalog({
    version: 1,
    defaultAgentProfile: "embedding",
    audiences: { local: { network: "loopback", baseUrl: "http://127.0.0.1:9810/v1" } },
    agentProfiles: {
      embedding: {
        description: "embedding",
        providers: [{
          name: "embedding",
          capability: "embedding.multilingual-e5-small",
          route: "embedding-multilingual-e5-small",
          publicModel: "multilingual-e5-small",
          readiness: "embedding",
        }],
      },
    },
  }, mismatchedRegistry)).toThrow(/do not share one embedding space/);
});

test("v1 Agent Profile discovery remains byte-shape compatible with the commissioned SAAA parser", () => {
  const response = {
    contractVersion: "agent-connection.v1" as const,
    catalogRevision: "catalog-test",
    profiles: [{
      id: "deep-reasoning-35b",
      description: "Legacy bootstrap alias",
      providers: [{
        name: "llm",
        capability: "llm.reasoning",
        protocol: "openai.chat-completions.v1" as const,
        model: "coding-default",
      }],
    }],
    audiences: ["saaa-desktop"],
  };
  expect(publicAgentProfileListV1Schema.parse(response)).toEqual(response);
  expect(publicAgentProfileListV1Schema.safeParse({
    ...response,
    defaultAgentProfile: "coding-default",
  }).success).toBeFalse();
});

test("explicit Agent Profile selection must name the selected profile", () => {
  expect(agentConnectionRequestSchema.safeParse({
    audience: "same-host",
    explicitAgentProfile: true,
  }).success).toBeFalse();
  expect(agentConnectionRequestSchema.safeParse({
    agentProfile: "speed",
    audience: "same-host",
    explicitAgentProfile: true,
  }).success).toBeTrue();
});

test("agent claim validation rejects inconsistent HTTP descriptors", () => {
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
    }],
  }).providers[0]?.baseUrl).toBe("http://127.example:9810/v1");
});
