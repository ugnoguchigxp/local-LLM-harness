import { expect, test } from "bun:test";
import { inspectVisualPerceptionResponse, visualPerceptionProbe, visualPerceptionRequestSchema, type VisualPerceptionResponse } from "./visual-perception";
import { loadAgentConnectionCatalogForRegistry } from "./agent-connection";
import { loadRegistry } from "./registry";

const request = visualPerceptionProbe("wevisone-vl-4b");
function response(): VisualPerceptionResponse {
  return { contractVersion: "larm.visual-perception.v1", model: request.model, modelRevision: "a".repeat(40), task: request.task,
    image: { width: 128, height: 128, orientation: "exif-normalized" }, response: "red circle", detections: [{ label: "red circle", box: [32, 32, 96, 96] }], masks: [], truncated: false,
    timings: { imageDecodeMs: 1, preprocessMs: 1, generationMs: 10, maskMs: 0, postprocessMs: 1, totalMs: 13 },
    execution: { device: "cuda:0", backend: "transformers", dtype: "bfloat16", decoderDtype: "float32", outputTokens: 12, visualTokens: 16 } };
}
test("native vision request forbids remote paths, unknown fields and unbounded work", () => {
  expect(visualPerceptionRequestSchema.safeParse(request).success).toBe(true);
  for (const change of [{ image: "https://example.com/image.png" }, { image: "/tmp/x" }, { query: "" }, { maxNewTokens: 513 }, { maxNewTokens: 15 }, { stream: true }, { query: ["x"] }]) {
    expect(visualPerceptionRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  }
  expect(visualPerceptionRequestSchema.safeParse({ ...request, task: "ocr", query: "" }).success).toBe(true);
  expect(visualPerceptionRequestSchema.safeParse({ ...request, task: "detection", query: ["person", "tool"] }).success).toBe(true);
});
test("vision response rejects wrong task/model, out-of-frame boxes and inconsistent mask associations", () => {
  expect(inspectVisualPerceptionResponse(response(), request).ok).toBe(true);
  expect(inspectVisualPerceptionResponse({}, request).ok).toBe(false);
  for (const change of [{ model: "other" }, { task: "matting" }, { image: { ...response().image, width: 8192, height: 8192 } },
    { detections: [{ label: "x", box: [1, 1, 129, 20] }] }, { detections: [{ label: "x", box: [4, 4, 3, 3] }] },
    { masks: [{ detectionIndex: 1, encoding: "png-base64", mode: "binary", width: 128, height: 128, data: "YQ==" }] }]) {
    expect(inspectVisualPerceptionResponse({ ...response(), ...change }, request).ok).toBe(false);
  }
  const mask = { detectionIndex: 0, encoding: "png-base64", mode: "binary", width: 128, height: 128, data: "YQ==" };
  const dense = { ...request, task: "segmentation" as const };
  expect(inspectVisualPerceptionResponse({ ...response(), task: dense.task, masks: [mask] }, dense).ok).toBe(true);
  for (const change of [{ mode: "alpha" }, { width: 100 }, { detectionIndex: 2 }]) {
    expect(inspectVisualPerceptionResponse({ ...response(), task: dense.task, masks: [{ ...mask, ...change }] }, dense).ok).toBe(false);
  }
});
test("vision is explicit, isolated, single-request, zero-warm and user-scoped", () => {
  const directory = new URL("../../../config/local-node", import.meta.url).pathname;
  const registry = loadRegistry(directory);
  const catalog = loadAgentConnectionCatalogForRegistry(directory, registry);
  const profile = catalog.profiles.find(p => p.id === "visual-perception")!;
  expect(profile.providers.map(p => p.capability)).toEqual(["vision.perception"]);
  expect(profile.idleRelease).toMatchObject({ enabled: true, idleSeconds: 60, activityProtocols: ["larm.visual-perception.v1"] });
  expect(catalog.defaultAgentProfile).toBe("lfm2.5");
  expect(registry.routes.find(r => r.id === "vision-wevisone")?.explicitOnly).toBe(true);
  expect(registry.runtimes.find(r => r.id === "wevisone-vl-4b")).toMatchObject({
    policy: { lifecycle: "managed", warm: { minInstances: 0, idleTtlSeconds: 0 } },
    resources: { maxConcurrentAllocations: 1, maxConcurrentRequests: 1, maxQueuedRequests: 0 },
    deployment: { scope: "user", healthPort: 8094 },
  });
});
