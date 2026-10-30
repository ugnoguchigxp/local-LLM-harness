import { z } from "zod";

export const visualPerceptionTaskSchema = z.enum([
  "detection", "referring", "count_box", "ocr", "ocr_grounding",
  "segmentation", "matting", "describe",
]);
export const visualPerceptionRequestSchema = z.object({
  model: z.string().min(1).max(128),
  image: z.string().max(5_600_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
  task: visualPerceptionTaskSchema,
  query: z.union([z.string().max(2048), z.array(z.string().min(1).max(128).refine(v => v.trim().length > 0)).min(1).max(32)]),
  maxNewTokens: z.number().int().min(16).max(512).default(256),
}).strict().superRefine((v, c) => {
  if (v.task !== "ocr" && (typeof v.query === "string" && !v.query.trim())) {
    c.addIssue({ code: "custom", path: ["query"], message: "this task requires a query" });
  }
  if (v.task !== "detection" && typeof v.query !== "string") {
    c.addIssue({ code: "custom", path: ["query"], message: "only detection accepts a category list" });
  }
});
const ms = z.number().finite().nonnegative();
export const visualPerceptionResponseSchema = z.object({
  contractVersion: z.literal("larm.visual-perception.v1"),
  model: z.string().min(1).max(128),
  modelRevision: z.string().regex(/^[a-f0-9]{40}$/),
  task: visualPerceptionTaskSchema,
  image: z.object({ width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192), orientation: z.literal("exif-normalized") }).strict(),
  response: z.string().max(65_536),
  detections: z.array(z.object({
    label: z.string().max(4096),
    box: z.tuple([ms, ms, ms, ms]),
    text: z.string().max(4096).optional(),
  }).strict()).max(128),
  masks: z.array(z.object({
    detectionIndex: z.number().int().min(0).max(127),
    encoding: z.literal("png-base64"), mode: z.enum(["binary", "alpha"]),
    width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
    data: z.string().max(5_600_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }).strict()).max(8),
  count: z.number().int().nonnegative().optional(),
  truncated: z.boolean(),
  timings: z.object({ imageDecodeMs: ms, preprocessMs: ms, generationMs: ms,
    maskMs: ms, postprocessMs: ms, totalMs: ms }).strict(),
  execution: z.union([z.object({ device: z.literal("cuda:0"), backend: z.literal("transformers"),
    dtype: z.literal("bfloat16"), decoderDtype: z.literal("float32"),
    outputTokens: z.number().int().positive(), visualTokens: z.number().int().positive() }).strict(),
    z.object({ device: z.literal("cpu"), backend: z.literal("llama.cpp"), dtype: z.literal("qad-q4_0"),
      decoderDtype: z.null().describe("No pixel/mask decoder exists in this description-only runtime; not unknown precision. Required, never omitted."),
      visualTokens: z.number().int().positive().describe("Image tokens measured by the pinned engine's MTMD preprocessing of the exact inference payload; never estimated."),
      outputTokens: z.number().int().nonnegative(), inputTokens: z.number().int().positive() }).strict()]),
}).strict().describe("larm.visual-perception.v1 schema revision 2026-10-31: execution.decoderDtype and visualTokens are required in every branch. CPU description-only execution uses decoderDtype:null for an absent pixel decoder, never unknown precision.");
export type VisualPerceptionRequest = z.infer<typeof visualPerceptionRequestSchema>;
export type VisualPerceptionResponse = z.infer<typeof visualPerceptionResponseSchema>;

export function inspectVisualPerceptionResponse(value: unknown, request: VisualPerceptionRequest):
  { ok: true; response: VisualPerceptionResponse } | { ok: false } {
  const parsed = visualPerceptionResponseSchema.safeParse(value);
  if (!parsed.success) return { ok: false };
  const r = parsed.data;
  if (r.model !== request.model || r.task !== request.task
    || (r.execution.backend === "llama.cpp" && (r.task !== "describe" || r.detections.length > 0 || r.masks.length > 0
      || r.count !== undefined || r.execution.visualTokens >= r.execution.inputTokens))
    || r.image.width * r.image.height > 4_194_304
    || r.detections.some(d => d.box[0] >= d.box[2] || d.box[1] >= d.box[3]
      || d.box[2] > r.image.width || d.box[3] > r.image.height)
    || r.masks.some(m => m.detectionIndex >= r.detections.length
      || m.width !== r.image.width || m.height !== r.image.height
      || m.mode !== (request.task === "segmentation" ? "binary" : "alpha"))
    || (r.masks.length > 0 && !["segmentation", "matting"].includes(request.task))
    || new Set(r.masks.map(m => m.detectionIndex)).size !== r.masks.length
    || (["segmentation", "matting"].includes(request.task) && !r.truncated && r.masks.length !== r.detections.length)
    || (r.count !== undefined && (request.task !== "count_box" || r.truncated || r.count !== r.detections.length))
    || r.masks.reduce((n, m) => n + m.data.length, 0) > 5_600_000) return { ok: false };
  return { ok: true, response: r };
}

// A real image request exercises the visual encoder before a claim is ready.
export function visualPerceptionProbe(model: string): VisualPerceptionRequest {
  return { model, task: "describe", query: "Describe the image briefly.", maxNewTokens: 32,
    image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAACPUlEQVR4nO3dy04jURAE0Tbi/3/ZLEpqIfEwxr4ZeeWINfLU1OmyWQzM5Xq9Hsb1Rg/w6gkAJwCcAHACwAkAJwCcAHACwAkAJwCcAHACwAkAJwCcAHACwAkAJwCcAHACwAkAJwCcAHACwAkAJwCcAHACwAkAJwDcOz3A/V0uN75gq5942ATg5tJ/+uJ6jG6Au/b++yu0SrQCPL76b1+wj6EP4Omr//riTQxl3wUt3X74T/lbNRcQXkrNKXRcAPVIFpxCAQC7BdqABqD//vgMKEDD9iduEg6gZ/sTNA8E0Lb9iZiKAOjc/hSfjf4QfvniAM2P/5SdMAvQv/0pOKdvQXBBgF0e/yk1rRcAlwLY6/GfIjN7AXACwEUAdnz/mdZP7gXACQAnANx6gH0/AKbF83sBcALACQAnAJwAcALACQAnAJwAcALArQco+Df4D7V4fi8ATgA4AeAiAPt+DKyf3AuAEwAuBbDju1BkZi8ALgiw1xGkpvUC4LIAuxxBcM74BfQbZCf0LQiOAGg+gvhs0AV0GhBTcW9BbQbQPOhnQI8BNwn9IdxggM5AAxy0Af0EFAAc3Bbo7R9Fv7RvdhH7YYKC1U8dF3CW2UvN9o+iCzhbegpNq5/6AKanM/StfmoFmM6t/Vuide9n3QBnn/fo/x8At9V+b1b2XdDrJQCcAHACwAkAJwCcAHACwAkAJwCcAHACwAkAJwCcAHACwAkAJwCcAHACwAkAJwCcAHACwAkAJwCcAHACwAkAJwDcB1GDXhPLJFSdAAAAAElFTkSuQmCC" };
}
