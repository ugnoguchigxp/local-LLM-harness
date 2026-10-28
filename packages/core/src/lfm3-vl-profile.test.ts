import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { createOpenAiModelCatalog, loadAgentConnectionCatalogForRegistry, loadRegistry } from "./index";

test("LFM3-VL is an explicit, on-demand image chat provider without evicting conversation", () => {
  const directory = resolve(import.meta.dir, "../../../config/local-node");
  const registry = loadRegistry(directory);
  const catalog = loadAgentConnectionCatalogForRegistry(directory, registry);
  const profile = catalog.profiles.find(p => p.id === "lfm3-vl-2b")!;
  const provider = profile.providers.find(p => p.name === "llm")!;
  const runtime = registry.runtimes.find(r => r.id === "lfm3-vl")!;
  expect(catalog.defaultAgentProfile).not.toBe(profile.id);
  expect(catalog.profileSelectors.find(s => s.id === "lfm3-vl-2b")?.agentProfile).toBe(profile.id);
  expect(provider).toMatchObject({ route: "llm-lfm3-vl", publicModel: "lfm3-vl-2b", protocol: "openai.chat-completions.v1", supportedCapabilities: ["llm.general", "llm.vision"], contextWindow: { maxTokens: 8192 }, chatInput: { tokenCounting: { protocol: "llama-chat-token-count.v1" } } });
  expect(runtime.policy).toMatchObject({ lifecycle: "managed", warm: { minInstances: 0, idleTtlSeconds: 60 } });
  expect(runtime.policy.swapGroup).toBeUndefined();
  expect(runtime.resources).toMatchObject({ maxConcurrentAllocations: 1, maxConcurrentRequests: 1 });
  expect(createOpenAiModelCatalog(catalog).models.find(m => m.id === "lfm3-vl-2b")?.route).toBe("llm-lfm3-vl");
  const swap = parse(readFileSync(resolve(directory, "llama-swap.yaml"), "utf8"));
  const command = swap.models["lfm3-vl-2b"].cmd as string;
  expect(swap.models["lfm3-vl-2b"].ttl).toBe(0);
  expect(command).toContain("--mmproj");
  expect(command).toContain("-dev none");
  expect(command).toContain("--no-mmproj-offload");
  expect(command).toContain("--ctx-size 8192");
  expect(Object.values(swap.groups as Record<string, { members: string[] }>).some(group => group.members.includes("lfm3-vl-2b"))).toBe(false);
});
