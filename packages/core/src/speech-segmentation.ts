import { z } from "zod";

/** Experimental contract; not registered in the public System One gateway. */
export const SPEECH_SEGMENTATION_MODEL = "ruri-v3-30m-speech-segmentation-prototype";
const position = z.number().int().nonnegative().safe();
const identifier = z.string().min(1).max(128);
const scalarText = z.string().refine(
  (text) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text),
  "text must contain Unicode scalar values",
);
const boundedText = (max: number) => scalarText.refine((s) => Array.from(s).length <= max, "text limit exceeded");

export const speechSegmentSchema = z.object({
  start: position,
  end: position,
  text: boundedText(4096),
  language: z.enum(["ja", "en"]),
  pause: z.enum(["none", "short", "sentence"]),
}).strict().refine((s) => s.start < s.end, "empty or reversed segment");

export const speechSegmentationStateSchema = z.object({
  request_id: identifier,
  generation: position,
  input_version: position,
  offset_unit: z.literal("unicode_code_point"),
  text_start: position,
  text: boundedText(4096),
  committed: position,
  end_of_input: z.boolean(),
  context: boundedText(256),
  reading_revision: identifier,
  reading_overrides: z.array(z.object({
    start: position,
    end: position,
    language: z.enum(["ja", "en"]),
    dictionary_entry_id: identifier.optional(),
  }).strict()).max(64),
}).strict().superRefine((s, ctx) => {
  const end = s.text_start + Array.from(s.text).length;
  if (!Number.isSafeInteger(end) || s.committed < s.text_start || s.committed > end) {
    ctx.addIssue({ code: "custom", message: "committed position outside text window" });
  }
  let previous = s.committed;
  for (const override of s.reading_overrides) {
    if (override.start < previous || override.start >= override.end || override.end > end) {
      ctx.addIssue({ code: "custom", message: "reading overrides must be ordered, disjoint and inside pending text" });
    }
    previous = override.end;
  }
});

export const speechSegmentationRequestSchema = z.object({
  model: z.literal(SPEECH_SEGMENTATION_MODEL),
  state: speechSegmentationStateSchema,
  questions: z.object({ speech: z.object({
    type: z.literal("segments"),
    instructions: z.literal("読み上げ言語・確定境界・休止を判断する"),
  }).strict() }).strict(),
}).strict();

export const speechSegmentationAnswerSchema = z.object({
  type: z.literal("segments"),
  request_id: identifier,
  generation: position,
  input_version: position,
  offset_unit: z.literal("unicode_code_point"),
  segments: z.array(speechSegmentSchema).max(64),
  committed: position,
  status: z.enum(["progress", "waiting", "completed", "unresolved", "failed"]),
  reason: z.enum(["incomplete_tail", "insufficient_confidence", "input_limit", "deadline", "model_failure"]).optional(),
  retry_after_ms: z.number().int().min(1).max(1000).optional(),
}).strict();

export const speechSegmentationResponseSchema = z.object({
  model: z.literal(SPEECH_SEGMENTATION_MODEL),
  answers: z.object({ speech: speechSegmentationAnswerSchema }).strict(),
  usage: z.object({ input_tokens: position, output_tokens: z.literal(0) }).strict(),
  routing: z.object({
    encoder_revision: identifier,
    head_revision: identifier,
    calibration_revision: identifier,
    runtime_revision: identifier,
    inference_ms: z.number().finite().nonnegative(),
    queue_ms: z.number().finite().nonnegative(),
  }).strict(),
}).strict();

export type SpeechSegmentationRequest = z.infer<typeof speechSegmentationRequestSchema>;
export type SpeechSegmentationResponse = z.infer<typeof speechSegmentationResponseSchema>;
export type SpeechSegment = z.infer<typeof speechSegmentSchema>;

/** Caller supplies the current snapshot at adoption time, not at dispatch time.
 * Old versions require an explicit append-only proof at adoption time.
 * This pure check cannot replace cancellation and playback state in Eumenes. */
