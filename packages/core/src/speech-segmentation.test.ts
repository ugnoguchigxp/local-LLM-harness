import { describe, expect, test } from "bun:test";
import {
  inspectSpeechSegmentationResponse,
  SPEECH_SEGMENTATION_MODEL,
  speechSegmentationRequestSchema,
  type SpeechSegment,
  type SpeechSegmentationRequest,
  type SpeechSegmentationResponse,
} from "./speech-segmentation";
import { systemOneRequestSchema } from "./system-one";

export function fixture(text = "設定画面で Keep me signed in を選んでください。", eos = false): SpeechSegmentationRequest {
  return { model: SPEECH_SEGMENTATION_MODEL, state: {
    request_id: "answer-1", generation: 2, input_version: 3,
    offset_unit: "unicode_code_point", text_start: 0, text, committed: 0,
    end_of_input: eos, context: "直前の文脈", reading_revision: "user-v1", reading_overrides: [],
  }, questions: { speech: { type: "segments", instructions: "読み上げ言語・確定境界・休止を判断する" } } };
}

export function response(request: SpeechSegmentationRequest, segments: SpeechSegment[], status: SpeechSegmentationResponse["answers"]["speech"]["status"] = "progress"): SpeechSegmentationResponse {
  return { model: SPEECH_SEGMENTATION_MODEL, answers: { speech: {
    type: "segments", request_id: request.state.request_id, generation: request.state.generation,
    input_version: request.state.input_version, offset_unit: "unicode_code_point", segments,
    committed: segments.at(-1)?.end ?? request.state.committed, status,
    ...(status === "waiting" ? { reason: "incomplete_tail", retry_after_ms: 60 } : {}),
    ...(status === "unresolved" ? { reason: "insufficient_confidence" } : {}),
    ...(status === "failed" ? { reason: "model_failure" } : {}),
  } }, usage: { input_tokens: 10, output_tokens: 0 }, routing: {
    encoder_revision: "encoder-v1", head_revision: "head-v1", calibration_revision: "cal-v1",
    runtime_revision: "runtime-v1", inference_ms: 3, queue_ms: 0,
  } };
}

const inspect = (request: SpeechSegmentationRequest, value: unknown,
  extra: Partial<Parameters<typeof inspectSpeechSegmentationResponse>[0]> = {}) =>
  inspectSpeechSegmentationResponse({ request, value, current: structuredClone(request.state),
    active: true, nowMs: 10, deadlineMs: 100, ...extra });

