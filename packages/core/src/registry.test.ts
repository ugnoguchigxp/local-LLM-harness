import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admitRuntimes } from "./admission";
import { loadAgentConnectionCatalogForRegistry } from "./agent-connection";
import type { ClusterState } from "./schema";
import { parse as parseYaml } from "yaml";
import {
  loadRegistry,
  parseRegistryDocuments,
  RegistryError,
} from "../src/registry";

const repoConfig = join(import.meta.dir, "../../../config/local-node");
const fixtures = join(import.meta.dir, "../test/fixtures");

test("prepared main LFM profile exposes text chat with internal reasoning policy and bounded capacity", () => {
  const registry = loadRegistry(repoConfig);
  const catalog = loadAgentConnectionCatalogForRegistry(repoConfig, registry);
  expect(catalog.defaultAgentProfile).toBe("lfm2.5");
  const profile = catalog.profiles.find(profile => profile.id === "lfm2.5")!;
  expect(profile.providers.find(provider => provider.name === "llm")).toMatchObject({
    route: "llm-lfm25", publicModel: "lfm2.5-24b-a2b", contextWindow: { maxTokens: 131072 },
  });
  const runtime = registry.runtimes.find(runtime => runtime.id === "lfm25-conversation")!;
  expect(runtime.reasoning).toEqual({ defaultEffort: "medium", budgets: { low: 64, medium: 256, high: 512, max: -1 } });
  expect(runtime.capability).not.toContain("llm.vision");
  expect(runtime.resources.maxConcurrentRequests).toBe(4);
  const configured = parseYaml(readFileSync(join(repoConfig, "llama-swap.yaml"), "utf8"));
  expect(configured.models["lfm25-conversation"].cmd).toContain("--ctx-size 524288");
  expect(configured.models["lfm25-conversation"].cmd).toContain("--parallel 4");
  // A finite server default would turn a request budget of -1 back into that default.
  expect(configured.models["lfm25-conversation"].cmd).toContain("--reasoning-budget -1");
  expect(registry.runtimes.find(runtime => runtime.id === "ornith15-strix-conversation")?.policy.warm?.minInstances).toBe(0);
});

