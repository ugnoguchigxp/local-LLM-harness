import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { loadRegistry } from "./registry";
import { mediaPolicySchema, validateMediaPolicyPorts } from "./media-policy";

const root = resolve(import.meta.dir, "../../../config/local-node");
test("local media workers have distinct ports from Provider services and each other", () => {
  const registry = loadRegistry(root);
  const policy = mediaPolicySchema.parse(parse(readFileSync(resolve(root, "runtime-variants.yaml"), "utf8")));
  expect(() => validateMediaPolicyPorts(policy, registry.runtimes, "local-node")).not.toThrow();
  expect(policy.variants.mesh?.healthUrl).toBe("http://127.0.0.1:8096/health");
  const old = structuredClone(policy);
  old.variants.mesh!.healthUrl = "http://localhost:8093/health";
  expect(() => validateMediaPolicyPorts(old, registry.runtimes, "local-node")).toThrow(/d1-system-one.service/);
  old.variants.mesh!.healthUrl = old.variants.music.healthUrl;
  expect(() => validateMediaPolicyPorts(old, registry.runtimes, "local-node")).toThrow(/conflicts/);
  old.variants.mesh!.healthUrl = "http://other-node.example:8093/health";
  expect(() => validateMediaPolicyPorts(old, registry.runtimes, "local-node")).not.toThrow();
  old.variants.mesh!.healthUrl = policy.variants.mesh!.healthUrl;
  old.variants["image-flux3"] = { ...old.variants.image };
  expect(() => validateMediaPolicyPorts(old, registry.runtimes, "local-node")).not.toThrow();
});
