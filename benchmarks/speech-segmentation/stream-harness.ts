/** Deterministic Eumenes-side simulator; no production playback code. */
import {
  inspectSpeechSegmentationResponse,
  SPEECH_SEGMENTATION_MODEL,
  type SpeechSegment,
  type SpeechSegmentationRequest,
} from "../../packages/core/src/speech-segmentation";

type Flight = { request: SpeechSegmentationRequest; deadlineMs: number };
type Audio = { segment: SpeechSegment; ready: boolean; durationMs?: number };

export class StreamHarness {
  private pending = "";
  private context = "";
  private version = 0;
  private generation = 0;
  private committed = 0;
  private eos = false;
  private active = true;
  private lastDispatch = -Infinity;
  private pendingSince = 0;
  private lastJudgedVersion = -1;
  private flight?: Flight;
  private queue: Audio[] = [];
  private playing?: Audio;
  private pauseUntil = 0;
  readonly events: { kind: string; at: number; start?: number; reason?: string }[] = [];
  status: "active" | "completed" | "failed" | "unresolved" | "cancelled" = "active";

  constructor(readonly limits: { pendingCodePoints: number; audioSegments: number; audioMs: number; holdMs: number; timeoutMs: number; stallMs?: number }
    = { pendingCodePoints: 4096, audioSegments: 16, audioMs: 30000, holdMs: 60, timeoutMs: 1000, stallMs: 5000 }) {}

  /** Only publication-authorized text may enter this method. A capacity error
   * leaves the incoming text with the upstream caller for backpressure/retry. */
  release(text: string, now: number) {
    if (!this.active || this.eos) throw new Error("stream_closed");
    if (Array.from(this.pending + text).length > this.limits.pendingCodePoints) {
      this.events.push({ kind: "backpressure", at: now, reason: "pending_limit" });
      throw new Error("pending_limit");
    }
    if (!this.pending) this.pendingSince = now;
    this.pending += text;
    this.version += 1;
  }

  finish() { this.eos = true; this.version += 1; }

  snapshot(): SpeechSegmentationRequest["state"] {
    return { request_id: "fixed-stream", generation: this.generation, input_version: this.version,
      offset_unit: "unicode_code_point", text_start: this.committed, text: this.pending,
      committed: this.committed, end_of_input: this.eos, context: this.context,
      reading_revision: "fixed-v1", reading_overrides: [] };
  }

  dispatch(now: number): Flight | undefined {
    if (!this.active || this.status !== "active" || this.flight || this.lastJudgedVersion === this.version
        || this.queue.length >= this.limits.audioSegments || this.playing && this.queue.length + 1 >= this.limits.audioSegments
        || (!this.eos && (now - this.lastDispatch < this.limits.holdMs || now - this.pendingSince < this.limits.holdMs))) return;
    if (!this.pending && !this.eos) return;
    const request: SpeechSegmentationRequest = { model: SPEECH_SEGMENTATION_MODEL, state: this.snapshot(),
      questions: { speech: { type: "segments", instructions: "読み上げ言語・確定境界・休止を判断する" } } };
    this.flight = { request, deadlineMs: now + this.limits.timeoutMs };
    this.lastDispatch = now;
    this.events.push({ kind: "judge", at: now });
    return this.flight;
  }

  adopt(flight: Flight, value: unknown, now: number): boolean {
    // Matching flight object also prevents a duplicate from clearing a newer job.
    if (this.flight !== flight) { this.events.push({ kind: "discard", at: now, reason: "old_job" }); return false; }
    this.flight = undefined;
    const inspected = inspectSpeechSegmentationResponse({ value, request: flight.request,
      current: this.snapshot(), active: this.active, nowMs: now, deadlineMs: flight.deadlineMs,
      allowAppendOnlyVersion: true });
    if (!inspected.ok) {
      this.events.push({ kind: "discard", at: now, reason: inspected.reason });
      if (inspected.reason === "expired") this.fail("deadline", now);
      else if (!["cancelled", "old_generation", "old_input_version", "snapshot_mismatch"].includes(inspected.reason)) {
        this.fail(inspected.reason, now);
      }
      return false;
    }
    const answer = inspected.response.answers.speech;
    if (answer.segments.length + this.queue.length + Number(!!this.playing) > this.limits.audioSegments) {
      this.events.push({ kind: "backpressure", at: now, reason: "audio_limit" });
      return false; // Source and committed offset are intact; retry after draining.
    }
    this.lastJudgedVersion = flight.request.state.input_version;
    for (const segment of answer.segments) {
      this.queue.push({ segment, ready: false });
      this.events.push({ kind: "synthesize", at: now, start: segment.start, reason: segment.language });
    }
    const consumed = answer.committed - this.committed;
    const chars = Array.from(this.pending);
    this.context = Array.from(this.context + chars.slice(0, consumed).join("")).slice(-256).join("");
    this.pending = chars.slice(consumed).join("");
    this.committed = answer.committed;
    if (consumed) { this.version += 1; this.pendingSince = now; }
    if (answer.status === "completed") this.status = "completed";
    if (answer.status === "unresolved") this.status = "unresolved";
    if (answer.status === "failed") this.fail(answer.reason ?? "model_failure", now);
    return true;
  }

  audioReady(start: number, generation: number, durationMs: number, now: number) {
    if (!this.active || generation !== this.generation) return;
    const audio = this.queue.find((a) => a.segment.start === start);
    if (!audio || audio.ready) return;
    const bufferedMs = this.queue.reduce((sum, a) => sum + (a.durationMs ?? 0), 0) + (this.playing?.durationMs ?? 0);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || bufferedMs + durationMs > this.limits.audioMs) {
      this.fail("audio_duration_limit", now); return;
    }
    audio.ready = true;
    audio.durationMs = durationMs;
    this.events.push({ kind: "audio_ready", at: now, start });
    this.tick(now);
  }

  audioFailed(start: number, generation: number, reason: string, now: number) {
    if (!this.active || generation !== this.generation || !this.queue.some((a) => a.segment.start === start)) return;
    this.fail(reason, now);
  }

  /** Called from actual playback completion, not estimated audio length. */
  ended(start: number, generation: number, now: number) {
    if (!this.active || generation !== this.generation || this.playing?.segment.start !== start) return;
    const pause = this.playing.segment.pause;
    this.playing = undefined;
    this.pauseUntil = now + ({ none: 0, short: 120, sentence: 300 }[pause]);
    this.events.push({ kind: "ended", at: now, start });
    this.tick(now);
  }

  tick(now: number) {
    if (this.flight && now >= this.flight.deadlineMs) this.fail("deadline", now);
    if (this.status === "active" && this.pending && now - this.pendingSince >= (this.limits.stallMs ?? 5000)) {
      this.fail("pending_stall", now);
    }
    if (!this.active || this.playing || now < this.pauseUntil) return;
    if (this.queue[0]?.ready) {
      this.playing = this.queue.shift();
      this.events.push({ kind: "play", at: now, start: this.playing!.segment.start });
    } else if (this.queue.length) this.events.push({ kind: "audio_wait", at: now });
  }

  cancel(now: number) {
    this.active = false;
    this.status = "cancelled";
    this.generation += 1;
    this.flight = undefined;
    this.queue = [];
    this.playing = undefined;
    this.events.push({ kind: "stop_and_abort_both_tts", at: now });
  }

  private fail(reason: string, now: number) {
    this.cancel(now);
    this.status = "failed";
    this.events.push({ kind: "failed", at: now, reason });
  }

  get isDrained() { return this.status === "completed" && this.queue.length === 0 && !this.playing; }
  get pendingText() { return this.pending; }
}
