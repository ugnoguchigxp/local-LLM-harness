import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  loadRegistry,
  parseRegistryDocuments,
  RegistryError,
} from "../src/registry";

const repoConfig = join(import.meta.dir, "../../../config/gnosis");
const fixtures = join(import.meta.dir, "../test/fixtures");

test("loads the Linux production registry", () => {
  const registry = loadRegistry(repoConfig);
  const general = registry.runtimes.find((runtime) => runtime.id === "qwen-general");
  const asr = registry.runtimes.find((runtime) => runtime.id === "qwen-asr");
  const realtimeTts = registry.runtimes.find((runtime) => runtime.id === "voicevox-tts");
  const expressiveTts = registry.runtimes.find((runtime) => runtime.id === "qwen-tts");
  const qualityWorker = registry.runtimes.find(
    (runtime) => runtime.id === "qwen-worker-quality",
  );
  const defaultRoute = registry.routes.find((route) => route.id === "llm-default");
  const speedRoute = registry.routes.find((route) => route.id === "llm-speed");

  expect(registry.nodes[0]?.id).toBe("gnosis");
  expect(general?.backend).toBe("systemd");
  expect(general?.policy.class).toBe("resident");
  if (general?.backend === "systemd") {
    expect(general.deployment.healthPort).toBe(8080);
    expect(general.deployment.endpoint).toBe("http://127.0.0.1:8080");
  }
  expect(asr?.capability).toContain("speech.stt");
  expect(realtimeTts?.capability).toContain("speech.tts");
  expect(expressiveTts?.capability).toContain("speech.tts.expressive");
  expect(qualityWorker?.backend).toBe("llama-swap");
  expect(registry.profiles.some((profile) => profile.id === "voice-expressive")).toBe(true);
  expect(defaultRoute?.candidates[0]).toEqual({
    runtime: "qwen-general",
    purpose: "primary",
  });
  expect(defaultRoute?.explicitOnly).toBe(false);
  expect(speedRoute?.explicitOnly).toBe(true);
  expect(defaultRoute?.candidates.some((candidate) => candidate.runtime.includes("35b"))).toBe(false);
  expect(registry.runtimes.some((runtime) => runtime.id.includes("35b"))).toBe(false);
});

test("rejects missing policy.class", () => {
  expect(() => loadRegistry(join(fixtures, "missing-class"))).toThrow(RegistryError);
});

test("rejects unknown backend", () => {
  expect(() => loadRegistry(join(fixtures, "unknown-backend"))).toThrow(RegistryError);
});

test("rejects unknown node reference", () => {
  expect(() => loadRegistry(join(fixtures, "unknown-node"))).toThrow(RegistryError);
});

test("rejects empty profile require", () => {
  expect(() => loadRegistry(join(fixtures, "empty-profile"))).toThrow(RegistryError);
});

test("allows profiles whose capabilities are not yet in the registry", () => {
  const registry = loadRegistry(join(fixtures, "unresolved-capability"));
  expect(registry.profiles[0]?.require).toContain("llm.coding");
});

test("loads llama-swap runtimes with modelId deployment", () => {
  const registry = loadRegistry(join(fixtures, "llama-swap"));
  const general = registry.runtimes.find((r) => r.id === "qwen-general");
  expect(general?.backend).toBe("llama-swap");
  if (general?.backend === "llama-swap") {
    expect(general.deployment.modelId).toBe("qwen-general");
    expect(general.deployment.listen).toBe("http://127.0.0.1:9292");
  }
});

