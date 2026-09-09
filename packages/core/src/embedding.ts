import { z } from "zod";

const immutableRevisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const embeddingInputTypeSchema = z.enum(["query", "passage"]);

export const embeddingSpaceSchema = z.object({
  contractVersion: z.literal("larm-embedding.v1"),
  workload: z.literal("embedding"),
  model: z.object({
    id: z.string().min(1).max(256),
    revision: immutableRevisionSchema,
    artifactDigest: sha256Schema,
  }).strict(),
  dimension: z.number().int().min(1).max(65_536),
  inputTypes: z.array(embeddingInputTypeSchema).length(2).refine(
    (items) => JSON.stringify([...new Set(items)].sort()) === JSON.stringify(["passage", "query"]),
    "inputTypes must contain passage and query exactly once",
  ),
  prefixes: z.object({
    query: z.string().min(1).max(64),
    passage: z.string().min(1).max(64),
  }).strict().refine((prefixes) => prefixes.query !== prefixes.passage, {
    message: "query and passage prefixes must differ",
  }),
  normalization: z.literal("l2"),
  tokenization: z.object({
    kind: z.string().min(1).max(128),
    tokenizerDigest: sha256Schema,
    maxTokens: z.number().int().min(1).max(1_000_000),
    truncation: z.enum(["end", "start"]),
    pooling: z.enum(["mean", "cls"]),
  }).strict(),
}).strict();

export const embeddingRequestSchema = z.object({
  texts: z.array(z.string().trim().min(1).max(1_000_000)).min(1).max(64),
  type: embeddingInputTypeSchema,
  normalize: z.literal(true),
  priority: z.enum(["high", "normal", "low"]),
}).strict();

export const embeddingResponseSchema = z.object({
  embeddings: z.array(z.array(z.number()).min(1).max(65_536)).min(1).max(64),
  dimension: z.number().int().min(1).max(65_536),
  count: z.number().int().min(1).max(64),
  type: embeddingInputTypeSchema,
  normalize: z.literal(true),
  queueWaitMs: z.number().nonnegative().finite(),
  encodeMs: z.number().nonnegative().finite(),
}).strict();

export type EmbeddingInputType = z.infer<typeof embeddingInputTypeSchema>;
export type EmbeddingSpace = z.infer<typeof embeddingSpaceSchema>;
export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;
export type EmbeddingResponse = z.infer<typeof embeddingResponseSchema>;

export type EmbeddingInspection =
  | { ok: true; response: EmbeddingResponse }
  | {
      ok: false;
      reason:
        | "invalid_response"
        | "count_mismatch"
        | "input_type_mismatch"
        | "dimension_mismatch"
        | "non_finite_value"
        | "not_l2_normalized";
    };

export function inspectEmbeddingResponse(input: {
  value: unknown;
  request: EmbeddingRequest;
  space: EmbeddingSpace;
  normTolerance?: number;
}): EmbeddingInspection {
  const parsed = embeddingResponseSchema.safeParse(input.value);
  if (!parsed.success) return { ok: false, reason: "invalid_response" };
  const response = parsed.data;
  if (
    response.count !== response.embeddings.length
    || response.count !== input.request.texts.length
  ) {
    return { ok: false, reason: "count_mismatch" };
  }
  if (response.type !== input.request.type) {
    return { ok: false, reason: "input_type_mismatch" };
  }
  if (
    response.dimension !== input.space.dimension
    || response.embeddings.some((row) => row.length !== input.space.dimension)
  ) {
    return { ok: false, reason: "dimension_mismatch" };
  }
  const tolerance = input.normTolerance ?? 0.001;
  for (const row of response.embeddings) {
    if (row.some((value) => !Number.isFinite(value))) {
      return { ok: false, reason: "non_finite_value" };
    }
    const norm = Math.sqrt(row.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > tolerance) {
      return { ok: false, reason: "not_l2_normalized" };
    }
  }
  return { ok: true, response };
}