test("loads the Linux production registry", () => {
  const registry = loadRegistry(repoConfig);
  const general = registry.runtimes.find((runtime) => runtime.id === "ornith-general");
  const asr = registry.runtimes.find((runtime) => runtime.id === "qwen-asr");
  const realtimeTts = registry.runtimes.find((runtime) => runtime.id === "voicevox-tts");
  const expressiveTts = registry.runtimes.find((runtime) => runtime.id === "qwen-tts");
  const defaultRoute = registry.routes.find((route) => route.id === "llm-default");
  const saaaRoute = registry.routes.find((route) => route.id === "llm-saaa-qwen38");
  const speedRoute = registry.routes.find((route) => route.id === "llm-speed");
  const model35b = registry.runtimes.find((runtime) => runtime.id === "qwen36-35b");
  const ornith35b = registry.runtimes.find((runtime) => runtime.id === "ornith15-35b");
  const ornith35bSpeed = registry.runtimes.find(
    (runtime) => runtime.id === "ornith15-35b-speed",
  );
  const agentWorker = registry.runtimes.find((runtime) => runtime.id === "qwen-worker-agent");
  const fastWorker = registry.runtimes.find((runtime) => runtime.id === "qwen-worker-fast");
  const contextStill64 = registry.runtimes.find((runtime) => runtime.id === "qwen-contextstill-64k");
  const efficientAgent = registry.runtimes.find(
    (runtime) => runtime.id === "qwen-worker-agent-efficientthink",
  );
  const decisionDefault = registry.runtimes.find((runtime) => runtime.id === "qwen35-decision");
  const lfmBackchannel = registry.runtimes.find((runtime) => runtime.id === "lfm25-backchannel-jp");
  const gemmaBackchannel = registry.runtimes.find((runtime) => runtime.id === "gemma3-backchannel");
  const agent35b = registry.runtimes.find((runtime) => runtime.id === "ornith15-35b-agent");
  const route35b = registry.routes.find((route) => route.id === "llm-35b");
  const route35bSpeed = registry.routes.find((route) => route.id === "llm-35b-speed");
  const agentWorkerRoute = registry.routes.find((route) => route.id === "llm-agent-worker");
  const contextStill64Route = registry.routes.find((route) => route.id === "llm-contextstill-64k");
  const contextStill128Route = registry.routes.find((route) => route.id === "llm-contextstill-128k");
  const decisionDefaultRoute = registry.routes.find((route) => route.id === "llm-decision-default");
  const backchannelDefaultRoute = registry.routes.find((route) =>
    route.id === "llm-backchannel-default"
  );
  const agent35bRoute = registry.routes.find((route) => route.id === "llm-agent-35b");
  const embedding = registry.runtimes.find((runtime) => runtime.id === "multilingual-e5-small");
  const embeddingRoute = registry.routes.find((route) =>
    route.id === "embedding-multilingual-e5-small"
  );

  expect(registry.nodes[0]?.id).toBe("local-node");
  expect(general?.backend).toBe("systemd");
  expect(general?.policy.class).toBe("preferred");
  expect(general?.policy.warm?.minInstances).toBe(0);
  expect(general?.resources).toMatchObject({
    maxConcurrentAllocations: 1,
    maxConcurrentRequests: 1,
  });
  if (general?.backend === "systemd") {
    expect(general.deployment.healthPort).toBe(8080);
    expect(general.deployment.endpoint).toBe("http://127.0.0.1:8080");
  }
  expect(asr?.capability).toContain("speech.stt");
  expect(realtimeTts?.capability).toContain("speech.tts");
  expect(expressiveTts?.capability).toContain("speech.tts.expressive");
  for (const runtime of registry.runtimes.filter((item) => item.backend === "systemd" && !["laya-system-one", "d1-system-one", "qwen-asr", "ornith-general"].includes(item.id))) {
    expect(runtime.policy.warm?.minInstances).toBe(1);
  }
  expect(model35b?.policy).toEqual({
    class: "preferred",
    lifecycle: "managed",
    warm: { minInstances: 0, idleTtlSeconds: 60 },
    swapGroup: "qwen-worker-slot",
  });
  expect(ornith35b?.policy).toEqual({
    class: "preferred",
    lifecycle: "managed",
    warm: { minInstances: 0, idleTtlSeconds: 60 },
    swapGroup: "qwen-worker-slot",
  });
  expect(ornith35b?.resources.estimatedMemoryGB).toBe(50);
  expect(ornith35bSpeed?.policy).toEqual({
    class: "preferred",
    lifecycle: "managed",
    warm: { minInstances: 0, idleTtlSeconds: 60 },
    swapGroup: "qwen-worker-slot",
  });
  expect(agentWorker?.resources.estimatedMemoryGB).toBe(28);
  expect(fastWorker).toMatchObject({
    capability: ["llm.general", "llm.reasoning", "llm.coding"],
    resources: { estimatedMemoryGB: 36 },
    deployment: { modelId: "qwen-fast" },
  });
  expect(contextStill64).toMatchObject({
    artifacts: ["qwen38-worker-fast", "qwen38-mtp"],
    resources: { estimatedMemoryGB: 28 },
    deployment: { modelId: "qwen-contextstill-64k" },
  });
  expect(decisionDefault).toMatchObject({
    backend: "llama-swap",
    capability: ["llm.decision.default", "llm.backchannel.classifier"],
    policy: { class: "preferred" },
    resources: {
      estimatedMemoryGB: 8,
      maxConcurrentAllocations: 1,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 16,
      queueTimeoutMs: 5000,
    },
    deployment: {
      modelId: "qwen35-decision",
      endpoint: "http://127.0.0.1:8083/upstream/qwen35-decision",
    },
  });
  expect(lfmBackchannel).toMatchObject({
    artifacts: ["lfm25-1.2b-jp-q4-k-m"],
    capability: ["llm.backchannel.classifier"],
    policy: { class: "preferred", swapGroup: "backchannel-llm-slot" },
    resources: { estimatedMemoryGB: 3 },
    deployment: { modelId: "lfm25-backchannel-jp" },
  });
  expect(gemmaBackchannel).toMatchObject({
    artifacts: ["gemma3-1b-it-q4-k-m"],
    capability: ["llm.backchannel.classifier"],
    policy: { class: "preferred", swapGroup: "backchannel-llm-slot" },
    resources: { estimatedMemoryGB: 3 },
    deployment: { modelId: "gemma3-backchannel" },
  });
  expect(efficientAgent).toMatchObject({
    resources: { estimatedMemoryGB: 28 },
    deployment: { modelId: "qwen-agent-efficientthink" },
  });
  expect(efficientAgent?.artifacts).toEqual([
    "qwen38-worker-efficientthink-q3",
    "qwen38-efficientthink-mtp",
  ]);
  expect(agent35b?.resources.estimatedMemoryGB).toBe(32);
  expect(registry.profiles.some((profile) => profile.id === "voice-expressive")).toBe(true);
  expect(defaultRoute?.candidates[0]).toEqual({
    runtime: "lfm25-conversation",
    purpose: "primary",
  });
  expect(defaultRoute?.candidates).toHaveLength(1);
  expect(defaultRoute?.explicitOnly).toBe(false);
  expect(speedRoute?.explicitOnly).toBe(true);
  expect(speedRoute?.candidates).toEqual([
    { runtime: "qwen-worker-fast", purpose: "primary" },
  ]);
  expect(saaaRoute?.candidates).toEqual([
    { runtime: "ornith-general", purpose: "primary" },
  ]);
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
    runtime: "qwen-worker-fast",
    purpose: "primary",
  });
  expect(agentWorkerRoute?.candidates[1]).toEqual({
    runtime: "qwen-worker-agent",
    purpose: "fallback",
  });
  expect(agentWorkerRoute?.candidates[2]).toEqual({
    runtime: "qwen-worker-agent-efficientthink",
    purpose: "fallback",
  });
  expect(contextStill64Route).toMatchObject({
    explicitOnly: true,
    candidates: [{ runtime: "qwen-contextstill-64k", purpose: "primary" }],
  });
  expect(contextStill128Route).toMatchObject({
    explicitOnly: true,
    candidates: [{ runtime: "qwen-worker-fast", purpose: "primary" }],
  });
  expect(contextStill64?.policy.swapGroup).toBe(fastWorker?.policy.swapGroup);
  for (const route of [defaultRoute, saaaRoute, agentWorkerRoute, speedRoute]) {
    expect(route?.candidates.some((candidate) => candidate.runtime === "qwen-general")).toBe(false);
  }
  expect(decisionDefaultRoute).toMatchObject({
    explicitOnly: true,
    capabilities: ["llm.decision.default"],
    candidates: [{ runtime: "qwen35-decision", purpose: "primary" }],
  });
  expect(backchannelDefaultRoute).toMatchObject({
    explicitOnly: true,
    capabilities: ["llm.backchannel.classifier"],
    candidates: [{ runtime: "qwen35-decision", purpose: "primary" }],
  });
  expect(agent35bRoute?.candidates[0]).toEqual({
    runtime: "ornith15-35b-agent",
    purpose: "primary",
  });
  expect(defaultRoute?.candidates).toEqual([
    { runtime: "lfm25-conversation", purpose: "primary" },
  ]);
  expect(registry.runtimes.some((runtime) => runtime.id === "qwen-general")).toBe(false);
  expect(registry.runtimes.some((runtime) => runtime.id.includes("35b"))).toBe(true);
  expect(embedding).toMatchObject({
    protocol: "larm.embedding.v1",
    policy: { class: "preferred" },
    embedding: {
      model: {
        id: "intfloat/multilingual-e5-small",
        revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
      },
      dimension: 384,
      normalization: "l2",
    },
  });
  expect(embeddingRoute).toMatchObject({
    explicitOnly: true,
    candidates: [{ runtime: "multilingual-e5-small", purpose: "primary" }],
  });
});

