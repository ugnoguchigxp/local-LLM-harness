import { createHash, randomUUID, type Hash } from "node:crypto";
import type { NativeLlmEvent, NativeLlmStreamBackend } from "@larm/backends";
import {
  encodeSaaaDelta,
  emptySaaaContentSha256,
  parseSaaaClientControl,
  SAAA_LLM_STREAM_CLOSE,
  SAAA_LLM_STREAM_LIMITS,
  SAAA_LLM_STREAM_PROTOCOL,
  SaaaLlmStreamProtocolError,
  serializeSaaaServerControl,
  type SaaaClientControl,
  type SaaaRunAck,
  type SaaaRunResume,
  type SaaaRunStart,
  type SaaaServerControl,
  type SaaaStreamAdvertisement,
  type SaaaToolResult,
} from "@larm/core";

export type LlmStreamSocket = {
  send(data: string | Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  ping(data?: string | Uint8Array): number;
};

export type LlmStreamAuthorization = {
  connectionScope: string;
  allocationId: string;
  providerName: string;
  capability: string;
  publicModel: string;
  runtimeId: string;
  credentialFingerprint: string;
  streaming: SaaaStreamAdvertisement;
  backend: NativeLlmStreamBackend;
  validate: () => boolean;
  lifecycleSignal?: AbortSignal;
};

export type LlmStreamConnection = {
  id: string;
  authorization: LlmStreamAuthorization;
  state: "connecting" | "ready" | "draining" | "closed";
  socket?: LlmStreamSocket;
  activeRun?: RunActor;
  lastActivityAt: number;
  awaitingPongAt?: number;
  missedPongs: number;
  counted: boolean;
};

export type LlmStreamEvent = {
  name:
    | "llm_stream_connection_opened"
    | "llm_stream_connection_closed"
    | "llm_stream_run_started"
    | "llm_stream_run_completed"
    | "llm_stream_run_failed"
    | "llm_stream_run_cancelled"
    | "llm_stream_run_resumed"
    | "llm_stream_backpressure";
  labels: Record<string, string>;
  value?: number;
};

type ReplayEvent = {
  seq: number;
  wire: string | Uint8Array;
  wireBytes: number;
  contentSha256: string;
};

type OutstandingTool = {
  seq: number;
  resultDigest?: string;
  timer: ReturnType<typeof setTimeout>;
};

const TERMINAL_REPLAY_RESERVE_BYTES = 4_096;
type WriteResult = "sent" | "backpressure" | "closed";

class ConnectionProtocolError extends Error {}

export class LlmStreamCapacityError extends Error {
  constructor(message = "advertised WebSocket connection capacity is exhausted") {
    super(message);
    this.name = "LlmStreamCapacityError";
  }
}

function wireBytes(wire: string | Uint8Array): number {
  return typeof wire === "string" ? Buffer.byteLength(wire, "utf8") : wire.byteLength;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function unicodeScalarCount(text: string): number {
  let count = 0;
  for (const _scalar of text) count += 1;
  return count;
}

function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return "native Provider failed";
  const singleLine = error.message.replace(/[\r\n\t]+/g, " ").trim();
  return singleLine.slice(0, 512) || "native Provider failed";
}

export class RunActor {
  private readonly abort = new AbortController();
  private readonly contentHash: Hash = createHash("sha256");
  private readonly replay: ReplayEvent[] = [];
  private readonly outstandingTools = new Map<string, OutstandingTool>();
  private readonly settledToolResults = new Map<string, string>();
  private readonly capacityWaiters = new Set<() => void>();
  private seq = 0;
  private ackSeq = 0;
  private ackHash = emptySaaaContentSha256();
  private unackedBytes = 0;
  private contentBytes = 0;
  private contentScalars = 0;
  private totalToolCalls = 0;
  private textStarted = false;
  private firstDeltaSent = false;
  private pendingDelta?: Uint8Array;
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private terminalSeq?: number;
  private terminalKind?: "completed" | "failed" | "cancelled";
  private detachedAt?: number;
  private retentionTimer?: ReturnType<typeof setTimeout>;
  private pausedForReplay = false;
  private pausedForSocket = false;
  private replayCursorSeq?: number;
  private providerOpened = false;
  private consuming?: Promise<void>;
  private disposed = false;
  private terminalRequested = false;
  private terminalTask?: Promise<void>;
  private runDeadlineTimer?: ReturnType<typeof setTimeout>;
  private readonly lifecycleAbort?: () => void;

  constructor(
    readonly startMessage: SaaaRunStart,
    readonly authorization: LlmStreamAuthorization,
    private connection: LlmStreamConnection | undefined,
    private readonly owner: LlmStreamServer,
  ) {
    if (authorization.lifecycleSignal) {
      this.lifecycleAbort = () => {
        void this.fail("allocation-inactive", "allocation lease is no longer active", false);
      };
      authorization.lifecycleSignal.addEventListener("abort", this.lifecycleAbort, { once: true });
    }
  }

  get runId(): string {
    return this.startMessage.runId;
  }

  get isTerminal(): boolean {
    return this.terminalSeq !== undefined;
  }

  get isDetached(): boolean {
    return this.connection === undefined;
  }

  start(): void {
    this.sendInitialControl({ type: "run.accepted", runId: this.runId, seq: 1 });
    if (this.authorization.lifecycleSignal?.aborted) {
      void this.fail("allocation-inactive", "allocation lease is no longer active", false);
      return;
    }
    if (this.startMessage.timeoutMs) {
      this.runDeadlineTimer = setTimeout(() => {
        void this.fail("provider-timeout", "run deadline exceeded", true);
      }, this.startMessage.timeoutMs);
      this.runDeadlineTimer.unref?.();
    }
    this.consuming = this.consume();
  }

  acknowledge(message: SaaaRunAck): void {
    if (message.runId !== this.runId) throw new ConnectionProtocolError("ACK run does not match active run");
    this.applyAck(message.ackSeq, message.contentSha256);
  }

  resumeOn(connection: LlmStreamConnection, message: SaaaRunResume): void {
    if (!this.isDetached) throw new ConnectionProtocolError("run is already attached");
    if (
      this.detachedAt === undefined
      || this.owner.currentTime() - this.detachedAt >= this.authorization.streaming.resumeWindowMs
    ) {
      this.expire();
      throw new ConnectionProtocolError("resume run is unavailable or expired");
    }
    if (
      message.runId !== this.runId
      || message.allocationId !== this.authorization.allocationId
      || connection.authorization.connectionScope !== this.authorization.connectionScope
      || connection.authorization.allocationId !== this.authorization.allocationId
      || connection.authorization.providerName !== this.authorization.providerName
      || connection.authorization.capability !== this.authorization.capability
      || connection.authorization.publicModel !== this.authorization.publicModel
      || connection.authorization.runtimeId !== this.authorization.runtimeId
      || !connection.authorization.validate()
    ) {
      throw new ConnectionProtocolError("resume authorization does not match the detached run");
    }
    if (message.ackSeq < this.ackSeq) {
      throw new ConnectionProtocolError("resume ACK is older than the retained cursor");
    }
    const socketWasPaused = this.pausedForSocket;
    const providerWasPaused = socketWasPaused || this.pausedForReplay;
    // Prevent applyAck from resuming the Provider before the new public socket is attached.
    this.pausedForSocket = true;
    if (message.ackSeq === this.ackSeq) {
      if (message.contentSha256 !== this.ackHash) {
        this.pausedForSocket = socketWasPaused;
        throw new ConnectionProtocolError("resume content hash does not match the retained cursor");
      }
    } else {
      try {
        this.applyAck(message.ackSeq, message.contentSha256, false);
      } catch (error) {
        this.pausedForSocket = socketWasPaused;
        throw error;
      }
    }
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.retentionTimer = undefined;
    this.detachedAt = undefined;
    this.connection = connection;
    connection.activeRun = this;
    this.pausedForSocket = false;
    this.replayCursorSeq = this.ackSeq + 1;
    const resumedWrite = this.sendUntracked({ type: "run.resumed", runId: this.runId, ackSeq: this.ackSeq });
    if (resumedWrite === "closed") return;
    if (resumedWrite === "sent") this.pumpReplay();
    this.owner.emit("llm_stream_run_resumed", this, this.replay.length);
    if (this.terminalSeq !== undefined && this.ackSeq >= this.terminalSeq) {
      this.owner.release(this);
      return;
    }
    if (!this.pausedForSocket && this.replayCursorSeq === undefined) this.wakeCapacityWaiters();
    if (providerWasPaused) this.resumeProviderIfPossible();
  }

  detach(now: number): void {
    if (this.connection) this.connection.activeRun = undefined;
    this.connection = undefined;
    this.detachedAt = now;
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.retentionTimer = setTimeout(() => this.expire(), this.authorization.streaming.resumeWindowMs);
    this.retentionTimer.unref?.();
  }

  async cancel(): Promise<void> {
    if (this.isTerminal || this.disposed) return;
    if (this.terminalRequested) return await (this.terminalTask ?? Promise.resolve());
    this.terminalRequested = true;
    this.wakeCapacityWaiters();
    this.abort.abort(new Error("run cancelled"));
    const providerCancellation = this.authorization.backend.cancel(this.runId).catch(() => undefined);
    const terminalTask = (async () => {
      await this.flushDelta();
      if (!this.isTerminal) await this.sendTerminal({
        type: "response.cancelled",
        runId: this.runId,
        seq: this.seq + 1,
        contentBytes: this.contentBytes,
        contentSha256: this.hashSnapshot(),
      }, "cancelled");
    })();
    this.terminalTask = terminalTask;
    await terminalTask;
    await Promise.race([
      providerCancellation,
      Bun.sleep(SAAA_LLM_STREAM_LIMITS.cancelTimeoutMs),
    ]);
  }

  submitToolResult(result: SaaaToolResult): void {
    if (this.isTerminal || this.disposed) return;
    if (result.runId !== this.runId) throw new ConnectionProtocolError("tool result run does not match active run");
    const digest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
    const tool = this.outstandingTools.get(result.callId);
    if (!tool) {
      const settled = this.settledToolResults.get(result.callId);
      if (settled === digest) return;
      void this.fail("tool-error", "tool result does not match an outstanding call", false);
      return;
    }
    if (tool.seq !== result.toolCallSeq) {
      void this.fail("tool-error", "tool result sequence does not match its call", false);
      return;
    }
    if (tool.resultDigest) {
      if (tool.resultDigest !== digest) void this.fail("tool-error", "conflicting duplicate tool result", false);
      return;
    }
    tool.resultDigest = digest;
    clearTimeout(tool.timer);
    try {
      this.authorization.backend.submitToolResult(result);
    } catch {
      void this.fail("tool-error", "native Provider rejected the tool result", false);
      return;
    }
    this.outstandingTools.delete(result.callId);
    this.settledToolResults.set(result.callId, digest);
  }

  onDrain(): void {
    if (!this.pausedForSocket) return;
    this.pausedForSocket = false;
    this.pumpReplay();
    if (this.pausedForSocket) return;
    this.wakeCapacityWaiters();
    this.resumeProviderIfPossible();
  }

  onSocketBackpressure(): void {
    if (this.pausedForSocket) return;
    this.pausedForSocket = true;
    if (this.providerOpened) this.pauseProvider();
  }

  async fail(
    code: "invalid-request" | "capacity" | "model-unavailable" | "provider-error" | "provider-timeout"
      | "response-too-large" | "backpressure" | "tool-error" | "tool-timeout" | "allocation-inactive"
      | "internal-error",
    message: string,
    retryable: boolean,
  ): Promise<void> {
    if (this.isTerminal || this.disposed) return;
    if (this.terminalRequested) return await (this.terminalTask ?? Promise.resolve());
    this.terminalRequested = true;
    this.wakeCapacityWaiters();
    const task = (async () => {
      await this.flushDelta();
      if (this.isTerminal || this.disposed) return;
      this.abort.abort(new Error(code));
      void this.authorization.backend.cancel(this.runId).catch(() => undefined);
      await this.sendTerminal({
        type: "response.failed",
        runId: this.runId,
        seq: this.seq + 1,
        contentBytes: this.contentBytes,
        contentSha256: this.hashSnapshot(),
        error: { code, message: message.slice(0, 512), retryable },
      }, "failed");
    })();
    this.terminalTask = task;
    await task;
  }

  expire(): void {
    if (this.disposed) return;
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.retentionTimer = undefined;
    this.disposed = true;
    this.abort.abort(new Error("resume retention expired"));
    this.wakeCapacityWaiters();
    void this.authorization.backend.cancel(this.runId).catch(() => undefined);
    this.owner.release(this);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    if (this.runDeadlineTimer) clearTimeout(this.runDeadlineTimer);
    for (const tool of this.outstandingTools.values()) clearTimeout(tool.timer);
    this.outstandingTools.clear();
    this.settledToolResults.clear();
    this.replay.length = 0;
    this.unackedBytes = 0;
    this.pendingDelta = undefined;
    this.replayCursorSeq = undefined;
    this.retentionTimer = undefined;
    this.deltaTimer = undefined;
    this.runDeadlineTimer = undefined;
    if (this.lifecycleAbort) {
      this.authorization.lifecycleSignal?.removeEventListener("abort", this.lifecycleAbort);
    }
    this.wakeCapacityWaiters();
  }

  async terminateForShutdown(): Promise<void> {
    if (!this.isTerminal && !this.disposed) {
      if (this.terminalTask) await this.terminalTask.catch(() => undefined);
      if (!this.isTerminal && !this.disposed) {
        this.terminalRequested = true;
        const task = this.sendTerminal({
          type: "response.failed",
          runId: this.runId,
          seq: this.seq + 1,
          contentBytes: this.contentBytes,
          contentSha256: this.hashSnapshot(),
          error: {
            code: "internal-error",
            message: "server shutdown deadline exceeded",
            retryable: true,
          },
        }, "failed");
        this.terminalTask = task;
        await task;
      }
    }
    this.expire();
  }

  private async consume(): Promise<void> {
    try {
      if (
        this.pausedForSocket
        || this.replay.length >= SAAA_LLM_STREAM_LIMITS.maxUnackedEvents
        || this.unackedBytes >= SAAA_LLM_STREAM_LIMITS.maxUnackedBytes
      ) {
        await this.waitForCapacity(0);
      }
      if (this.terminalRequested || this.isTerminal || this.disposed) return;
      const events = this.authorization.backend.open(this.startMessage, this.abort.signal);
      this.providerOpened = true;
      for await (const event of events) {
        if (this.terminalRequested || this.isTerminal || this.disposed) break;
        await this.consumeEvent(event);
        if (this.terminalRequested || this.isTerminal || this.disposed) break;
      }
      if (!this.isTerminal && !this.abort.signal.aborted) {
        await this.fail("provider-error", "native Provider ended without a terminal event", true);
      }
    } catch (error) {
      if (!this.isTerminal && !this.abort.signal.aborted) {
        await this.fail("provider-error", safeMessage(error), true);
      }
    }
  }

  private async consumeEvent(event: NativeLlmEvent): Promise<void> {
    if (event.type === "delta") {
      await this.queueDelta(event.bytes);
      return;
    }
    await this.flushDelta();
    if (this.terminalRequested || this.isTerminal || this.disposed) return;
    if (event.type === "tool-call") {
      if (this.textStarted) {
        await this.fail("tool-error", "tool calls must be emitted before response text", false);
        return;
      }
      if (
        this.outstandingTools.size >= SAAA_LLM_STREAM_LIMITS.maxParallelToolCalls
        || this.totalToolCalls >= this.startMessage.maxToolCalls
        || this.outstandingTools.has(event.callId)
        || this.settledToolResults.has(event.callId)
      ) {
        await this.fail("tool-error", "tool call limit exceeded", false);
        return;
      }
      const seq = this.seq + 1;
      const sent = await this.sendBoundedControl({
        type: "tool.call",
        runId: this.runId,
        seq,
        callId: event.callId,
        name: event.name,
        arguments: event.arguments,
      });
      if (!sent) return;
      const timer = setTimeout(() => {
        if (this.outstandingTools.has(event.callId)) {
          void this.fail("tool-timeout", "tool result deadline exceeded", false);
        }
      }, SAAA_LLM_STREAM_LIMITS.toolResultTimeoutMs);
      timer.unref?.();
      this.outstandingTools.set(event.callId, { seq, timer });
      this.totalToolCalls += 1;
      return;
    }
    if (event.type === "completed") {
      if (this.outstandingTools.size > 0) {
        await this.fail("tool-error", "native Provider completed with unsettled tool calls", false);
        return;
      }
      this.terminalRequested = true;
      this.wakeCapacityWaiters();
      const task = this.sendTerminal({
        type: "response.completed",
        runId: this.runId,
        seq: this.seq + 1,
        contentBytes: this.contentBytes,
        contentSha256: this.hashSnapshot(),
        finishReason: event.finishReason,
        usage: event.usage,
      }, "completed");
      this.terminalTask = task;
      await task;
      return;
    }
    await this.fail("provider-error", event.message, event.retryable);
  }

  private async queueDelta(bytes: Uint8Array): Promise<void> {
    if (this.terminalRequested || this.isTerminal || this.disposed) return;
    if (this.outstandingTools.size > 0) {
      await this.fail("tool-error", "native Provider emitted text before tool results were settled", false);
      return;
    }
    if (bytes.byteLength < 1 || bytes.byteLength > SAAA_LLM_STREAM_LIMITS.maxDeltaBytes) {
      await this.fail("provider-error", "native Provider emitted an invalid delta size", false);
      return;
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      await this.fail("provider-error", "native Provider emitted invalid UTF-8", false);
      return;
    }
    if (!this.firstDeltaSent) {
      this.firstDeltaSent = true;
      await this.emitDelta(bytes);
      return;
    }
    if (this.pendingDelta && this.pendingDelta.byteLength + bytes.byteLength > SAAA_LLM_STREAM_LIMITS.maxDeltaBytes) {
      await this.flushDelta();
    }
    this.pendingDelta = this.pendingDelta ? concatenate(this.pendingDelta, bytes) : bytes.slice();
    if (this.pendingDelta.byteLength >= SAAA_LLM_STREAM_LIMITS.deltaBatchBytes) {
      await this.flushDelta();
      return;
    }
    if (!this.deltaTimer) {
      this.deltaTimer = setTimeout(() => {
        this.deltaTimer = undefined;
        void this.flushDelta();
      }, SAAA_LLM_STREAM_LIMITS.deltaBatchMs);
    }
  }

  private async flushDelta(): Promise<void> {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    const bytes = this.pendingDelta;
    this.pendingDelta = undefined;
    if (bytes && !this.isTerminal && !this.terminalRequested) await this.emitDelta(bytes);
  }

  private async emitDelta(bytes: Uint8Array): Promise<void> {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const nextBytes = this.contentBytes + bytes.byteLength;
    const nextScalars = this.contentScalars + unicodeScalarCount(text);
    if (
      nextBytes > SAAA_LLM_STREAM_LIMITS.maxContentBytes
      || nextScalars > SAAA_LLM_STREAM_LIMITS.maxContentScalars
    ) {
      await this.fail("response-too-large", "assistant response exceeded the configured limit", false);
      return;
    }
    const seq = this.seq + 1;
    const frame = encodeSaaaDelta(seq, bytes);
    await this.waitForCapacity(frame.byteLength);
    if (this.terminalRequested || this.isTerminal || this.disposed) return;
    this.textStarted = true;
    this.contentHash.update(bytes);
    this.contentBytes = nextBytes;
    this.contentScalars = nextScalars;
    this.seq = seq;
    this.sendTracked(seq, frame);
  }

  private sendInitialControl(
    message: Extract<SaaaServerControl, { type: "run.accepted" }>,
  ): void {
    if (this.seq !== 0 || message.seq !== 1) throw new Error("run acceptance sequence ownership was violated");
    this.seq = message.seq;
    this.sendTracked(message.seq, serializeSaaaServerControl(message));
  }

  private async sendBoundedControl(
    message: Extract<SaaaServerControl, { type: "tool.call" }>,
  ): Promise<boolean> {
    const wire = serializeSaaaServerControl(message);
    await this.waitForCapacity(wireBytes(wire));
    if (this.terminalRequested || this.isTerminal || this.disposed) return false;
    if (message.seq !== this.seq + 1) throw new Error("run sequence ownership was violated");
    this.seq = message.seq;
    this.sendTracked(message.seq, wire);
    return true;
  }

  private async sendTerminal(
    message: Extract<SaaaServerControl, { type: "response.completed" | "response.failed" | "response.cancelled" }>,
    kind: "completed" | "failed" | "cancelled",
  ): Promise<void> {
    if (this.isTerminal || this.disposed) return;
    const wire = serializeSaaaServerControl(message);
    await this.waitForCapacity(wireBytes(wire), true);
    if (this.isTerminal || this.disposed) return;
    if (message.seq !== this.seq + 1) throw new Error("run terminal sequence ownership was violated");
    this.seq = message.seq;
    this.terminalSeq = message.seq;
    this.terminalKind = kind;
    if (this.runDeadlineTimer) clearTimeout(this.runDeadlineTimer);
    this.runDeadlineTimer = undefined;
    for (const tool of this.outstandingTools.values()) clearTimeout(tool.timer);
    this.sendTracked(message.seq, wire);
    this.owner.emit(
      kind === "completed"
        ? "llm_stream_run_completed"
        : kind === "cancelled"
          ? "llm_stream_run_cancelled"
          : "llm_stream_run_failed",
      this,
      this.contentBytes,
    );
  }

  private sendUntracked(message: Extract<SaaaServerControl, { type: "run.resumed" }>): WriteResult {
    return this.write(serializeSaaaServerControl(message));
  }

  private sendTracked(seq: number, wire: string | Uint8Array): void {
    const bytes = wireBytes(wire);
    const eventLimit = SAAA_LLM_STREAM_LIMITS.maxUnackedEvents + (this.isTerminal ? 1 : 0);
    const byteLimit = SAAA_LLM_STREAM_LIMITS.maxUnackedBytes
      + (this.isTerminal ? TERMINAL_REPLAY_RESERVE_BYTES : 0);
    if (
      this.replay.length >= eventLimit
      || this.unackedBytes + bytes > byteLimit
    ) {
      throw new Error("run replay bound was exceeded");
    }
    const event: ReplayEvent = {
      seq,
      wire,
      wireBytes: bytes,
      contentSha256: this.hashSnapshot(),
    };
    this.replay.push(event);
    this.unackedBytes += bytes;
    this.write(wire);
    if (
      !this.isTerminal
      && (
        this.replay.length >= SAAA_LLM_STREAM_LIMITS.maxUnackedEvents
        || this.unackedBytes >= SAAA_LLM_STREAM_LIMITS.maxUnackedBytes
      )
    ) {
      this.pauseForReplay();
    }
  }

  private write(wire: string | Uint8Array): WriteResult {
    const connection = this.connection;
    const socket = connection?.socket;
    if (!connection || !socket) return "closed";
    let result: number;
    try {
      result = socket.send(wire, false);
    } catch {
      try {
        socket.close(SAAA_LLM_STREAM_CLOSE.internal, "WebSocket send failed");
      } catch {
        // The socket is already unusable; detaching below is sufficient.
      }
      this.owner.detachConnection(connection);
      return "closed";
    }
    if (result < 0) {
      this.onSocketBackpressure();
      return "backpressure";
    } else if (result === 0) {
      this.owner.detachConnection(connection);
      return "closed";
    }
    return "sent";
  }

  private pumpReplay(): void {
    while (this.replayCursorSeq !== undefined && !this.pausedForSocket && this.connection?.socket) {
      const event = this.replay.find((candidate) => candidate.seq === this.replayCursorSeq);
      if (!event) {
        this.replayCursorSeq = undefined;
        return;
      }
      this.replayCursorSeq = event.seq + 1;
      if (this.write(event.wire) !== "sent") return;
    }
    if (!this.connection?.socket) this.replayCursorSeq = undefined;
  }

  private applyAck(ackSeq: number, contentSha256: string, releaseTerminal = true): void {
    if (ackSeq <= this.ackSeq) return;
    if (ackSeq > this.seq) throw new ConnectionProtocolError("ACK references an unsent sequence");
    const checkpoint = this.replay.find((event) => event.seq === ackSeq);
    if (!checkpoint) throw new ConnectionProtocolError("ACK skips an unavailable sequence");
    if (checkpoint.contentSha256 !== contentSha256) {
      throw new ConnectionProtocolError("ACK content hash does not match the sequence checkpoint");
    }
    this.ackSeq = ackSeq;
    this.ackHash = contentSha256;
    while (this.replay[0] && this.replay[0].seq <= ackSeq) {
      this.unackedBytes -= this.replay.shift()!.wireBytes;
    }
    if (
      this.pausedForReplay
      && this.replay.length < SAAA_LLM_STREAM_LIMITS.maxUnackedEvents
      && this.unackedBytes < SAAA_LLM_STREAM_LIMITS.maxUnackedBytes
    ) {
      this.pausedForReplay = false;
      this.wakeCapacityWaiters();
      this.resumeProviderIfPossible();
    }
    if (releaseTerminal && this.terminalSeq !== undefined && ackSeq >= this.terminalSeq) this.owner.release(this);
  }

  private pauseForReplay(): void {
    if (this.pausedForReplay) return;
    this.pausedForReplay = true;
    this.pauseProvider();
    this.owner.emit("llm_stream_backpressure", this, this.replay.length);
  }

  private async waitForCapacity(nextWireBytes: number, terminal = false): Promise<void> {
    const eventLimit = terminal
      ? SAAA_LLM_STREAM_LIMITS.maxUnackedEvents + 1
      : SAAA_LLM_STREAM_LIMITS.maxUnackedEvents;
    const byteLimit = terminal
      ? SAAA_LLM_STREAM_LIMITS.maxUnackedBytes + TERMINAL_REPLAY_RESERVE_BYTES
      : SAAA_LLM_STREAM_LIMITS.maxUnackedBytes;
    if (terminal && nextWireBytes > TERMINAL_REPLAY_RESERVE_BYTES) {
      throw new Error("run terminal exceeded its reserved replay capacity");
    }
    while (
      !this.isTerminal
      && !this.disposed
      && (terminal || !this.terminalRequested)
      && (
        (!terminal && this.pausedForSocket)
        || this.replay.length >= eventLimit
        || this.unackedBytes + nextWireBytes > byteLimit
      )
    ) {
      if (
        this.replay.length >= eventLimit
        || this.unackedBytes + nextWireBytes > byteLimit
      ) this.pauseForReplay();
      await new Promise<void>((resolve) => this.capacityWaiters.add(resolve));
    }
  }

  private pauseProvider(): void {
    try {
      this.authorization.backend.pause(this.runId);
    } catch {
      void this.fail("backpressure", "native Provider cannot propagate flow control", true);
    }
  }

  private resumeProviderIfPossible(): void {
    if (this.pausedForReplay || this.pausedForSocket || this.replayCursorSeq !== undefined || this.isTerminal) return;
    try {
      this.authorization.backend.resume(this.runId);
    } catch {
      void this.fail("backpressure", "native Provider could not resume after flow control", true);
    }
  }

  private wakeCapacityWaiters(): void {
    for (const wake of this.capacityWaiters) wake();
    this.capacityWaiters.clear();
  }

  private hashSnapshot(): string {
    return this.contentHash.copy().digest("hex");
  }

}

export class LlmStreamServer {
  private readonly runs = new Map<string, RunActor>();
  private readonly connections = new Set<LlmStreamConnection>();
  private readonly activeByRuntime = new Map<string, number>();
  private readonly connectionsByScope = new Map<string, number>();
  private readonly now: () => number;
  private readonly heartbeatTimer?: ReturnType<typeof setInterval>;
  private draining = false;

  constructor(private readonly options: {
    now?: () => number;
    random?: () => string;
    onEvent?: (event: LlmStreamEvent) => void;
    startHeartbeat?: boolean;
  } = {}) {
    this.now = options.now ?? Date.now;
    if (options.startHeartbeat !== false) {
      this.heartbeatTimer = setInterval(() => this.heartbeatSweep(), SAAA_LLM_STREAM_LIMITS.heartbeatTimeoutMs);
      this.heartbeatTimer.unref?.();
    }
  }

  createConnection(authorization: LlmStreamAuthorization): LlmStreamConnection {
    const scopeCount = this.connectionsByScope.get(authorization.connectionScope) ?? 0;
    if (scopeCount >= authorization.streaming.maxConnections) throw new LlmStreamCapacityError();
    this.connectionsByScope.set(authorization.connectionScope, scopeCount + 1);
    const now = this.now();
    return {
      id: `conn_${this.options.random?.() ?? randomUUID()}`,
      authorization,
      state: "connecting",
      lastActivityAt: now,
      missedPongs: 0,
      counted: true,
    };
  }

  open(connection: LlmStreamConnection, socket: LlmStreamSocket): void {
    if (connection.state !== "connecting") {
      try {
        socket.close(SAAA_LLM_STREAM_CLOSE.protocol, "connection was already opened");
      } catch {
        // The duplicate socket is already unusable.
      }
      return;
    }
    connection.socket = socket;
    connection.state = this.draining ? "draining" : "ready";
    connection.lastActivityAt = this.now();
    if (this.draining) {
      this.closeConnection(connection, 1001, "server draining");
      return;
    }
    if (!connection.authorization.validate()) {
      this.closeConnection(connection, SAAA_LLM_STREAM_CLOSE.policy, "connection authorization expired");
      return;
    }
    const stream = connection.authorization.streaming;
    const ready: SaaaServerControl = {
      type: "connection.ready",
      protocol: SAAA_LLM_STREAM_PROTOCOL,
      connectionId: connection.id,
      upstreamTransport: "native",
      limits: {
        maxConcurrentRuns: stream.maxConcurrentRuns,
        maxConnections: stream.maxConnections,
        maxActiveRunsPerConnection: 1,
        maxUnackedEvents: SAAA_LLM_STREAM_LIMITS.maxUnackedEvents,
        maxUnackedBytes: SAAA_LLM_STREAM_LIMITS.maxUnackedBytes,
        resumeWindowMs: stream.resumeWindowMs,
        heartbeatIntervalMs: SAAA_LLM_STREAM_LIMITS.heartbeatIntervalMs,
      },
    };
    try {
      if (socket.send(serializeSaaaServerControl(ready), false) === 0) {
        this.detachConnection(connection);
        return;
      }
    } catch {
      try {
        socket.close(SAAA_LLM_STREAM_CLOSE.internal, "WebSocket send failed");
      } catch {
        // The socket is already unusable; detaching below is sufficient.
      }
      this.detachConnection(connection);
      return;
    }
    this.connections.add(connection);
    this.options.onEvent?.({
      name: "llm_stream_connection_opened",
      labels: { runtime: connection.authorization.runtimeId },
    });
  }

  message(connection: LlmStreamConnection, message: string | Uint8Array): void {
    if (connection.state === "closed") return;
    if (!connection.authorization.validate()) {
      this.closeProtocol(connection, SAAA_LLM_STREAM_CLOSE.policy, "connection authorization expired");
      return;
    }
    connection.lastActivityAt = this.now();
    connection.awaitingPongAt = undefined;
    connection.missedPongs = 0;
    if (typeof message !== "string") {
      this.closeProtocol(connection, SAAA_LLM_STREAM_CLOSE.unsupportedData, "client binary messages are unsupported");
      return;
    }
    let control: SaaaClientControl;
    try {
      control = parseSaaaClientControl(message);
    } catch (error) {
      if (error instanceof SaaaLlmStreamProtocolError) {
        const code = error.code === "message-too-large"
          ? SAAA_LLM_STREAM_CLOSE.messageTooLarge
          : error.code === "invalid-json"
            ? SAAA_LLM_STREAM_CLOSE.invalidPayload
            : SAAA_LLM_STREAM_CLOSE.protocol;
        this.closeProtocol(connection, code, error.code);
        return;
      }
      this.closeProtocol(connection, SAAA_LLM_STREAM_CLOSE.internal, "internal protocol failure");
      return;
    }
    try {
      this.handleControl(connection, control);
    } catch (error) {
      if (error instanceof ConnectionProtocolError) {
        this.closeProtocol(connection, SAAA_LLM_STREAM_CLOSE.protocol, error.message);
      } else {
        this.closeProtocol(connection, SAAA_LLM_STREAM_CLOSE.internal, "internal session failure");
      }
    }
  }

  drain(connection: LlmStreamConnection): void {
    connection.activeRun?.onDrain();
  }

  pong(connection: LlmStreamConnection): void {
    connection.awaitingPongAt = undefined;
    connection.missedPongs = 0;
    connection.lastActivityAt = this.now();
  }

  close(connection: LlmStreamConnection): void {
    this.detachConnection(connection);
  }

  detachConnection(connection: LlmStreamConnection): void {
    if (connection.state === "closed") return;
    connection.state = "closed";
    connection.socket = undefined;
    const wasOpen = this.connections.delete(connection);
    if (connection.counted) {
      connection.counted = false;
      const scope = connection.authorization.connectionScope;
      const count = this.connectionsByScope.get(scope) ?? 0;
      if (count <= 1) this.connectionsByScope.delete(scope);
      else this.connectionsByScope.set(scope, count - 1);
    }
    connection.activeRun?.detach(this.now());
    if (wasOpen) {
      this.options.onEvent?.({
        name: "llm_stream_connection_closed",
        labels: { runtime: connection.authorization.runtimeId },
      });
    }
  }

  heartbeatSweep(): void {
    const now = this.now();
    for (const connection of this.connections) {
      if (!connection.socket || connection.state === "closed") continue;
      if (!connection.authorization.validate()) {
        this.closeConnection(connection, SAAA_LLM_STREAM_CLOSE.policy, "connection authorization expired");
        continue;
      }
      if (connection.awaitingPongAt !== undefined) {
        if (now - connection.awaitingPongAt < SAAA_LLM_STREAM_LIMITS.heartbeatTimeoutMs) continue;
        connection.awaitingPongAt = undefined;
        connection.missedPongs += 1;
        if (connection.missedPongs >= 2) {
          this.closeConnection(connection, 1001, "heartbeat timeout");
          continue;
        }
      }
      if (now - connection.lastActivityAt >= SAAA_LLM_STREAM_LIMITS.heartbeatIntervalMs) {
        let result: number;
        try {
          result = connection.socket.ping();
        } catch {
          this.closeConnection(connection, SAAA_LLM_STREAM_CLOSE.internal, "WebSocket ping failed");
          continue;
        }
        // Bun reports the empty ping payload length, so a successfully emitted ping returns zero.
        // Transport failure is surfaced by an exception; connection liveness is decided by pong timeout.
        connection.awaitingPongAt = now;
        if (result < 0) connection.activeRun?.onSocketBackpressure();
      }
    }
  }

  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const connection of this.connections) {
      connection.state = "draining";
      if (!connection.activeRun) {
        this.closeConnection(connection, 1001, "server draining");
      }
    }
  }

  async shutdown(timeoutMs: number): Promise<boolean> {
    this.beginDrain();
    const deadline = performance.now() + timeoutMs;
    while (this.runs.size > 0 && performance.now() < deadline) await Bun.sleep(10);
    const drained = this.runs.size === 0;
    if (!drained) {
      await Promise.all([...this.runs.values()].map((run) => run.terminateForShutdown()));
    }
    for (const connection of [...this.connections]) {
      this.closeConnection(connection, 1001, "server shutdown");
    }
    return drained;
  }

  release(actor: RunActor): void {
    if (this.runs.get(actor.runId) !== actor) return;
    actor.dispose();
    this.runs.delete(actor.runId);
    const runtime = actor.authorization.runtimeId;
    const active = this.activeByRuntime.get(runtime) ?? 0;
    if (active <= 1) this.activeByRuntime.delete(runtime);
    else this.activeByRuntime.set(runtime, active - 1);
    for (const connection of this.connections) {
      if (connection.activeRun !== actor) continue;
      connection.activeRun = undefined;
      if (connection.state === "draining") {
        this.closeConnection(connection, 1001, "server draining");
      }
    }
  }

  emit(name: LlmStreamEvent["name"], actor: RunActor, value?: number): void {
    this.options.onEvent?.({
      name,
      labels: { runtime: actor.authorization.runtimeId },
      ...(value === undefined ? {} : { value }),
    });
  }

  currentTime(): number {
    return this.now();
  }

  private handleControl(connection: LlmStreamConnection, message: SaaaClientControl): void {
    if (message.type === "run.start") {
      this.startRun(connection, message);
      return;
    }
    if (message.type === "run.resume") {
      this.resumeRun(connection, message);
      return;
    }
    const actor = connection.activeRun;
    if (message.type === "run.cancel") {
      if (!actor || message.runId !== actor.runId) return;
      void actor.cancel();
      return;
    }
    if (message.type === "tool.result") {
      if (!actor || message.runId !== actor.runId) {
        this.sendEphemeralFailure(
          connection,
          message.runId,
          "tool-error",
          "tool result does not match the active run",
          false,
        );
        return;
      }
      actor.submitToolResult(message);
      return;
    }
    if (!actor) throw new ConnectionProtocolError("connection has no active run");
    actor.acknowledge(message);
  }

  private startRun(connection: LlmStreamConnection, message: SaaaRunStart): void {
    if (connection.activeRun) {
      if (connection.activeRun.runId === message.runId) {
        throw new ConnectionProtocolError("run.start duplicates the active run ID");
      }
      this.sendEphemeralFailure(connection, message.runId, "capacity", "connection already owns an active run", true);
      return;
    }
    if (this.draining || connection.state !== "ready") {
      this.sendEphemeralFailure(connection, message.runId, "capacity", "server is draining", true);
      return;
    }
    if (
      message.allocationId !== connection.authorization.allocationId
      || message.model !== connection.authorization.publicModel
    ) {
      this.sendEphemeralFailure(connection, message.runId, "invalid-request", "run scope does not match allocation", false);
      return;
    }
    if (!connection.authorization.validate()) {
      this.sendEphemeralFailure(connection, message.runId, "invalid-request", "allocation is no longer active", false);
      return;
    }
    if (this.runs.has(message.runId)) {
      this.sendEphemeralFailure(connection, message.runId, "invalid-request", "run ID is already active", false);
      return;
    }
    const runtime = connection.authorization.runtimeId;
    const active = this.activeByRuntime.get(runtime) ?? 0;
    if (active >= connection.authorization.streaming.maxConcurrentRuns) {
      this.sendEphemeralFailure(connection, message.runId, "capacity", "native runtime capacity is exhausted", true);
      return;
    }
    const actor = new RunActor(message, connection.authorization, connection, this);
    connection.activeRun = actor;
    this.runs.set(message.runId, actor);
    this.activeByRuntime.set(runtime, active + 1);
    this.emit("llm_stream_run_started", actor);
    actor.start();
  }

  private resumeRun(connection: LlmStreamConnection, message: SaaaRunResume): void {
    if (connection.activeRun) throw new ConnectionProtocolError("connection already owns an active run");
    const actor = this.runs.get(message.runId);
    if (!actor) throw new ConnectionProtocolError("resume run is unavailable or expired");
    actor.resumeOn(connection, message);
  }

  private sendEphemeralFailure(
    connection: LlmStreamConnection,
    runId: string,
    code: "capacity" | "invalid-request" | "tool-error",
    message: string,
    retryable: boolean,
  ): void {
    const socket = connection.socket;
    if (!socket) return;
    const wire = serializeSaaaServerControl({
      type: "response.failed",
      runId,
      seq: 1,
      contentBytes: 0,
      contentSha256: emptySaaaContentSha256(),
      error: { code, message, retryable },
    });
    try {
      const result = socket.send(wire, false);
      if (result < 0) connection.activeRun?.onSocketBackpressure();
      else if (result === 0) this.detachConnection(connection);
    } catch {
      try {
        socket.close(SAAA_LLM_STREAM_CLOSE.internal, "WebSocket send failed");
      } catch {
        // The socket is already unusable; detaching below is sufficient.
      }
      this.detachConnection(connection);
    }
  }

  private closeProtocol(connection: LlmStreamConnection, code: number, reason: string): void {
    this.closeConnection(connection, code, reason.slice(0, 123));
  }

  private closeConnection(connection: LlmStreamConnection, code: number, reason: string): void {
    try {
      connection.socket?.close(code, reason);
    } catch {
      // Detaching local ownership is required even when the transport is already unusable.
    }
    this.detachConnection(connection);
  }
}
