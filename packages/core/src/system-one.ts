import { z } from "zod";

const questionIdSchema = z.string().min(1).max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const criterionSchema = z.string().min(1).max(4_096);

export const systemOneQuestionSchema = z.object({
  type: z.enum(["choice", "score", "noul"]),
  instructions: z.string().min(1).max(16_384),
  criteria: z.union([
    z.array(criterionSchema).min(1).max(100),
    z.record(questionIdSchema, criterionSchema),
  ]).optional(),
}).strict().superRefine((question, context) => {
  if (question.type !== "noul" && question.criteria === undefined) {
    context.addIssue({ code: "custom", path: ["criteria"], message: `${question.type} requires criteria` });
  }
});

const systemOneImageSchema = z.string().max(2_800_000)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

export const systemOneRequestSchema = z.object({
  model: questionIdSchema,
  state: z.union([
    z.string().min(1).max(50_000),
    z.record(z.string(), z.unknown()),
    z.array(z.unknown()),
    z.null(),
  ]),
  adapter: z.object({ id: questionIdSchema, version: z.number().int().min(1) }).strict().optional(),
  questionSet: z.object({ id: questionIdSchema, version: z.number().int().min(1) }).strict().optional(),
  images: z.array(systemOneImageSchema).min(1).max(1).optional(),
  questions: z.record(questionIdSchema, systemOneQuestionSchema)
    .refine((questions) => Object.keys(questions).length > 0, "at least one question is required")
    .refine((questions) => Object.keys(questions).length <= 64, "at most 64 questions are allowed"),
}).strict().superRefine((request, context) => {
  if ((request.adapter || request.questionSet) && request.model !== "d1-3b-general") {
    context.addIssue({ code: "custom", message: "adapter and questionSet require the general decision model" });
  }
  if (request.adapter && !request.questionSet) {
    context.addIssue({ code: "custom", message: "adapter requires questionSet identity" });
  }
  if (request.state === null && !request.images?.length) {
    context.addIssue({ code: "custom", path: ["state"], message: "null state requires an image" });
  }
});

const probabilitySchema = z.number().finite().min(0).max(1);
const answerSchema = z.object({
  type: z.enum(["choice", "score", "noul"]),
  confidence: probabilitySchema,
  answer_confidence: probabilitySchema.optional(),
  choice: z.string().optional(),
  score: z.number().finite().optional(),
  noul: probabilitySchema.optional(),
  probabilities: z.record(z.string(), probabilitySchema).optional(),
  legend: z.record(z.string(), z.string()).optional(),
  action: z.object({ act_probability: probabilitySchema }).passthrough().optional(),
}).passthrough().superRefine((answer, context) => {
  const field = answer.type === "choice" ? "choice" : answer.type === "score" ? "score" : "noul";
  if (answer[field] === undefined) {
    context.addIssue({ code: "custom", path: [field], message: `${answer.type} answer requires ${field}` });
  }
});

export const systemOneResponseSchema = z.object({
  model: z.string().min(1).max(256),
  answers: z.record(questionIdSchema, answerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }).strict(),
  routing: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export type SystemOneRequest = z.infer<typeof systemOneRequestSchema>;
export type SystemOneResponse = z.infer<typeof systemOneResponseSchema>;

export function inspectSystemOneResponse(input: {
  value: unknown;
  request: SystemOneRequest;
}): { ok: true; response: SystemOneResponse } | { ok: false; reason: string } {
  const parsed = systemOneResponseSchema.safeParse(input.value);
  if (!parsed.success) return { ok: false, reason: "schema_mismatch" };
  if (parsed.data.model !== input.request.model) return { ok: false, reason: "model_mismatch" };
  if (input.request.model === "d1-3b-general" && !("adapter" in parsed.data)) return { ok: false, reason: "adapter_identity_missing" };
  const expected = Object.keys(input.request.questions).sort();
  const actual = Object.keys(parsed.data.answers).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    return { ok: false, reason: "answer_set_mismatch" };
  }
  for (const [id, question] of Object.entries(input.request.questions)) {
    if (parsed.data.answers[id]?.type !== question.type) {
      return { ok: false, reason: "answer_type_mismatch" };
    }
    if (input.request.model === "d1-3b-general" && question.type !== "noul") {
      const answer = parsed.data.answers[id]!;
      const labels = question.type === "score"
        ? (question.criteria as string[]).map((_, i) => String(i)) : Object.keys(question.criteria!);
      const probabilities = answer.probabilities;
      if (!probabilities || Object.keys(probabilities).sort().join("\0") !== [...labels].sort().join("\0")
        || Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 1e-4) {
        return { ok: false, reason: "answer_probabilities_mismatch" };
      }
      const best = Math.max(...Object.values(probabilities));
      if (Math.abs(answer.confidence - best) > 1e-4 || (question.type === "choice"
        && (!labels.includes(answer.choice!) || Math.abs(probabilities[answer.choice!]! - best) > 1e-4))) {
        return { ok: false, reason: "answer_choice_mismatch" };
      }
      if (question.type === "score") {
        const expected = labels.reduce((sum, label) => sum + Number(label) * probabilities[label]!, 0);
        if (Math.abs(answer.score! - expected) > 1e-4 || !answer.legend
          || labels.some((label, i) => answer.legend![label] !== (question.criteria as string[])[i])) {
          return { ok: false, reason: "answer_score_mismatch" };
        }
      }
    }
  }
  return { ok: true, response: parsed.data };
}
