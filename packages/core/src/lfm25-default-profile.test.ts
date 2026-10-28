import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadRegistry, loadAgentConnectionCatalogForRegistry, createOpenAiModelCatalog } from "./index";

test("legacy default selector resolves the temporary Qwen FAST MTP profile while vision remains explicit", () => {
  const directory = join(import.meta.dir, "../../../config/local-node");
  const registry = loadRegistry(directory), catalog = loadAgentConnectionCatalogForRegistry(directory, registry);
  expect(catalog.defaultAgentProfile).toBe("lfm2.5");
  for (const id of ["lfm2.5", "ornith1.5Strix"]) expect(catalog.profileSelectors.find(s => s.id === id)?.agentProfile).toBe("lfm2.5");
  const llm = catalog.profiles.find(p => p.id === "lfm2.5")!.providers.find(p => p.name === "llm")!;
  expect(llm).toMatchObject({ publicModel: "qwen3.8-27b-rocmfp4-fast", contextWindow: { maxTokens:32768 } });
  expect(llm.description).toContain("medium");
  expect(llm.chatInput).toBeUndefined();
  expect(catalog.profileSelectors.find(s => s.id === "ornith1.5Strix-vision")?.agentProfile).toBe("ornith1.5Strix-vision");
  expect(catalog.profiles.find(p => p.id === "ornith1.5Strix-vision")!.providers.find(p => p.name === "llm")!.supportedCapabilities).toContain("llm.vision");
  expect(createOpenAiModelCatalog(catalog).models.find(m => m.id === "qwen3.8-27b-rocmfp4-fast")?.route).toBe("llm-lfm25");
});
