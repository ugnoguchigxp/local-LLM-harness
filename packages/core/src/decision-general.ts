import { z } from "zod";
import { systemOneQuestionSchema } from "./system-one";

export const DECISION_MODEL = "d1-3b-general";
export const DECISION_REVISION = "051bcc464b01b9f92942b364d9586b0ef5912432";
export const decisionIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const decisionAdapterSchema = z.object({ id: decisionIdentifier, version: z.number().int().min(1) }).strict();
export const decisionQuestionSetSchema = z.object({
  id: decisionIdentifier,
  version: z.number().int().min(1),
  questions: z.record(decisionIdentifier, systemOneQuestionSchema).refine(q => Object.keys(q).length >= 1 && Object.keys(q).length <= 16),
}).strict();
export const decisionTrainingRequestSchema = z.object({
  model: z.literal(DECISION_MODEL),
  datasetId: decisionIdentifier,
  questionSet: decisionQuestionSetSchema,
}).strict();
export const decisionExampleSchema = z.object({
  id: decisionIdentifier,
  task: decisionIdentifier,
  split: z.enum(["train", "calibration", "eval"]),
  questionSetId: decisionIdentifier,
  questionSetVersion: z.number().int().min(1),
  questionId: decisionIdentifier,
  state: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  label: z.union([z.boolean(), z.string(), z.number().int().nonnegative()]),
}).strict();
export type DecisionExample = z.infer<typeof decisionExampleSchema>;
export type DecisionTrainingRequest = z.infer<typeof decisionTrainingRequestSchema>;
export type DecisionQuestionSet = z.infer<typeof decisionQuestionSetSchema>;

/** Sorted JSON shared with Python; Unicode is preserved, and object key order is insignificant. */
export function decisionCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(decisionCanonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${decisionCanonical(item)}`).join(",")}}`;
}

export function decisionLabels(question: DecisionQuestionSet["questions"][string]): string[] {
  if (question.type === "noul") return ["true", "false"];
  if (question.type === "score") return (question.criteria as string[]).map((_, i) => String(i));
  return Object.keys(question.criteria!);
}

export function validateDecisionQuestions(questions: DecisionQuestionSet["questions"]): boolean {
  return Object.values(questions).every(q => {
    if (q.type === "score") return Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10;
    if (q.type === "choice") return q.criteria !== undefined && !Array.isArray(q.criteria) && Object.keys(q.criteria).length >= 2 && Object.keys(q.criteria).length <= 100;
    return q.criteria === undefined || (!Array.isArray(q.criteria) && Object.keys(q.criteria).sort().join(",") === "false,true");
  });
}

export const decisionDatasetSchema = z.object({
  id: decisionIdentifier, count: z.number().int().min(2).max(2000), bytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime(), splits: z.record(z.string(), z.number().int().nonnegative()),
}).strict();
const metric = z.object({ count: z.number().int().nonnegative(), accuracy: z.number().min(0).max(1).nullable(),
  brier: z.number().nonnegative().nullable(), logLoss: z.number().nonnegative().nullable(), ece10: z.number().min(0).max(1).nullable(),
  labels: z.array(z.string()), confusionMatrix: z.array(z.array(z.number().int().nonnegative())),
}).strict();
const comparison = z.object({ base: metric, adapted: metric }).strict();
export const decisionTrainingJobSchema = z.object({
  jobId: decisionIdentifier, status: z.enum(["queued", "running", "completed", "failed"]), datasetId: decisionIdentifier,
  createdAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
  progress: z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), phase: z.string() }).strict(),
  error: z.object({ code: z.string() }).strict().optional(),
  result: z.object({ adapter: decisionAdapterSchema,
    metrics: z.record(decisionIdentifier, z.object({ type: z.enum(["noul", "choice", "score"]), eval: comparison, calibration: comparison }).strict()),
    resources: z.object({ elapsedMs: z.number(), featureMs: z.number(), fitMs: z.number(), headBytes: z.number().int() }).strict(),
  }).strict().optional(),
}).strict();
export const decisionAdapterDetailSchema = z.object({
  id: decisionIdentifier, version: z.number().int().min(1), model: z.literal(DECISION_MODEL), revision: z.literal(DECISION_REVISION),
  questionSet: z.object({ id: decisionIdentifier, version: z.number().int().min(1) }).strict(),
  createdAt: z.string().datetime(), method: z.literal("frozen-d1-log-probability-head"), questionIds: z.array(decisionIdentifier), headBytes: z.number().int().nonnegative(),
}).strict();

/** Run before the legacy shared schema so general-provider limit errors remain stable at the gateway. */
export function decisionGeneralLimitError(value: unknown): { code: string; status: 413 | 422 } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const body = value as Record<string, unknown>;
  if (body.model !== DECISION_MODEL) return;
  if (body.state !== undefined && new TextEncoder().encode(JSON.stringify(body.state)).byteLength > 50_000) return { code: "decision_state_limit", status: 413 };
  if (body.questions && typeof body.questions === "object" && !Array.isArray(body.questions)) {
    const n = Object.keys(body.questions).length;
    if (n < 1 || n > 16) return { code: "decision_question_limit", status: 422 };
  }
  if (Array.isArray(body.images)) {
    if (body.images.length > 1) return { code: "decision_image_limit", status: 413 };
    for (const image of body.images) {
      if (typeof image !== "string") continue;
      const data = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image)?.[1];
      if (data && data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) > 1024 * 1024) return { code: "decision_image_limit", status: 413 };
    }
  }
}