describe("experimental speech segmentation adoption contract", () => {
  test("preserves language phrases with independent pauses", () => {
    const request = fixture();
    const spans: SpeechSegment[] = [
      { start: 0, end: 6, text: "設定画面で ", language: "ja", pause: "none" },
      { start: 6, end: 24, text: "Keep me signed in ", language: "en", pause: "none" },
    ];
    expect(inspect(request, response(request, spans)).ok).toBe(true);
    // Stable public v1 remains unchanged: this proposed extension is offline.
    expect(systemOneRequestSchema.safeParse(request).success).toBe(false);
  });

  test("positions use scalar values, including emoji and combining marks", () => {
    const request = fixture("👩🏽‍💻e\u0301。", true);
    const chars = Array.from(request.state.text);
    const segment: SpeechSegment = { start: 0, end: chars.length, text: request.state.text, language: "ja", pause: "sentence" };
    expect(inspect(request, response(request, [segment], "completed")).ok).toBe(true);
    expect(inspect(request, response(request, [{ ...segment, end: request.state.text.length }], "completed")).ok).toBe(false);
    request.state.text = "\uD800";
    expect(speechSegmentationRequestSchema.safeParse(request).success).toBe(false);
  });

  test("rejects omission, duplication, reorder, rewrite and retreat", () => {
    const request = fixture("あいうえ。", true);
    const a: SpeechSegment = { start: 0, end: 2, text: "あい", language: "ja", pause: "none" };
    const b: SpeechSegment = { start: 2, end: 5, text: "うえ。", language: "ja", pause: "sentence" };
    for (const spans of [[b], [a, a, b], [b, a], [a, { ...b, start: 3 }], [a, { ...b, text: "うえ！" }]]) {
      expect(inspect(request, response(request, spans, "completed")).ok).toBe(false);
    }
    const value = response(request, [a]);
    value.answers.speech.committed = 1;
    expect(inspect(request, value).ok).toBe(false);
    request.state.committed = 2;
    expect(inspect(request, response(request, [a])).ok).toBe(false);
  });

  test("late results cannot survive cancellation, generation change or deadline", () => {
    const request = fixture();
    const value = response(request, [], "waiting");
    expect(inspect(request, value, { active: false })).toEqual({ ok: false, reason: "cancelled" });
    expect(inspect(request, value, { nowMs: 100 })).toEqual({ ok: false, reason: "expired" });
    expect(inspect(request, value, { current: { ...request.state, generation: 4 } })).toEqual({ ok: false, reason: "old_generation" });
    value.answers.speech.input_version++;
    expect(inspect(request, value).ok).toBe(false);
  });

  test("old input adoption requires a full append-only proof including reading policy", () => {
    const request = fixture("確定可能。続きを");
    const value = response(request, [{ start: 0, end: 5, text: "確定可能。", language: "ja", pause: "sentence" }]);
    const current = { ...request.state, text: request.state.text + "待ちます", input_version: 4 };
    expect(inspect(request, value, { current }).ok).toBe(false);
    expect(inspect(request, value, { current, allowAppendOnlyVersion: true }).ok).toBe(true);
    for (const changed of [
      { ...current, text: "変更可能。続きを待ちます" },
      { ...current, reading_revision: "user-v2" },
      { ...current, context: "別の文脈" },
      { ...current, committed: 5 },
      { ...current, reading_overrides: [{ start: 0, end: 4, language: "en" as const }] },
    ]) expect(inspect(request, value, { current: changed, allowAppendOnlyVersion: true }).ok).toBe(false);
    expect(inspect(request, value, { current: { ...current, input_version: 2 }, allowAppendOnlyVersion: true }).ok).toBe(false);
  });

  test("same-version mutations and incorrect explicit reading are rejected", () => {
    const request = fixture("GPUです。", true);
    request.state.reading_overrides = [{ start: 0, end: 3, language: "en", dictionary_entry_id: "gpu-en" }];
    const value = response(request, [{ start: 0, end: 6, text: request.state.text, language: "ja", pause: "sentence" }], "completed");
    expect(inspect(request, value)).toEqual({ ok: false, reason: "reading_override_mismatch" });
    value.answers.speech.segments = [
      { start: 0, end: 3, text: "GPU", language: "en", pause: "none" },
      { start: 3, end: 6, text: "です。", language: "ja", pause: "sentence" },
    ];
    expect(inspect(request, value).ok).toBe(true);
    expect(inspect(request, value, { current: { ...request.state, end_of_input: false } }).ok).toBe(false);
  });

  test("EOS cannot wait forever, empty EOS can complete, failures stay explicit", () => {
    const request = fixture("未完成", true);
    expect(inspect(request, response(request, [], "waiting")).ok).toBe(false);
    expect(inspect(request, response(request, [], "completed")).ok).toBe(false);
    expect(inspect(request, response(request, [], "unresolved")).ok).toBe(true);
    expect(inspect(request, response(request, [], "failed")).ok).toBe(true);
    const empty = fixture("", true);
    expect(inspect(empty, response(empty, [], "completed")).ok).toBe(true);
    expect(inspect(fixture(""), response(fixture(""), [], "waiting")).ok).toBe(true);
    expect(inspect(request, { ...response(request, [], "failed"), model: "wrong-model" }).ok).toBe(false);
  });

  test("window offsets remain absolute after dropping committed text", () => {
    const request = fixture("続きです。", true);
    request.state.text_start = request.state.committed = 12345;
    const value = response(request, [{ start: 12345, end: 12351, text: "続きです。", language: "ja", pause: "sentence" }], "completed");
    // Source has five code points, not six.
    expect(inspect(request, value).ok).toBe(false);
    value.answers.speech.segments[0]!.end = 12350;
    value.answers.speech.committed = 12350;
    expect(inspect(request, value).ok).toBe(true);
  });
});