test("optional legacy Ornith keeps its 128K window without a resident reservation", () => {
  const registry = loadRegistry(repoConfig);
  const runtime = registry.runtimes.find((candidate) => candidate.id === "ornith-general");
  expect(runtime).toMatchObject({
    policy: { class: "preferred", warm: { minInstances: 0 } },
    context: {
      outputReserveTokens: 4_096,
      safetyMarginTokens: 1_976,
      sourceTokenLimit: 20_000_000,
    },
    resources: { maxConcurrentRequests: 1 },
  });
  const releases = parseYaml(readFileSync(join(repoConfig, "../../deploy/local-node/releases.yaml"), "utf8")) as {
    runtimeReleases: Record<string, { contextCertification?: { contextLimitTokens: number } }>;
  };
  const release = releases.runtimeReleases["ornith-general-current"];
  expect(release?.contextCertification).toBeUndefined();
  if (runtime?.context?.class !== "managed-context") {
    throw new Error("resident context contract is unavailable");
  }
  expect(131_072 - runtime.context.outputReserveTokens - runtime.context.safetyMarginTokens)
    .toBe(125_000);
});

test("production media variants are exclusive, bounded, and remain outside the base profile", () => {
  const variants = parseYaml(
    readFileSync(join(repoConfig, "runtime-variants.yaml"), "utf8"),
  ) as {
    baseProfile: string;
    groups: Record<string, { exclusive: boolean; minimumAvailableMemoryGB: number }>;
    variants: Record<string, {
      group: string;
      service: string;
      healthUrl: string;
      estimatedMemoryGB: number;
    }>;
  };
  expect(variants.baseProfile).toBe("saaa-conversation-gemma4-26b-voice");
  expect(variants.groups["accelerator-media-heavy"]).toEqual({
    exclusive: true,
    minimumAvailableMemoryGB: 16,
  });
  expect(variants.variants.music).toMatchObject({
    group: "accelerator-media-heavy",
    service: "larm-music-ace-step.service",
    healthUrl: "http://127.0.0.1:8090/health",
    estimatedMemoryGB: 18,
  });
  expect(variants.variants.image).toMatchObject({
    group: "accelerator-media-heavy",
    service: "larm-image-qwen21.service",
    healthUrl: "http://127.0.0.1:8091/health",
    estimatedMemoryGB: 34,
  });
});

