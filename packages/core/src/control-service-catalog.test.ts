import { expect, test } from "bun:test";
import { join } from "node:path";
import { controlCatalogServices } from "./control-service-catalog";
import { loadAgentConnectionCatalogForRegistry } from "./agent-connection";
import { loadRegistry } from "./registry";
const config = join(import.meta.dir, "../../../config/local-node");
test("Control catalog preserves model variants, deduplicates advertisements and derives a clean caller origin", () => {
  const catalog = loadAgentConnectionCatalogForRegistry(config, loadRegistry(config));
  const services = controlCatalogServices(catalog, "https://larm.example:9443/v3/agent-profiles?profile=contextStill");
  expect(services).toHaveLength(3);
  expect(services.every((s) => new URL(s.url).origin === "https://larm.example:9443" && !new URL(s.url).search)).toBe(true);
  const image = catalog.profileSelectors.find((s) => s.id === "SAAA-w-Image")!;
  const variant = structuredClone(image.services.find((s) => s.capability === "media.mesh.generate")!);
  variant.model = "alternate-mesh-model"; image.services.push(variant);
  expect(controlCatalogServices(catalog, "http://127.0.0.1:9810").filter((s) => s.capability === variant.capability).map((s) => s.model)).toEqual(["trellis2-4b", "alternate-mesh-model"]);
  services[0]!.description = "mutated";
  expect(controlCatalogServices(catalog, "http://127.0.0.1:9810")[0]!.description).not.toBe("mutated");
});
