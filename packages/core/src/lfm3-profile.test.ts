import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { createOpenAiModelCatalog, getOpenAiModel, loadRegistry, loadAgentConnectionCatalogForRegistry } from "./index";

const config = resolve(import.meta.dir, "../../../config/local-node");

test("LFM3 is explicit, demand-driven, and keeps the same auxiliary providers as LFM2.5", () => {
  const registry = loadRegistry(config);
  const catalog = loadAgentConnectionCatalogForRegistry(config, registry);
  const lfm25 = catalog.profiles.find(p => p.id === "lfm2.5")!;
  const lfm3 = catalog.profiles.find(p => p.id === "lfm3.1.7b")!;
  expect(lfm3.providers.filter(p => p.name !== "llm")).toEqual(lfm25.providers.filter(p => p.name !== "llm"));
  expect(lfm3.providers.find(p => p.name === "llm")).toMatchObject({ route: "llm-lfm3", publicModel: "lfm3-1.7b", contextWindow: { maxTokens: 32768 } });
  expect(catalog.defaultAgentProfile).not.toBe("lfm3.1.7b");
  const models = createOpenAiModelCatalog(catalog);
  expect(getOpenAiModel(models, "lfm3-1.7b", "openai.chat-completions.v1")).toMatchObject({
    route: "llm-lfm3", profileIds: ["lfm3.1.7b"],
  });
  expect(getOpenAiModel(models, "lfm2.5-24b-a2b", "openai.chat-completions.v1")).toMatchObject({ route: "llm-lfm25" });
  expect(catalog.profileSelectors.find(s => s.id === "lfm3.1.7b")?.agentProfile).toBe(lfm3.id);
  expect(registry.routes.find(r => r.id === "llm-lfm3")).toMatchObject({ explicitOnly: true, candidates: [{ runtime: "lfm3-conversation", purpose: "primary" }] });
  expect(registry.runtimes.find(r => r.id === "lfm3-conversation")).toMatchObject({
    artifacts: ["lfm3-1.7b-qad-q4-0"], reasoning: { defaultEffort: "medium", readinessDisableThinking: true, budgets: { low: 64, medium: 256, high: 512, max: -1 } },
    resources: { maxConcurrentRequests: 4 }, policy: { warm: { minInstances: 0 }, swapGroup: "conversation-llm-slot" },
    deployment: { chatAdapter: "llama-reasoning-budget-v1", modelId: "lfm3-conversation" },
  });
  const swap = parseYaml(readFileSync(join(config, "llama-swap.yaml"), "utf8"));
  expect(swap.groups["conversation-llm-slot"].members).toContain("lfm3-conversation");
  // The engine treats a request value of -1 as its startup default; max must stay unlimited.
  expect(swap.models["lfm3-conversation"].cmd).toContain("--reasoning-budget -1");
  expect(swap.models["lfm3-conversation"].cmd).toContain("--ctx-size 131072");
  expect(swap.models["lfm3-conversation"].cmd).toContain("--parallel 4");
});
