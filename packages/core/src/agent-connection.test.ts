import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  loadAgentConnectionCatalogForRegistry,
  parseAgentConnectionCatalog,
} from "./agent-connection";
import { loadRegistry } from "./registry";

const configDir = join(import.meta.dir, "../../../config/gnosis");
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
      baseUrl: "http://192.168.0.65:9810/v1",
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
});
