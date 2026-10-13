import { describe, expect, test } from "bun:test";
import { StreamHarness } from "./stream-harness";
import type { SpeechSegment, SpeechSegmentationRequest, SpeechSegmentationResponse } from "../../packages/core/src/speech-segmentation";

const text = "設定画面で Keep me signed in を選んでください。";
const gold: SpeechSegment[] = [
  { start: 0, end: 6, text: "設定画面で ", language: "ja", pause: "none" },
  { start: 6, end: 24, text: "Keep me signed in ", language: "en", pause: "none" },
  { start: 24, end: 33, text: "を選んでください。", language: "ja", pause: "sentence" },
];

/** Fixed test oracle; this contains no learned language judgement. */
function answer(request: SpeechSegmentationRequest, spans?: SpeechSegment[]): SpeechSegmentationResponse {
  const s = request.state;
  const end = s.text_start + Array.from(s.text).length;
  const segments = spans ?? gold.filter((g) => g.start >= s.committed && g.end <= end - (s.end_of_input ? 0 : 2));
  const committed = segments.at(-1)?.end ?? s.committed;
  const status = s.end_of_input ? committed === end ? "completed" : "unresolved" : segments.length ? "progress" : "waiting";
  return { model: request.model, answers: { speech: { type: "segments", request_id: s.request_id,
    generation: s.generation, input_version: s.input_version, offset_unit: "unicode_code_point", segments,
    committed, status, ...(status === "waiting" ? { reason: "incomplete_tail", retry_after_ms: 60 } : {}),
    ...(status === "unresolved" ? { reason: "insufficient_confidence" } : {}) } },
    usage: { input_tokens: 10, output_tokens: 0 }, routing: { encoder_revision: "fixed-v1", head_revision: "fixed-v1",
      calibration_revision: "fixed-v1", runtime_revision: "fake-v1", inference_ms: 3, queue_ms: 0 } };
}

function groups(seed: number) {
  const chunks: string[] = [];
  const chars = Array.from(text);
  let i = 0;
  while (i < chars.length) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const size = seed % 5 + 1;
    chunks.push(chars.slice(i, i + size).join(""));
    i += size;
  }
  return chunks;
}