function registryDocuments(routes: unknown) {
  return {
    nodesYaml: {
      nodes: {
        gnosis: {
          endpoint: "http://127.0.0.1",
          resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
        },
      },
    },
    runtimesYaml: {
      runtimes: {
        "qwen-general": {
          capability: ["llm.general"],
          protocol: "openai.chat-completions.v1",
          backend: "systemd",
          node: "gnosis",
          policy: { class: "resident" },
          resources: {
            estimatedMemoryGB: 40,
            maxConcurrentRequests: 1,
            maxQueuedRequests: 0,
            queueTimeoutMs: 1000,
          },
          deployment: {
            service: "llama-server.service",
            healthPort: 8080,
            endpoint: "http://127.0.0.1:8080",
          },
        },
      },
    },
    profilesYaml: { profiles: {} },
    routesYaml: routes,
  };
}

test("rejects unknown configuration fields instead of applying defaults", () => {
  expect(() => parseRegistryDocuments(registryDocuments({
    routes: {
      "llm-speed": {
        capabilities: ["llm.general"],
        explicitOnli: true,
        candidates: [{ runtime: "qwen-general", purpose: "primary" }],
      },
    },
  }))).toThrow(/explicitOnli/);
});

test("rejects endpoint URLs whose suffix would corrupt gateway path joining", () => {
  const documents = registryDocuments({ routes: {} });
  const runtimes = documents.runtimesYaml as {
    runtimes: Record<string, { deployment: { endpoint: string } }>;
  };
  runtimes.runtimes["qwen-general"]!.deployment.endpoint = "http://127.0.0.1:8080?target=other";
  expect(() => parseRegistryDocuments(documents)).toThrow(/query/);
});

test("rejects a route that references an unknown runtime", () => {
  expect(() =>
    parseRegistryDocuments(
      registryDocuments({
        routes: {
          "llm-default": {
            capabilities: ["llm.general"],
            candidates: [{ runtime: "missing", purpose: "primary" }],
          },
        },
      }),
    ),
  ).toThrow(/unknown runtime missing/);
});

test("rejects a route whose candidate does not provide every declared capability", () => {
  expect(() =>
    parseRegistryDocuments(
      registryDocuments({
        routes: {
          "llm-default": {
            capabilities: ["llm.general", "llm.coding"],
            candidates: [{ runtime: "qwen-general", purpose: "primary" }],
          },
        },
      }),
    ),
  ).toThrow(/does not provide llm.coding/);
});

test("rejects multiple default routes for the same capability", () => {
  expect(() =>
    parseRegistryDocuments(
      registryDocuments({
        routes: {
          "llm-default": {
            capabilities: ["llm.general"],
            candidates: [{ runtime: "qwen-general", purpose: "primary" }],
          },
          "llm-other-default": {
            capabilities: ["llm.general"],
            candidates: [{ runtime: "qwen-general", purpose: "primary" }],
          },
        },
      }),
    ),
  ).toThrow(/multiple default routes/);
});

test("rejects impossible node memory reservations", () => {
  const documents = registryDocuments({ routes: {} });
  documents.nodesYaml.nodes.gnosis.resources.reservedMemoryGB = 129;
  expect(() => parseRegistryDocuments(documents)).toThrow(/reservedMemoryGB/);
});

test("rejects duplicate runtime capabilities", () => {
  const documents = registryDocuments({ routes: {} });
  documents.runtimesYaml.runtimes["qwen-general"].capability = [
    "llm.general",
    "llm.general",
  ];
  expect(() => parseRegistryDocuments(documents)).toThrow(/unique/);
});

test("rejects capabilities that do not match the runtime protocol", () => {
  const documents = registryDocuments({ routes: {} });
  documents.runtimesYaml.runtimes["qwen-general"].capability = ["speech.stt"];
  expect(() => parseRegistryDocuments(documents)).toThrow(/incompatible/);
});

test("rejects a resident floor that exceeds usable node memory", () => {
  const documents = registryDocuments({ routes: {} });
  documents.runtimesYaml.runtimes["qwen-general"].resources.estimatedMemoryGB = 113;
  expect(() => parseRegistryDocuments(documents)).toThrow(
    /resident runtimes on node gnosis require 113GB but only 112GB is usable/,
  );
});
