import { expect, test } from "bun:test";
import { imageGenerationRequestSchema } from "./image-artifact";
import { createOpenApiDocument } from "./api-contract";

test("Turbo advertised model and eight-step schedule are the public generation contract", () => {
  expect(imageGenerationRequestSchema.parse({ prompt: "A studio portrait" })).toEqual({ prompt: "A studio portrait" });
  expect(imageGenerationRequestSchema.safeParse({ prompt: "A studio portrait", model: "qwen-image-2.1-turbo", steps: 8 }).success).toBe(true);
  for (const invalid of [{ model: "qwen-image-2.1" }, { steps: 40 }, { seed: -1 }, { reference: "file:///tmp/image.png" }]) {
    expect(imageGenerationRequestSchema.safeParse({ prompt: "A studio portrait", ...invalid }).success).toBe(false);
  }
});

test("OpenAPI advertises the integer dimension range and exact output behavior", () => {
  const document = createOpenApiDocument("test") as {
    components: { schemas: { ImageGenerationRequest: { properties: Record<string, unknown> } } };
  };
  for (const axis of ["width", "height"]) {
    expect(document.components.schemas.ImageGenerationRequest.properties[axis])
      .toMatchObject({ type: "integer", minimum: 100, maximum: 1280,
        description: expect.stringContaining("exact") });
  }
});

test("image dimensions independently accept integer pixels from 100 through 1280", () => {
  for (const axis of ["width", "height"]) {
    for (const value of [100, 101, 127, 256, 512, 777, 1200, 1279, 1280]) {
      expect(imageGenerationRequestSchema.safeParse({ prompt: "A photo", [axis]: value }).success).toBe(true);
    }
    for (const value of [99, 1281, 2048, 100.5, true, "1200", null]) {
      expect(imageGenerationRequestSchema.safeParse({ prompt: "A photo", [axis]: value }).success).toBe(false);
    }
  }
  expect(imageGenerationRequestSchema.parse({ prompt: "A photo", width: 1200, height: 777 }))
    .toEqual({ prompt: "A photo", width: 1200, height: 777 });
  for (const [width, height] of [[100, 1280], [1280, 100]]) {
    expect(imageGenerationRequestSchema.safeParse({ prompt: "A photo", width, height }).success).toBe(true);
  }
});