describe("fixed speech stream, synthesis and playback simulation", () => {
  test("split arrival preserves original text and starts synthesis before EOS", () => {
    const plans = [Array.from(text), [text.slice(0, 6), text.slice(6, 18), text.slice(18, 32), text.slice(32)],
      [text.slice(0, 32), text.slice(32)], ...Array.from({ length: 40 }, (_, i) => groups(i + 1))];
    for (const chunks of plans) {
      const stream = new StreamHarness();
      let now = 0;
      let jitterSeed = chunks.length;
      const adopted: SpeechSegment[] = [];
      for (const chunk of chunks) {
        stream.release(chunk, now);
        jitterSeed = (jitterSeed * 1664525 + 1013904223) >>> 0;
        now += 60 + jitterSeed % 240;
        const flight = stream.dispatch(now);
        if (flight) {
          const value = answer(flight.request);
          expect(stream.adopt(flight, value, now + 3)).toBe(true);
          adopted.push(...value.answers.speech.segments);
        }
        now += jitterSeed % 30;
      }
      expect(stream.events.some((e) => e.kind === "synthesize")).toBe(true);
      stream.finish();
      const flight = stream.dispatch(now)!;
      const value = answer(flight.request);
      expect(stream.adopt(flight, value, now + 3)).toBe(true);
      adopted.push(...value.answers.speech.segments);
      expect(adopted).toEqual(gold);
      expect(adopted.map((s) => s.text).join("")).toBe(text);
      expect(stream.pendingText).toBe("");
      expect(stream.status).toBe("completed");
    }
  });

  test("coalesces arrivals in flight and verifies append-only old input adoption", () => {
    const stream = new StreamHarness();
    stream.release(text.slice(0, 18), 0);
    expect(stream.dispatch(20)).toBeUndefined();
    const flight = stream.dispatch(60)!;
    for (const char of text.slice(18)) stream.release(char, 61);
    expect(stream.dispatch(100)).toBeUndefined();
    expect(stream.adopt(flight, answer(flight.request), 110)).toBe(true);
    const next = stream.dispatch(200)!;
    expect(next.request.state.text_start).toBe(6);
    expect(next.request.state.text).toBe(text.slice(6));
    expect(next.request.state.context).toBe(text.slice(0, 6));
    expect(stream.adopt(flight, answer(flight.request), 210)).toBe(false);
    expect(stream.adopt(next, answer(next.request), 211)).toBe(true);
    expect(stream.events.filter((e) => e.kind === "judge")).toHaveLength(2);
  });

  test("plays first ready prefix, keeps source order, and waits for actual completion", () => {
    const stream = new StreamHarness();
    stream.release(text, 0);
    stream.finish();
    const flight = stream.dispatch(1)!;
    expect(stream.adopt(flight, answer(flight.request), 4)).toBe(true);
    stream.audioReady(6, 0, 100, 10); // English finishes before Japanese.
    stream.audioReady(24, 0, 100, 11);
    expect(stream.events.filter((e) => e.kind === "play")).toHaveLength(0);
    stream.audioReady(0, 0, 100, 20);
    expect(stream.events.filter((e) => e.kind === "play").map((e) => e.start)).toEqual([0]);
    stream.tick(500); // Estimated duration elapsed; no ended notification yet.
    expect(stream.events.filter((e) => e.kind === "play")).toHaveLength(1);
    stream.ended(0, 0, 700);
    stream.ended(6, 0, 900);
    stream.ended(24, 0, 1100);
    expect(stream.events.filter((e) => e.kind === "play").map((e) => [e.start, e.at])).toEqual([[0, 20], [6, 700], [24, 900]]);
    expect(stream.isDrained).toBe(true);
  });

  test("waits for audio and preserves a requested pause", () => {
    const stream = new StreamHarness();
    stream.release(text, 0);
    stream.finish();
    const flight = stream.dispatch(0)!;
    const spans = structuredClone(gold);
    spans[0]!.pause = "short";
    stream.adopt(flight, answer(flight.request, spans), 3);
    stream.audioReady(0, 0, 100, 5);
    stream.ended(0, 0, 100);
    stream.audioReady(6, 0, 100, 110);
    stream.tick(219);
    expect(stream.events.filter((e) => e.kind === "play")).toHaveLength(1);
    stream.tick(220);
    stream.ended(6, 0, 320);
    expect(stream.events.some((e) => e.kind === "audio_wait")).toBe(true);
    stream.audioReady(24, 0, 100, 400);
    expect(stream.events.filter((e) => e.kind === "play").at(-1)?.at).toBe(400);
  });

  test("capacity never silently loses pending text; audio overflow is observable", () => {
    const limits = { pendingCodePoints: 10, audioSegments: 1, audioMs: 200, holdMs: 60, timeoutMs: 1000 };
    const stream = new StreamHarness(limits);
    stream.release("あいう", 0);
    expect(() => stream.release("え".repeat(8), 1)).toThrow("pending_limit");
    expect(stream.pendingText).toBe("あいう");
    const audio = new StreamHarness({ ...limits, pendingCodePoints: 4096 });
    audio.release(text, 0);
    audio.finish();
    const flight = audio.dispatch(0)!;
    expect(audio.adopt(flight, answer(flight.request), 3)).toBe(false);
    expect(audio.pendingText).toBe(text);
    expect(audio.events.at(-1)?.reason).toBe("audio_limit");
    const duration = new StreamHarness({ ...limits, pendingCodePoints: 4096, audioSegments: 16 });
    duration.release(text, 0); duration.finish();
    const job = duration.dispatch(1)!;
    duration.adopt(job, answer(job.request), 4);
    duration.audioReady(0, 0, 201, 10);
    expect(duration.status).toBe("failed");
  });

  test("cancel, timeout, duplicates and ended callbacks cannot restart playback", () => {
    for (const cancelAt of [2, 5, 15, 120]) {
      const stream = new StreamHarness();
      stream.release(text, 0); stream.finish();
      const flight = stream.dispatch(1)!;
      if (cancelAt > 3) stream.adopt(flight, answer(flight.request), 3);
      if (cancelAt > 10) stream.audioReady(0, 0, 100, 10);
      stream.cancel(cancelAt);
      const plays = stream.events.filter((e) => e.kind === "play").length;
      stream.adopt(flight, answer(flight.request), 200);
      for (const s of gold) { stream.audioReady(s.start, 0, 100, 200); stream.ended(s.start, 0, 300); }
      stream.tick(1000);
      expect(stream.events.filter((e) => e.kind === "play")).toHaveLength(plays);
      expect(stream.status).toBe("cancelled");
    }
    const timed = new StreamHarness();
    timed.release(text, 0);
    const flight = timed.dispatch(60)!;
    timed.tick(1060);
    expect(timed.status).toBe("failed");
    expect(timed.adopt(flight, answer(flight.request), 1070)).toBe(false);
  });

  test("EOS unresolved tail ends explicitly and judgement failure aborts audio", () => {
    const stream = new StreamHarness();
    stream.release("判定不能の末尾", 0); stream.finish();
    const flight = stream.dispatch(1)!;
    expect(stream.adopt(flight, answer(flight.request, []), 4)).toBe(true);
    expect(stream.status).toBe("unresolved");
    expect(stream.dispatch(1000)).toBeUndefined();
    expect(stream.pendingText).toBe("判定不能の末尾");
    const failed = new StreamHarness();
    failed.release(text, 0);
    const job = failed.dispatch(60)!;
    const value = answer(job.request, []);
    value.answers.speech.status = "failed";
    value.answers.speech.reason = "model_failure";
    delete value.answers.speech.retry_after_ms;
    expect(failed.adopt(job, value, 63)).toBe(true);
    expect(failed.status).toBe("failed");
  });

  test("malformed decisions, stalled input and TTS failures end observably", () => {
    const malformed = new StreamHarness();
    malformed.release(text, 0);
    const flight = malformed.dispatch(60)!;
    expect(malformed.adopt(flight, { unexpected: "body" }, 63)).toBe(false);
    expect(malformed.status).toBe("failed");
    expect(malformed.dispatch(100)).toBeUndefined();
    const stalled = new StreamHarness();
    stalled.release("単語途中", 0);
    const job = stalled.dispatch(60)!;
    expect(stalled.adopt(job, answer(job.request, []), 63)).toBe(true);
    stalled.tick(5000);
    expect(stalled.status).toBe("failed");
    expect(stalled.pendingText).toBe("単語途中");
    const tts = new StreamHarness();
    tts.release(text, 0); tts.finish();
    const request = tts.dispatch(1)!;
    tts.adopt(request, answer(request.request), 4);
    tts.audioFailed(0, 0, "tts_timeout", 1000);
    tts.audioReady(6, 0, 100, 2000);
    expect(tts.status).toBe("failed");
    expect(tts.events.filter((e) => e.kind === "play")).toHaveLength(0);
  });
});
