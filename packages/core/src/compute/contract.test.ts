import { expect, test } from "bun:test";
import { computeCanonicalJson, computeService, parseComputeRequest } from "./index";
import { agentProfileServiceSchema } from "../agent-connection";
import { createOpenApiDocument } from "../api-contract";
import { API_OPERATIONS } from "../api-operations";
import { apiOperationPolicy } from "../api-lifecycle";

test("compute contract bounds JSON depth and uses UTF-8 code/input sizes", () => {
  let deep: unknown = 1; for (let i = 0; i < 30; i++) deep = [deep];
  expect(() => computeCanonicalJson(deep)).toThrow("structure");
  expect(() => parseComputeRequest({ code: "あ".repeat(24000) })).toThrow("byte limits");
  expect(() => parseComputeRequest({ code: "result=2", inputs: { value: Infinity } })).toThrow();
  expect(computeCanonicalJson({ b: 1, a: 2 })).toBe(computeCanonicalJson({ a: 2, b: 1 }));
});

test("compute has six governed HTTP operations and an additive service contract", () => {
  const service = computeService("https://control.example.invalid");
  expect(agentProfileServiceSchema.parse(service)).toEqual(service);
  expect("model" in service).toBe(false);
  const operations = API_OPERATIONS.filter(([, path]) => path.startsWith("/v1/compute/"));
  expect(operations).toHaveLength(6);
  for (const [, path, operation] of operations) expect(apiOperationPolicy(path, operation)).toMatchObject({ owner: "compute", authority: "api-bearer" });
  const document = createOpenApiDocument("test") as {
    paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> };
  };
  expect(document.paths["/v1/compute/jobs"]?.post).toBeDefined();
  expect(document.components.schemas.ComputeRequest).toBeDefined();
});
