import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadRegistry, RegistryError } from "../src/registry";

const repoConfig = join(import.meta.dir, "../../../config");
const fixtures = join(import.meta.dir, "../test/fixtures");

test("loads production config with resident and preferred Qwen replicas", () => {
  const registry = loadRegistry(repoConfig);
  const general = registry.runtimes.find((r) => r.id === "qwen-general");
  const worker = registry.runtimes.find((r) => r.id === "qwen-worker");

  expect(general?.policy.class).toBe("resident");
  expect(general?.capability).toContain("llm.general");
  expect(general?.backend).toBe("nssm");
  if (general?.backend === "nssm") {
    expect(general.deployment.healthPort).toBe(50053);
    expect(general.deployment.endpoint).toBe("http://127.0.0.1:50043");
  }
  expect(worker?.policy.class).toBe("preferred");
  if (worker?.backend === "nssm") {
    expect(worker.deployment.healthPort).toBe(50051);
  }
  expect(registry.nodes[0]?.id).toBe("ai395-01");
  expect(registry.profiles.some((p) => p.id === "meeting")).toBe(true);
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