test("production swap group matches llama-swap model membership", () => {
  const registry = loadRegistry(repoConfig);
  const configured = parseYaml(readFileSync(join(repoConfig, "llama-swap.yaml"), "utf8")) as {
    models: Record<string, {
      cmd: string;
      aliases?: string[];
      ttl?: number;
      filters?: { setParams?: Record<string, unknown> };
    }>;
    groups: Record<string, {
      swap: boolean;
      exclusive: boolean;
      members: string[];
    }>;
  };
  const group = configured.groups["qwen-worker-slot"];
  const conversationGroup = configured.groups["conversation-llm-slot"];
  const decisionGroup = configured.groups["qwen-decision-slot"];
  const backchannelGroup = configured.groups["backchannel-llm-slot"];
  const expected = registry.runtimes
    .filter((runtime) => runtime.policy.swapGroup === "qwen-worker-slot")
    .map((runtime) => runtime.backend === "llama-swap" ? runtime.deployment.modelId : runtime.id)
    .sort();
  expect(group).toEqual(expect.objectContaining({ swap: true, exclusive: false }));
  expect([...group!.members].sort()).toEqual(expected);
  const expectedConversation = registry.runtimes
    .filter((runtime) => runtime.policy.swapGroup === "conversation-llm-slot")
    .map((runtime) => runtime.backend === "llama-swap" ? runtime.deployment.modelId : runtime.id)
    .sort();
  expect(conversationGroup).toEqual(expect.objectContaining({ swap: true, exclusive: false }));
  expect([...conversationGroup!.members].sort()).toEqual(expectedConversation);
  expect(decisionGroup).toEqual({
    swap: false,
    exclusive: false,
    members: ["qwen35-decision"],
  });
  expect(backchannelGroup).toEqual({
    swap: true,
    exclusive: false,
    members: ["lfm25-backchannel-jp", "gemma3-backchannel"],
  });
  expect(group!.members).not.toContain("qwen35-decision");
  expect(group!.members).not.toContain("lfm25-backchannel-jp");
  expect(group!.members).not.toContain("gemma3-backchannel");
  const ornithCommand = configured.models["ornith15-35b"]?.cmd ?? "";
  const ornithSpeedCommand = configured.models["ornith15-35b-speed"]?.cmd ?? "";
  const agentWorkerCommand = configured.models["qwen-agent"]?.cmd ?? "";
  const fastWorkerCommand = configured.models["qwen-fast"]?.cmd ?? "";
  const contextStill64Command = configured.models["qwen-contextstill-64k"]?.cmd ?? "";
  const efficientAgentCommand = configured.models["qwen-agent-efficientthink"]?.cmd ?? "";
  const decisionDefaultCommand = configured.models["qwen35-decision"]?.cmd ?? "";
  const lfmBackchannelCommand = configured.models["lfm25-backchannel-jp"]?.cmd ?? "";
  const gemmaBackchannelCommand = configured.models["gemma3-backchannel"]?.cmd ?? "";
  const gemma4_26bCommand = configured.models["gemma4-26b-conversation"]?.cmd ?? "";
  const gemma4_26b = registry.runtimes.find((runtime) => runtime.id === "gemma4-26b-conversation");
  expect(gemma4_26b?.policy.warm?.minInstances).toBe(0);
  expect(gemma4_26b?.resources).toMatchObject({
    maxConcurrentAllocations: 4,
    maxConcurrentRequests: 4,
  });
  const agent35bCommand = configured.models["ornith15-35b-agent"]?.cmd ?? "";
  expect(ornithCommand).toContain("/srv/ai/apps/llama.cpp/build-vulkan/bin/llama-server");
  expect(ornithCommand).toContain("Ornith-1.5-35B-Q5_K_M.gguf");
  expect(ornithCommand).not.toContain("ngram");
  expect(ornithCommand).not.toContain("draft-mtp");
  expect(ornithCommand).toContain("--cache-type-v q8_0");
  expect(ornithCommand).not.toContain("turbo4");
  expect(ornithSpeedCommand).toContain("/srv/ai/apps/q38rocm/engine/bin/llama-server");
  expect(ornithSpeedCommand).toContain("Ornith-1.5-35B-A3B-ROCmFP4.gguf");
  expect(ornithSpeedCommand).toContain("--cache-type-v q8_0");
  expect(ornithSpeedCommand).not.toContain("turbo4");
  expect(ornithSpeedCommand).not.toContain("ngram");
  expect(ornithSpeedCommand).toContain("--spec-type draft-mtp");
  expect(ornithSpeedCommand).toContain("--spec-draft-n-max 4");
  expect(ornithSpeedCommand).toContain("--spec-draft-p-min 0.6");
  expect(ornithSpeedCommand).toContain("--no-cache-prompt");
  expect(ornithSpeedCommand).toContain("--no-cache-idle-slots");
  expect(agent35bCommand).toContain("--spec-type draft-mtp");
  expect(agent35bCommand).toContain("--spec-draft-n-max 4");
  expect(agent35bCommand).toContain("--spec-draft-p-min 0.6");
  expect(agentWorkerCommand).toContain("--ctx-size 65536");
  expect(configured.models["qwen-agent"]?.aliases).toContain("qwen-agent-worker");
  expect(fastWorkerCommand).toContain("Qwen3.8-27B-Q4_0.gguf");
  expect(fastWorkerCommand).toContain("/srv/ai/models/qwen38-worker/MTP/mtp-Qwen3.8-27B-Q4_0.gguf");
  expect(fastWorkerCommand).toContain("--spec-type draft-mtp");
  expect(fastWorkerCommand).toContain("--ctx-size 230400");
  expect(fastWorkerCommand).toContain("--batch-size 2048");
  expect(fastWorkerCommand).toContain("--ubatch-size 256");
  expect(contextStill64Command).toContain("Qwen3.8-27B-Q4_0.gguf");
  expect(contextStill64Command).toContain("/srv/ai/models/qwen38-worker/MTP/mtp-Qwen3.8-27B-Q4_0.gguf");
  expect(contextStill64Command).toContain("--spec-type draft-mtp");
  expect(contextStill64Command).toContain("--ctx-size 65536");
  expect(contextStill64Command).toContain("--batch-size 2048");
  expect(contextStill64Command).toContain("--ubatch-size 256");
  expect(gemma4_26bCommand).toContain("gemma-4-26B_q4_0-it.gguf");
  expect(gemma4_26bCommand).toContain("--ctx-size 524288");
  expect(gemma4_26bCommand).toContain("--parallel 4");
  expect(gemma4_26bCommand).toContain("--cache-type-k q4_0");
  expect(gemma4_26bCommand).toContain("--cache-type-v q4_0");
  expect(gemma4_26bCommand).toContain("--cont-batching");
  expect(gemma4_26bCommand).toContain("--kv-unified");
  expect(gemma4_26bCommand).not.toContain("draft-mtp");
  expect(efficientAgentCommand).toContain("--ctx-size 65536");
  expect(efficientAgentCommand).toContain(
    "Qwen3.8-27B-EfficientThink-SimPO-Q3-LynnStyle.gguf",
  );
  expect(efficientAgentCommand).toContain(
    "/srv/ai/models/qwen38-efficientthink/MTP/mtp-Qwen3.8-27B-Q4_0.gguf",
  );
  expect(decisionDefaultCommand).toContain("Qwen3.5-2B-Q4_K_M.gguf");
  expect(decisionDefaultCommand).toContain("--ctx-size 65536");
  expect(configured.models["qwen35-decision"]?.ttl).toBe(0);
  expect(decisionDefaultCommand).toContain("--reasoning off");
  expect(decisionDefaultCommand).toContain("--temp 0");
  expect(lfmBackchannelCommand).toContain("LFM2.5-1.2B-JP-Q4_K_M.gguf");
  expect(lfmBackchannelCommand).toContain("--ctx-size 65536");
  expect(lfmBackchannelCommand).toContain("--repeat-penalty 1.05");
  expect(configured.models["lfm25-backchannel-jp"]?.ttl).toBe(0);
  expect(configured.models["lfm25-backchannel-jp"]?.filters?.setParams).toEqual({
    temperature: 0,
    top_p: 1,
    max_tokens: 16,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "backchannel_decision",
        strict: true,
        schema: {
          type: "object",
          properties: { kind: { type: "string", enum: ["ack", "defer"] } },
          required: ["kind"],
          additionalProperties: false,
        },
      },
    },
  });
  expect(gemmaBackchannelCommand).toContain("gemma-3-1b-it-Q4_K_M.gguf");
  expect(gemmaBackchannelCommand).toContain("--ctx-size 4096");
  expect(group?.members).not.toContain("qwen35-decision");
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
        "local-node": {
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
          node: "local-node",
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
  documents.nodesYaml.nodes["local-node"].resources.reservedMemoryGB = 129;
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

test("embedding runtimes require a declared semantic space", () => {
  const documents = registryDocuments({ routes: {} });
  const runtime = documents.runtimesYaml.runtimes["qwen-general"] as Record<string, unknown>;
  runtime.capability = ["embedding.test"];
  runtime.protocol = "larm.embedding.v1";
  expect(() => parseRegistryDocuments(documents)).toThrow(/must declare its embedding space/);
});

test("rejects a resident floor that exceeds usable node memory", () => {
  const documents = registryDocuments({ routes: {} });
  documents.runtimesYaml.runtimes["qwen-general"].resources.estimatedMemoryGB = 113;
  expect(() => parseRegistryDocuments(documents)).toThrow(
    /resident runtimes on node local-node require 113GB but only 112GB is usable/,
  );
});

test("ContextStill resolves the explicit Strix backend shared with the distinct voice profile", () => {
  const registry = loadRegistry(repoConfig);
  const route = registry.routes.find((route) => route.id === "llm-contextstill-ornith");
  expect(route?.candidates).toEqual([{ runtime: "ornith15-strix-conversation", purpose: "primary" }]);
  const runtime = registry.runtimes.find((runtime) => runtime.id === "ornith15-strix-conversation");
  expect(runtime).toMatchObject({
    artifacts: ["ornith15-35b-strix-lean", "ornith15-vision-bf16"],
    policy: { warm: { minInstances: 0 }, swapGroup: "conversation-llm-slot" },
    resources: { maxConcurrentAllocations: 4, maxConcurrentRequests: 4 },
    deployment: { modelId: "ornith15-strix-conversation" },
  });
  const configured = parseYaml(readFileSync(join(repoConfig, "llama-swap.yaml"), "utf8"));
  if (!runtime || runtime.backend !== "llama-swap") throw new Error("expected llama-swap runtime");
  const command = configured.models[runtime.deployment.modelId].cmd;
  expect(command).toContain("Ornith-1.5-35B-ROCmFP4-STRIX_LEAN.gguf");
  expect(command).toContain("--ctx-size 1048576");
  expect(command).toContain("--parallel 4");
  expect(command).toContain("--cache-type-k q4_0");
  expect(command).toContain("--cache-type-v q4_0");
  expect(command).toContain("--spec-type none");
  const catalog = loadAgentConnectionCatalogForRegistry(repoConfig, registry);
  const context = catalog.profiles.find(profile => profile.id === "contextstill-background")!;
  const voice = catalog.profiles.find(profile => profile.id === "ornith1.5Strix")!;
  expect(context.id).not.toBe(voice.id);
  expect(context.schedulingPriority).toBe(1000);
  expect(context.providers.find(provider => provider.name === "llm")).toMatchObject({
    publicModel: "ornith-contextstill", contextWindow: { maxTokens: 32768 },
  });
  for (const name of ["asr", "tts", "tts-english", "embedding"]) {
    expect(context.providers.find(provider => provider.name === name))
      .toEqual(voice.providers.find(provider => provider.name === name));
  }
  const runtimeIds = (profile: typeof context) => profile.providers.flatMap(provider =>
    registry.routes.find(route => route.id === provider.route)!.candidates.slice(0, 1).map(candidate => candidate.runtime)
  );
  const foregroundRuntimes = [...new Set(runtimeIds(voice))];
  const backgroundRuntimes = [...new Set(runtimeIds(context))];
  const state = {
    generatedAt: new Date().toISOString(), node: { ...registry.nodes[0]!, online: true }, runtimes: [],
  } as unknown as ClusterState;
  const foreground = { id: "voice", status: "ready", priority: 4000,
    bindings: foregroundRuntimes.map(runtime => ({ runtime })) } as Parameters<typeof admitRuntimes>[0]["allocations"][number];
  expect(admitRuntimes({ registry, state, allocations: [foreground], candidateRuntimeIds: backgroundRuntimes }).ok).toBe(true);
  expect(registry.runtimes.find(runtime => runtime.id === "ruri-system-one")?.resources)
    .toMatchObject({ maxConcurrentAllocations: 4, maxConcurrentRequests: 1 });
});

test("production warm floor keeps LFM and speech warm while admitting explicit ContextStill Laya", () => {
  const registry = loadRegistry(repoConfig);
  const observedAt = "2026-10-04T09:00:00.000Z";
  const state: ClusterState = {
    generatedAt: observedAt,
    node: { ...registry.nodes[0]!, online: true },
    runtimes: registry.runtimes.map((runtime) => ({
      id: runtime.id,
      status: runtime.policy.class === "resident" || (runtime.policy.warm?.minInstances ?? 0) > 0 ? "HOT" : "COLD",
      class: runtime.policy.class, capability: runtime.capability,
      node: runtime.node, backend: runtime.backend,
      endpoint: runtime.deployment.endpoint, observedAt,
    })),
  };
  expect(admitRuntimes({ registry, state, allocations: [], candidateRuntimeIds: ["ornith-general"] }).ok).toBe(true);
  const context = admitRuntimes({
    registry, state, allocations: [],
    candidateRuntimeIds: ["ornith15-strix-conversation", "laya-system-one", "multilingual-e5-small", "granite-asr", "voicevox-tts", "kittentts-nano"],
  });
  expect(context.ok).toBe(true);
  expect(context.nodes[0]?.reclaimableMemoryGB ?? 0).toBe(40);
  expect(registry.runtimes.find(runtime => runtime.id === "gemma4-26b-conversation")?.policy.warm?.minInstances).toBe(0);
  expect(registry.runtimes.find(runtime => runtime.id === "qwen-asr")?.policy.warm?.minInstances).toBe(0);
  for (const id of ["lfm25-conversation", "granite-asr", "voicevox-tts", "kittentts-nano"]) {
    expect(registry.runtimes.find(runtime => runtime.id === id)?.policy.warm?.minInstances).toBe(1);
  }
});


test("Gemma uses the dedicated Ruri attitude route while ContextStill retains Laya", () => {
  const registry = loadRegistry(repoConfig);
  const catalog = loadAgentConnectionCatalogForRegistry(repoConfig, registry);
  const gemma = catalog.profiles.find((profile) => profile.id === "saaa-conversation-gemma4-26b-voice");
  const context = catalog.profiles.find((profile) => profile.id === "contextstill-background");
  expect(gemma?.providers.find((provider) => provider.name === "system-one")).toMatchObject({
    route: "system-one-ruri", publicModel: "ruri-v3-30m-speaking-attitude", readiness: "system-one",
  });
  expect(context?.providers.find((provider) => provider.name === "system-one")).toMatchObject({
    route: "system-one-laya", publicModel: "laya-multilingual",
  });
  for (const selector of ["SAAA-gemma4-26b", "SAAA-w-Image", "SAAA-w-music"]) {
    expect(catalog.profileSelectors.find((item) => item.id === selector)?.agentProfile).toBe(gemma?.id);
  }
  expect(registry.runtimes.find((runtime) => runtime.id === "laya-system-one")?.policy.warm?.minInstances).toBe(0);
  expect(registry.routes.find((route) => route.id === "system-one-ruri")?.candidates)
    .toEqual([{ runtime: "ruri-system-one", purpose: "primary" }]);
  expect(registry.runtimes.find((runtime) => runtime.id === "ruri-system-one")).toMatchObject({
    artifacts: ["ruri-v3-30m"], backend: "systemd", protocol: "larm.system-one.v1",
    deployment: { service: "ruri-system-one.service", endpoint: "http://127.0.0.1:8087" },
    resources: { estimatedMemoryGB: 1, maxConcurrentRequests: 1 },
  });
});

test("Gemma adds an English CPU speech provider while Japanese TTS and auxiliary LLM sessions keep their routes", () => {
  const registry = loadRegistry(repoConfig);
  const catalog = loadAgentConnectionCatalogForRegistry(repoConfig, registry);
  const gemma = catalog.profiles.find((profile) => profile.id === "saaa-conversation-gemma4-26b-voice")!;
  expect(gemma.providers.find((provider) => provider.name === "tts")).toMatchObject({
    capability: "speech.tts", route: "tts-voicevox", publicModel: "voicevox-core",
  });
  expect(gemma.providers.find((provider) => provider.name === "tts-english")).toMatchObject({
    capability: "speech.tts.english", route: "tts-kittentts-nano",
    publicModel: "kitten-tts-nano-0.8-fp32", protocol: "openai.audio-speech.v1", readiness: "tts-speech",
  });
  expect(registry.routes.find((route) => route.id === "tts-kittentts-nano")).toMatchObject({
    explicitOnly: true, candidates: [{ runtime: "kittentts-nano", purpose: "primary" }],
  });
  expect(registry.runtimes.find((runtime) => runtime.id === "kittentts-nano")).toMatchObject({
    policy: { lifecycle: "managed", warm: { minInstances: 1 } },
    backend: "systemd", capability: ["speech.tts.english"],
    resources: { estimatedMemoryGB: 1.5, maxConcurrentRequests: 1, maxQueuedRequests: 2 },
    deployment: { service: "kittentts-tts.service", endpoint: "http://127.0.0.1:8088" },
  });
  for (const profileId of ["saaa-conversation-gemma4-26b-64k"]) {
    expect(catalog.profiles.find((profile) => profile.id === profileId)?.providers
      .some((provider) => provider.name === "tts-english")).toBe(false);
  }
});

test("ornith1.5Strix is an explicit Gemma voice copy routed to the tested artifact", () => {
  const registry = loadRegistry(repoConfig);
  const catalog = loadAgentConnectionCatalogForRegistry(repoConfig, registry)!;
  const base = catalog.profiles.find(profile => profile.id === "saaa-conversation-gemma4-26b-voice")!;
  const strix = catalog.profiles.find(profile => profile.id === "ornith1.5Strix")!;
  expect(strix).toBeDefined();
  expect(strix.providers.filter(provider => provider.name !== "llm"))
    .toEqual(base.providers.filter(provider => provider.name !== "llm"));
  expect(strix.schedulingPriority).toBe(base.schedulingPriority);
  expect(strix.idleRelease).toEqual(base.idleRelease);
  expect(strix.providers.find(provider => provider.name === "llm")).toEqual({
    ...base.providers.find(provider => provider.name === "llm")!,
    supportedCapabilities: ["llm.general", "llm.vision"],
    route: "llm-ornith15-strix",
    publicModel: "ornith-1.5-strix-lean",
    chatInput: registry.runtimes.find(runtime => runtime.id === "ornith15-strix-conversation")!.chatInput,
  });
  expect(catalog.profileSelectors.find(selector => selector.id === "ornith1.5Strix"))
    .toMatchObject({ agentProfile: strix.id });
  const route = registry.routes.find(route => route.id === "llm-ornith15-strix")!;
  expect(route.explicitOnly).toBe(true);
  expect(route.candidates).toEqual([{ runtime: "ornith15-strix-conversation", purpose: "primary" }]);
  const runtime = registry.runtimes.find(runtime => runtime.id === route.candidates[0]!.runtime)!;
  expect(runtime.artifacts).toEqual(["ornith15-35b-strix-lean", "ornith15-vision-bf16"]);
  expect(runtime.resources.maxConcurrentRequests).toBe(4);
  const swap = parseYaml(readFileSync(join(repoConfig, "llama-swap.yaml"), "utf8"));
  expect(swap.models[runtime.id].cmd).toContain("Ornith-1.5-35B-ROCmFP4-STRIX_LEAN.gguf");
  expect(swap.models[runtime.id].cmd).toContain("--spec-type none");
  expect(swap.models[runtime.id].cmd).not.toContain("draft-mtp");
  expect(swap.models[runtime.id].cmd).toContain("--no-cache-prompt");
});
test("registered llama-swap models leave idle shutdown to LARM", () => {
  const registry = loadRegistry(repoConfig);
  const configured = parseYaml(readFileSync(join(repoConfig, "llama-swap.yaml"), "utf8"));
  for (const runtime of registry.runtimes) {
    if (runtime.backend === "llama-swap") expect(configured.models[runtime.deployment.modelId]?.ttl).toBe(0);
  }
});

test("d1 game decisions require the explicit Ornith game profile and leave ordinary profiles intact", () => {
  const registry = loadRegistry(repoConfig);
  const catalog = loadAgentConnectionCatalogForRegistry(repoConfig, registry);
  const ordinary = catalog.profiles.find(profile => profile.id === "ornith1.5Strix")!;
  const game = catalog.profiles.find(profile => profile.id === "ornith1.5Strix-game")!;
  const gameProvider = game.providers.find(provider => provider.name === "game-decision");
  expect(gameProvider).toMatchObject({ capability: "decision.game", publicModel: "d1-2b-game",
    route: "game-decision-d1", protocol: "larm.system-one.v1", readiness: "system-one" });
  expect(game.providers.filter(provider => provider.name !== "game-decision")).toEqual(ordinary.providers);
  expect(ordinary.providers.some(provider => provider.capability === "decision.game")).toBe(false);
  expect(catalog.profiles.find(profile => profile.id === "contextstill-background")?.providers
    .find(provider => provider.name === "system-one")?.publicModel).toBe("laya-multilingual");
  expect(catalog.profileSelectors.find(selector => selector.id === "ornith1.5Strix-game")?.agentProfile).toBe(game.id);
  expect(registry.routes.find(route => route.id === "game-decision-d1")).toMatchObject({
    explicitOnly: true, candidates: [{ runtime: "d1-system-one", purpose: "primary" }] });
  expect(registry.runtimes.find(runtime => runtime.id === "d1-system-one")).toMatchObject({
    policy: { lifecycle: "managed", warm: { minInstances: 0 } },
    resources: { maxConcurrentRequests: 1, maxQueuedRequests: 4, queueTimeoutMs: 100 },
    deployment: { service: "d1-system-one.service", endpoint: "http://127.0.0.1:8093" } });
});
