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
