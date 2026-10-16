import { describe, expect, test } from "bun:test";
import { inspectSystemOneResponse, systemOneRequestSchema } from "./system-one";

describe("System One contract", () => {
  const request = systemOneRequestSchema.parse({
    model: "laya-multilingual",
    state: "返金をお願いします",
    questions: {
      intent: {
        type: "choice",
        instructions: "意図を分類する",
        criteria: { refund: "返金", other: "その他" },
      },
    },
  });

  test("accepts a typed answer for every requested question", () => {
    expect(inspectSystemOneResponse({
      request,
      value: {
        model: "laya-multilingual",
        answers: {
          intent: {
            type: "choice",
            choice: "refund",
            probabilities: { refund: 0.8, other: 0.2 },
            confidence: 0.6,
          },
        },
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    }).ok).toBe(true);
  });

  test("rejects missing answers and answer type drift", () => {
    expect(inspectSystemOneResponse({
      request,
      value: { model: "laya-multilingual", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } },
    })).toEqual({ ok: false, reason: "answer_set_mismatch" });
    expect(inspectSystemOneResponse({
      request,
      value: {
        model: "laya-multilingual",
        answers: { intent: { type: "noul", noul: 0.5, confidence: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })).toEqual({ ok: false, reason: "answer_type_mismatch" });
  });
});

test("System One accepts a bounded inline image and requires state or an image", () => {
  const request = { model: "d1-3b-game", state: null,
    images: ["data:image/png;base64,YQ=="],
    questions: { move: { type: "choice", instructions: "Choose a move", criteria: { left: "left", right: "right" } } } };
  expect(systemOneRequestSchema.parse(request).images).toEqual(request.images);
  expect(systemOneRequestSchema.safeParse({ ...request, images: undefined }).success).toBe(false);
  expect(systemOneRequestSchema.safeParse({ ...request, images: ["https://example.com/image.png"] }).success).toBe(false);
  expect(systemOneRequestSchema.safeParse({ ...request, images: [...request.images, ...request.images] }).success).toBe(false);
});
