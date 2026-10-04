import { expect, test } from "bun:test";
import { join } from "node:path";
import { createOpenAiModelCatalog, loadAgentConnectionCatalogForRegistry, loadRegistry } from "@larm/core";
import { defaultGatewayStartupModel } from "./gateway-startup";

test("startup selects the catalog default after ContextStill replaces its legacy Qwen model", () => {
  const configDir = join(import.meta.dir, "../../../config/local-node");
  const registry = loadRegistry(configDir);
  const catalog = loadAgentConnectionCatalogForRegistry(configDir, registry);
  const models = createOpenAiModelCatalog(catalog).models.map((model) => model.id);
  expect(models).not.toContain("qwen-agent-worker");
  expect(models).toContain(defaultGatewayStartupModel(catalog));
  const updated = structuredClone(catalog);
  updated.defaultAgentProfile = "contextstill-background";
  expect(defaultGatewayStartupModel(updated)).toBe("ornith-contextstill");
  const defaultProfile = updated.profiles.find((profile) => profile.id === updated.defaultAgentProfile)!;
  defaultProfile.providers.find((provider) => provider.name === "llm")!.name = "chat";
  expect(defaultGatewayStartupModel(updated)).toBe("ornith-contextstill");
  defaultProfile.providers.find((provider) => provider.name === "chat")!.publishModel = false;
  expect(() => defaultGatewayStartupModel(updated)).toThrow("no published chat provider");
});
