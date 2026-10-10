import { expect, test } from "bun:test";
import { imageGenerationRequestSchema } from "./image-artifact";

test("Turbo advertised model and eight-step schedule are the public generation contract", () => {
  expect(imageGenerationRequestSchema.parse({ prompt: "A studio portrait" })).toEqual({ prompt: "A studio portrait" });
  expect(imageGenerationRequestSchema.safeParse({ prompt: "A studio portrait", model: "qwen-image-2.1-turbo", steps: 8 }).success).toBe(true);
  for (const invalid of [{ model: "qwen-image-2.1" }, { steps: 40 }, { width: 256 }, { seed: -1 }, { reference: "file:///tmp/image.png" }]) {
    expect(imageGenerationRequestSchema.safeParse({ prompt: "A studio portrait", ...invalid }).success).toBe(false);
  }
});