export function inspectSpeechSegmentationResponse(input: {
  value: unknown;
  request: SpeechSegmentationRequest;
  current: SpeechSegmentationRequest["state"];
  active: boolean;
  nowMs: number;
  deadlineMs: number;
  allowAppendOnlyVersion?: boolean;
}): { ok: true; response: SpeechSegmentationResponse } | { ok: false; reason: string } {
  const reject = (reason: string) => ({ ok: false as const, reason });
  if (!input.active) return reject("cancelled");
  if (!Number.isFinite(input.nowMs) || !Number.isFinite(input.deadlineMs)
      || input.nowMs >= input.deadlineMs) return reject("expired");
  const request = speechSegmentationRequestSchema.safeParse(input.request);
  const current = speechSegmentationStateSchema.safeParse(input.current);
  if (!request.success || !current.success) return reject("invalid_snapshot");
  const s = request.data.state;
  if (s.request_id !== current.data.request_id || s.generation !== current.data.generation) return reject("old_generation");
  if (s.input_version !== current.data.input_version) {
    if (!input.allowAppendOnlyVersion || s.input_version > current.data.input_version) return reject("old_input_version");
    // Do not compare only the accepted slice: the whole observed prefix and
    // reading policy must remain unchanged. New overrides can only follow it.
    const observedEnd = s.text_start + Array.from(s.text).length;
    const oldOverrides = current.data.reading_overrides.filter((o) => o.start < observedEnd);
    if (s.end_of_input || !current.data.text.startsWith(s.text)
        || s.text_start !== current.data.text_start || s.committed !== current.data.committed
        || s.context !== current.data.context || s.reading_revision !== current.data.reading_revision
        || JSON.stringify(s.reading_overrides) !== JSON.stringify(oldOverrides)) return reject("snapshot_mismatch");
  } else if (JSON.stringify(s) !== JSON.stringify(current.data)) {
    // Include context, reading policy and EOS: identical text alone is insufficient.
    return reject("snapshot_mismatch");
  }
  const parsed = speechSegmentationResponseSchema.safeParse(input.value);
  if (!parsed.success) return reject("schema_mismatch");
  const answer = parsed.data.answers.speech;
  if (answer.request_id !== s.request_id || answer.generation !== s.generation
      || answer.input_version !== s.input_version) return reject("response_identity_mismatch");
  const chars = Array.from(s.text);
  const end = s.text_start + chars.length;
  let next = s.committed;
  for (const segment of answer.segments) {
    if (segment.start !== next || segment.end > end) return reject("noncontiguous_segments");
    if (segment.text !== chars.slice(segment.start - s.text_start, segment.end - s.text_start).join("")) {
      return reject("source_mismatch");
    }
    for (const override of s.reading_overrides) {
      if (segment.start < override.end && segment.end > override.start && segment.language !== override.language) {
        return reject("reading_override_mismatch");
      }
    }
    next = segment.end;
  }
  if (answer.committed !== next) return reject("committed_mismatch");
  const advanced = next > s.committed;
  if (answer.status === "completed" && (!s.end_of_input || next !== end || answer.reason !== undefined)) {
    return reject("invalid_completion");
  }
  if (answer.status === "progress" && (!advanced || (s.end_of_input && next === end) || answer.reason !== undefined)) {
    return reject("invalid_progress");
  }
  if (answer.status === "waiting" && (advanced || s.end_of_input || !answer.reason || !answer.retry_after_ms)) {
    return reject("invalid_wait");
  }
  if (answer.status === "unresolved" && (!s.end_of_input || next >= end || !answer.reason)) {
    return reject("invalid_unresolved");
  }
  if (answer.status === "failed" && (advanced || !answer.reason)) return reject("invalid_failure");
  if (answer.status !== "waiting" && answer.retry_after_ms !== undefined) return reject("unexpected_retry");
  return { ok: true, response: parsed.data };
}
