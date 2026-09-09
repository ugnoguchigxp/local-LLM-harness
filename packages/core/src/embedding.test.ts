import { expect, test } from "bun:test";
import {
  embeddingRequestSchema,
  inspectEmbeddingResponse,
  type EmbeddingSpace,
} from "./embedding";

const space: EmbeddingSpace = {
  contractVersion: "larm-embedding.v1",
  workload: "embedding",
  model: {
    id: "intfloat/multilingual-e5-small",
    revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
    artifactDigest: "6".repeat(64),
  },
  dimension: 384,
  inputTypes: ["query", "passage"],
  prefixes: { query: "query: ", passage: "passage: " },
  normalization: "l2",
  tokenization: {
    kind: "sentencepiece-bpe",
    tokenizerDigest: "0".repeat(64),
    maxTokens: 512,
    truncation: "end",
    pooling: "mean",
  },
};

test("embedding input makes query/pass and normalization explicit", () => {
  const valid = {
    texts: ["hello"],
    type: "passage" as const,
    normalize: true as const,
    priority: "normal" as const,
  };
  expect(embeddingRequestSchema.parse(valid)).toEqual(valid);
  expect(embeddingRequestSchema.safeParse({ ...valid, type: undefined }).success).toBeFalse();
  expect(embeddingRequestSchema.safeParse({ ...valid, normalize: false }).success).toBeFalse();
  expect(embeddingRequestSchema.safeParse({ ...valid, model: "fallback" }).success).toBeFalse();
});

test("embedding output validation fails closed on semantic-space drift", () => {
  const request = embeddingRequestSchema.parse({
    texts: ["hello"], type: "query", normalize: true, priority: "low",
  });
  const vector = [1, ...Array.from({ length: 383 }, () => 0)];
  const response = {
    embeddings: [vector],
    dimension: 384,
    count: 1,
    type: "query",
    normalize: true,
    queueWaitMs: 0,
    encodeMs: 1,
  };
  expect(inspectEmbeddingResponse({ value: response, request, space }).ok).toBeTrue();
  expect(inspectEmbeddingResponse({
    value: { ...response, dimension: 768 }, request, space,
  })).toEqual({ ok: false, reason: "dimension_mismatch" });
  expect(inspectEmbeddingResponse({
    value: { ...response, type: "passage" }, request, space,
  })).toEqual({ ok: false, reason: "input_type_mismatch" });
  expect(inspectEmbeddingResponse({
    value: { ...response, embeddings: [[0.5, ...vector.slice(1)]] }, request, space,
  })).toEqual({ ok: false, reason: "not_l2_normalized" });
});
