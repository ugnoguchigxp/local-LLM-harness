import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { createOpenAiModelCatalog, getOpenAiModel, loadAgentConnectionCatalogForRegistry, loadRegistry } from "./index";

const directory = resolve(import.meta.dir, "../../../config/local-node");

test("FAST has four 200k slots and expanded retention while STRIX is retired", () => {
  const registry = loadRegistry(directory);
  const catalog = loadAgentConnectionCatalogForRegistry(directory, registry);
  const auxiliary = catalog.profiles.find(p => p.id === "lfm3.1.7b")!.providers.filter(p => p.name !== "llm");
  const lfm3 = registry.runtimes.find(r => r.id === "lfm3-conversation")!;
  const models = createOpenAiModelCatalog(catalog);
  const swap = parse(readFileSync(resolve(directory, "llama-swap.yaml"), "utf8"));
  expect(catalog.defaultAgentProfile).toBe("lfm2.5");
  expect(registry.runtimes.some(r => r.id === "qwen38-rocmfp4-strix-conversation")).toBe(false);
  expect(catalog.profileSelectors.some(s => s.id === "qwen3.8-strix")).toBe(false);
  expect(swap.models["qwen38-rocmfp4-strix-conversation"]).toBeUndefined();
  for (const variant of ["fast"]) {
    const id = `qwen3.8-${variant}`;
    const runtimeId = `qwen38-rocmfp4-${variant}-conversation`;
    const routeId = `llm-qwen38-rocmfp4-${variant}`;
    const profile = catalog.profiles.find(p => p.id === id)!;
    expect(profile.providers.filter(p => p.name !== "llm")).toEqual(auxiliary);
    expect(profile.providers.find(p => p.name === "llm")).toMatchObject({ route: routeId, contextWindow: { maxTokens: 200000 } });
    expect(catalog.profileSelectors.find(s => s.id === id)?.agentProfile).toBe(id);
    expect(getOpenAiModel(models, `qwen3.8-27b-rocmfp4-${variant}`, "openai.chat-completions.v1"))
      .toMatchObject({ route: routeId, profileIds: [id] });
    expect(registry.routes.find(r => r.id === routeId)).toMatchObject({ explicitOnly: true, candidates: [{ runtime: runtimeId, purpose: "primary" }] });
    const runtime = registry.runtimes.find(r => r.id === runtimeId)!;
    expect(runtime).toMatchObject({
      reasoning: { defaultEffort: "medium", allowNone: true, readinessDisableThinking: true, budgets: { low: 64, medium: 256, high: 512, max: -1 } },
      policy: { warm: { minInstances: 0 }, swapGroup: "conversation-llm-slot" },
      resources: { estimatedMemoryGB: 48, maxConcurrentRequests: 4, maxConcurrentAllocations: 4 },
      deployment: { chatAdapter: "llama-reasoning-budget-v1", modelId: runtimeId },
    });
    expect(runtime.promptRetention).toMatchObject({ maxBytes: 24 * 1024 ** 3, principalMaxBytes: 24 * 1024 ** 3, entryMaxBytes: 8 * 1024 ** 3, stagingMaxBytes: 8 * 1024 ** 3, idleTtlMs: lfm3.promptRetention!.idleTtlMs, maxAgeMs: lfm3.promptRetention!.maxAgeMs });
    expect(runtime.textInput?.engineBuild).toBe("rocmfpx-120141f-larm-mtp-retention-v1");
    expect(runtime.capability).not.toContain("llm.vision");
    expect(swap.groups["conversation-llm-slot"].members).toContain(runtimeId);
    const command = swap.models[runtimeId].cmd as string;
    expect(command.trim().split(/\s+/)[0]).toBe("/usr/bin/python3");
    const engine = "larm-qwen38-mtp-120141f-v3";
    expect(command).toContain(`${engine}/launch-prompt-retention.py`);
    expect(command).toContain(`${engine}/llama-server`);
    expect(command).toContain("--ctx-size 800000");
    expect(command).toContain("--parallel 4");
    expect(command).toContain("--spec-type draft-mtp");
    expect(command).toContain("--no-spec-mtp-strict-qwen");
    expect(command).toContain("--spec-draft-n-max 3");
    expect(command).toContain("--reasoning-budget -1");
    expect(command).toContain("--cache-prompt");
    expect(command).toContain("--cache-ram 24576");
    expect(command).toContain("--no-kv-unified");
    expect(command).toContain("--ctx-checkpoints 8");
    // Both targets contain their own MTP weights; a Base sidecar would change the combination.
    expect(command).not.toMatch(/(?:^|\s)-md\s/);
    expect(runtime.artifacts).toHaveLength(1);
  }
});
