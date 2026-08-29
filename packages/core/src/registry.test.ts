import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
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
  const model35b = registry.runtimes.find((runtime) => runtime.id === "qwen36-35b");
  const ornith35b = registry.runtimes.find((runtime) => runtime.id === "ornith15-35b");
  const ornith35bSpeed = registry.runtimes.find(
    (runtime) => runtime.id === "ornith15-35b-speed",
  );
  const agentWorker = registry.runtimes.find((runtime) => runtime.id === "qwen-worker-agent");
  const agent35b = registry.runtimes.find((runtime) => runtime.id === "ornith15-35b-agent");
  const route35b = registry.routes.find((route) => route.id === "llm-35b");
  const route35bSpeed = registry.routes.find((route) => route.id === "llm-35b-speed");
  const agentWorkerRoute = registry.routes.find((route) => route.id === "llm-agent-worker");
  const agent35bRoute = registry.routes.find((route) => route.id === "llm-agent-35b");

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
  expect(qualityWorker?.policy.swapGroup).toBe("qwen-worker-slot");
  expect(model35b?.policy).toEqual({ class: "preferred", swapGroup: "qwen-worker-slot" });
  expect(ornith35b?.policy).toEqual({ class: "preferred", swapGroup: "qwen-worker-slot" });
  expect(ornith35b?.resources.estimatedMemoryGB).toBe(48);
  expect(ornith35bSpeed?.policy).toEqual({
    class: "preferred",
    swapGroup: "qwen-worker-slot",
  });
  expect(agentWorker?.resources.estimatedMemoryGB).toBe(28);
  expect(agent35b?.resources.estimatedMemoryGB).toBe(30);
  expect(registry.profiles.some((profile) => profile.id === "voice-expressive")).toBe(true);
  expect(defaultRoute?.candidates[0]).toEqual({
    runtime: "qwen-general",
    purpose: "primary",
  });
  expect(defaultRoute?.explicitOnly).toBe(false);
  expect(speedRoute?.explicitOnly).toBe(true);
  expect(route35b?.explicitOnly).toBe(true);
  expect(route35b?.candidates[0]).toEqual({ runtime: "ornith15-35b", purpose: "primary" });
  expect(route35b?.candidates[1]).toEqual({
    runtime: "ornith15-35b-speed",
    purpose: "fallback",
  });
  expect(route35b?.candidates[2]).toEqual({ runtime: "qwen36-35b", purpose: "fallback" });
  expect(route35bSpeed?.candidates[0]).toEqual({
    runtime: "ornith15-35b-speed",
    purpose: "primary",
  });
  expect(agentWorkerRoute?.candidates[0]).toEqual({
    runtime: "qwen-worker-agent",
    purpose: "primary",
  });
  expect(agent35bRoute?.candidates[0]).toEqual({
    runtime: "ornith15-35b-agent",
    purpose: "primary",
  });
  expect(defaultRoute?.candidates.some((candidate) => candidate.runtime.includes("35b"))).toBe(false);
  expect(registry.runtimes.some((runtime) => runtime.id.includes("35b"))).toBe(true);
});

test("production swap group matches llama-swap model membership", () => {
  const registry = loadRegistry(repoConfig);
  const configured = parseYaml(readFileSync(join(repoConfig, "llama-swap.yaml"), "utf8")) as {
    models: Record<string, { cmd: string }>;
    groups: Record<string, {
      swap: boolean;
      exclusive: boolean;
      members: string[];
    }>;
  };
  const group = configured.groups["qwen-worker-slot"];
  const expected = registry.runtimes
    .filter((runtime) => runtime.policy.swapGroup === "qwen-worker-slot")
    .map((runtime) => runtime.backend === "llama-swap" ? runtime.deployment.modelId : runtime.id)
    .sort();
  expect(group).toEqual(expect.objectContaining({ swap: true, exclusive: false }));
  expect([...group!.members].sort()).toEqual(expected);
  const ornithCommand = configured.models["ornith15-35b"]?.cmd ?? "";
  const ornithSpeedCommand = configured.models["ornith15-35b-speed"]?.cmd ?? "";
  const agentWorkerCommand = configured.models["qwen-agent"]?.cmd ?? "";
  const agent35bCommand = configured.models["ornith15-35b-agent"]?.cmd ?? "";
  expect(ornithCommand).toContain("/srv/ai/apps/llama.cpp/build-vulkan/bin/llama-server");
  expect(ornithCommand).toContain("Ornith-1.5-35B-Q5_K_M.gguf");
  expect(ornithCommand).not.toContain("ngram");
  expect(ornithCommand).not.toContain("draft-mtp");
  expect(ornithCommand).toContain("--cache-type-v q8_0");
  expect(ornithCommand).not.toContain("turbo4");
  expect(ornithSpeedCommand).toContain("/srv/ai/apps/q38rocm/engine/bin/llama-server");
  expect(ornithSpeedCommand).toContain("Ornith-1.5-35B-ROCmFP4-STRIX_LEAN.gguf");
  expect(ornithSpeedCommand).toContain("--cache-type-v q8_0");
  expect(ornithSpeedCommand).not.toContain("turbo4");
  expect(ornithSpeedCommand).not.toContain("ngram");
  expect(ornithSpeedCommand).not.toContain("draft-mtp");
  expect(ornithSpeedCommand).toContain("--no-cache-prompt");
  expect(ornithSpeedCommand).toContain("--no-cache-idle-slots");
  expect(agentWorkerCommand).toContain("--ctx-size 65536");
  expect(agent35bCommand).toContain("--ctx-size 65536");
  expect(agent35bCommand).not.toContain("ngram");
  expect(agent35bCommand).toContain("--cache-type-v q8_0");
  expect(agent35bCommand).not.toContain("turbo4");
  expect(agent35bCommand).toContain("--no-cache-prompt");
  expect(agent35bCommand).toContain("--no-cache-idle-slots");
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

test("swap groups are limited to non-resident llama-swap runtimes", () => {
  const resident = registryDocuments({ routes: {} });
  const residentRuntime = (resident.runtimesYaml as {
    runtimes: Record<string, { policy: { class: string; swapGroup?: string } }>;
  }).runtimes["qwen-general"]!;
  residentRuntime.policy.swapGroup = "worker-slot";
  expect(() => parseRegistryDocuments(resident)).toThrow(/resident runtime/);

  const systemd = registryDocuments({ routes: {} });
  const systemdRuntime = (systemd.runtimesYaml as {
    runtimes: Record<string, { policy: { class: string; swapGroup?: string } }>;
  }).runtimes["qwen-general"]!;
  systemdRuntime.policy = { class: "preferred", swapGroup: "worker-slot" };
  expect(() => parseRegistryDocuments(systemd)).toThrow(/must use llama-swap/);
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
