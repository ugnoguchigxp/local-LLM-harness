import {
  decodeSaaaDelta,
  isLiteralLoopbackHost,
  parseStrictJsonValue,
  SAAA_LLM_STREAM_LIMITS,
  type SaaaRunStart,
  type SaaaToolResult,
} from "@larm/core";

export const NATIVE_LLM_STREAM_PROTOCOL = "larm.native-llm-stream.v1" as const;
export const NATIVE_LLM_STREAM_ENCODING = "sad1-binary-delta-v1" as const;
const NATIVE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type NativeLlmUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type NativeLlmEvent =
  | { type: "delta"; bytes: Uint8Array }
  | { type: "tool-call"; callId: string; name: string; arguments: string }
  | {
      type: "completed";
      finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "other";
      usage: NativeLlmUsage | null;
    }
  | { type: "failed"; code: string; message: string; retryable: boolean };

export interface NativeLlmStreamBackend {
  readonly runtimeId: string;
  ready(signal?: AbortSignal): Promise<boolean>;
  open(input: SaaaRunStart, signal: AbortSignal): AsyncIterable<NativeLlmEvent>;
  pause(runId: string): void;
  resume(runId: string): void;
  submitToolResult(result: SaaaToolResult): void;
  cancel(runId: string): Promise<void>;
}

export class NativeLlmBackendRegistry {
  private readonly backends = new Map<string, NativeLlmStreamBackend>();

  constructor(backends: Iterable<NativeLlmStreamBackend> = []) {
    for (const backend of backends) this.register(backend);
  }

  register(backend: NativeLlmStreamBackend): void {
    if (this.backends.has(backend.runtimeId)) {
      throw new Error(`native LLM backend ${backend.runtimeId} is already registered`);
    }
    this.backends.set(backend.runtimeId, backend);
  }

  get(runtimeId: string): NativeLlmStreamBackend | undefined {
    return this.backends.get(runtimeId);
  }

  async ready(runtimeId: string, signal?: AbortSignal): Promise<boolean> {
    return await this.backends.get(runtimeId)?.ready(signal) ?? false;
  }
}

type NativeWebSocketMessageEvent = { data: string | ArrayBuffer | Uint8Array | Blob };
type NativeWebSocketCloseEvent = { code: number; reason: string };

export type NativeWebSocketLike = {
  binaryType: string;
  readonly protocol: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: NativeWebSocketMessageEvent) => void): void;
  addEventListener(type: "error", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "close", listener: (event: NativeWebSocketCloseEvent) => void, options?: { once?: boolean }): void;
};

export type NativeWebSocketFactory = (url: string, protocol: string) => NativeWebSocketLike;

function closeNativeSocket(socket: NativeWebSocketLike, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Session ownership and queue state are still finalized by the caller.
  }
}

type Session = {
  socket: NativeWebSocketLike;
  queue: BoundedEventQueue;
  ready: Promise<void>;
  settleReady: () => void;
  rejectReady: (error: Error) => void;
  started: boolean;
  opened: boolean;
  readyReceived: boolean;
  closed: boolean;
};

type NativeProviderControl =
  | {
      type: "native.ready";
      protocol: typeof NATIVE_LLM_STREAM_PROTOCOL;
      encoding: typeof NATIVE_LLM_STREAM_ENCODING;
      maxConcurrentRuns: number;
      capabilities: {
        pauseResume: true;
        cancel: true;
        toolContinuation: true;
        usage: true;
      };
    }
  | { type: "native.tool-call"; callId: string; name: string; arguments: string }
  | {
      type: "native.completed";
      finishReason: "stop" | "length" | "tool_calls" | "content_filter" | "other";
      usage: NativeLlmUsage | null;
    }
  | { type: "native.failed"; code: string; message: string; retryable: boolean };

function parseNativeProviderControl(text: string): NativeProviderControl {
  if (Buffer.byteLength(text, "utf8") > SAAA_LLM_STREAM_LIMITS.maxServerMessageBytes) {
    throw new Error("native Provider control exceeds the message limit");
  }
  const candidate = parseStrictJsonValue(text);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("native Provider control must be an object");
  }
  const value = candidate as Record<string, unknown>;
  if (
    value.type === "native.ready"
    && Object.keys(value).length === 5
    && Object.keys(value).every((key) => [
      "type", "protocol", "encoding", "maxConcurrentRuns", "capabilities",
    ].includes(key))
    && value.protocol === NATIVE_LLM_STREAM_PROTOCOL
    && value.encoding === NATIVE_LLM_STREAM_ENCODING
    && typeof value.maxConcurrentRuns === "number"
    && Number.isInteger(value.maxConcurrentRuns)
    && value.maxConcurrentRuns >= 1
    && value.maxConcurrentRuns <= 8
    && validNativeCapabilities(value.capabilities)
  ) {
    return {
      type: "native.ready",
      protocol: NATIVE_LLM_STREAM_PROTOCOL,
      encoding: NATIVE_LLM_STREAM_ENCODING,
      maxConcurrentRuns: value.maxConcurrentRuns,
      capabilities: value.capabilities,
    };
  }
  if (
    value.type === "native.tool-call"
    && Object.keys(value).length === 4
    && Object.keys(value).every((key) => ["type", "callId", "name", "arguments"].includes(key))
    && typeof value.callId === "string"
    && typeof value.name === "string"
    && typeof value.arguments === "string"
    && value.callId.length > 0
    && value.callId.length <= 192
    && NATIVE_IDENTIFIER.test(value.callId)
    && value.name.length > 0
    && value.name.length <= 192
    && NATIVE_IDENTIFIER.test(value.name)
    && Buffer.byteLength(value.arguments, "utf8") <= 262_144
  ) {
    return { type: "native.tool-call", callId: value.callId, name: value.name, arguments: value.arguments };
  }
  if (
    value.type === "native.completed"
    && Object.keys(value).length === 3
    && Object.keys(value).every((key) => ["type", "finishReason", "usage"].includes(key))
    && ["stop", "length", "tool_calls", "content_filter", "other"].includes(String(value.finishReason))
    && (value.usage === null || validUsage(value.usage))
  ) {
    return {
      type: "native.completed",
      finishReason: value.finishReason as "stop" | "length" | "tool_calls" | "content_filter" | "other",
      usage: value.usage as NativeLlmUsage | null,
    };
  }
  if (
    value.type === "native.failed"
    && Object.keys(value).length === 4
    && Object.keys(value).every((key) => ["type", "code", "message", "retryable"].includes(key))
    && typeof value.code === "string"
    && typeof value.message === "string"
    && typeof value.retryable === "boolean"
    && value.code.length > 0
    && value.code.length <= 128
    && value.message.length > 0
    && value.message.length <= 512
  ) {
    return {
      type: "native.failed",
      code: value.code,
      message: value.message,
      retryable: value.retryable,
    };
  }
  throw new Error("native Provider control is invalid");
}

function validNativeCapabilities(value: unknown): value is {
  pauseResume: true;
  cancel: true;
  toolContinuation: true;
  usage: true;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const capabilities = value as Record<string, unknown>;
  const keys = ["pauseResume", "cancel", "toolContinuation", "usage"];
  return Object.keys(capabilities).length === keys.length
    && Object.keys(capabilities).every((key) => keys.includes(key))
    && keys.every((key) => capabilities[key] === true);
}

function validUsage(value: unknown): value is NativeLlmUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  if (
    Object.keys(usage).length !== 3
    || !Object.keys(usage).every((key) => ["promptTokens", "completionTokens", "totalTokens"].includes(key))
  ) {
    return false;
  }
  return [usage.promptTokens, usage.completionTokens, usage.totalTokens].every(
    (item) => item === null || (typeof item === "number" && Number.isSafeInteger(item) && item >= 0),
  );
}

class BoundedEventQueue implements AsyncIterable<NativeLlmEvent> {
  private readonly events: Array<{ event: NativeLlmEvent; bytes: number }> = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<NativeLlmEvent>) => void;
    reject: (error: Error) => void;
  }> = [];
  private bytes = 0;
  private ended = false;
  private failure?: Error;

  push(event: NativeLlmEvent, bytes: number): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    if (
      this.events.length >= SAAA_LLM_STREAM_LIMITS.maxUnackedEvents
      || this.bytes + bytes > SAAA_LLM_STREAM_LIMITS.maxUnackedBytes
    ) {
      const error = new Error("native Provider exceeded the bounded event buffer");
      this.fail(error);
      throw error;
    }
    this.events.push({ event, bytes });
    this.bytes += bytes;
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    this.events.length = 0;
    this.bytes = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<NativeLlmEvent> {
    return {
      next: async () => {
        const entry = this.events.shift();
        if (entry) {
          this.bytes -= entry.bytes;
          return { value: entry.event, done: false };
        }
        if (this.failure) throw this.failure;
        if (this.ended) return { value: undefined, done: true };
        return await new Promise<IteratorResult<NativeLlmEvent>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

export class NativeWebSocketLlmStreamBackend implements NativeLlmStreamBackend {
  private readonly sessions = new Map<string, Session>();
  private readonly createSocket: NativeWebSocketFactory;

  constructor(
    readonly runtimeId: string,
    private readonly options: {
      url: string;
      protocol?: string;
      connectTimeoutMs?: number;
      requiredConcurrentRuns?: number;
      createSocket?: NativeWebSocketFactory;
    },
  ) {
    this.validateUrl(options.url);
    if (options.protocol !== undefined && options.protocol !== NATIVE_LLM_STREAM_PROTOCOL) {
      throw new Error(`native Provider protocol must equal ${NATIVE_LLM_STREAM_PROTOCOL}`);
    }
    const requiredConcurrentRuns = options.requiredConcurrentRuns ?? 1;
    if (!Number.isInteger(requiredConcurrentRuns) || requiredConcurrentRuns < 1 || requiredConcurrentRuns > 8) {
      throw new Error("native Provider required concurrency must be an integer in 1..8");
    }
    const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 100 || connectTimeoutMs > 30_000) {
      throw new Error("native Provider connect timeout must be an integer in 100..30000 ms");
    }
    this.createSocket = options.createSocket ?? ((url, protocol) => {
      return new WebSocket(url, { protocols: [protocol], perMessageDeflate: false }) as unknown as NativeWebSocketLike;
    });
  }

  async ready(signal?: AbortSignal): Promise<boolean> {
    let session: Session | undefined;
    try {
      session = this.connect("__readiness__", signal);
      await this.withTimeout(session.ready, signal);
      session.closed = true;
      closeNativeSocket(session.socket, 1000, "readiness complete");
      return true;
    } catch {
      if (session) closeNativeSocket(session.socket, 1011, "readiness failed");
      return false;
    }
  }

  open(input: SaaaRunStart, signal: AbortSignal): AsyncIterable<NativeLlmEvent> {
    if (this.sessions.has(input.runId)) throw new Error(`native run ${input.runId} already exists`);
    const session = this.connect(input.runId, signal);
    this.sessions.set(input.runId, session);
    void this.withTimeout(session.ready, signal).then(() => {
      if (session.closed || signal.aborted) return;
      session.socket.send(JSON.stringify({ type: "native.run", run: input }));
      session.started = true;
    }).catch((error) => {
      session.closed = true;
      session.queue.fail(error instanceof Error ? error : new Error("native Provider connection failed"));
      closeNativeSocket(session.socket, 1011, "native Provider connection failed");
      this.sessions.delete(input.runId);
    });
    signal.addEventListener("abort", () => {
      void this.cancel(input.runId);
    }, { once: true });
    return session.queue;
  }

  pause(runId: string): void {
    this.control(runId, { type: "native.pause", runId });
  }

  resume(runId: string): void {
    this.control(runId, { type: "native.resume", runId });
  }

  submitToolResult(result: SaaaToolResult): void {
    this.control(result.runId, { type: "native.tool-result", result });
  }

  async cancel(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) return;
    if (!session.closed && session.started && session.socket.readyState === 1) {
      try {
        session.socket.send(JSON.stringify({ type: "native.cancel", runId }));
      } catch {
        // Closing the native transport below is the bounded cancellation fallback.
      }
    }
    session.closed = true;
    session.queue.close();
    closeNativeSocket(session.socket, 1000, "run cancelled");
    this.sessions.delete(runId);
  }

  private connect(runId: string, signal?: AbortSignal): Session {
    const expectedProtocol = this.options.protocol ?? NATIVE_LLM_STREAM_PROTOCOL;
    const socket = this.createSocket(this.options.url, expectedProtocol);
    socket.binaryType = "arraybuffer";
    let settleReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = resolve;
      rejectReady = reject;
    });
    const session: Session = {
      socket,
      queue: new BoundedEventQueue(),
      ready,
      settleReady,
      rejectReady,
      started: false,
      opened: false,
      readyReceived: false,
      closed: false,
    };
    socket.addEventListener("open", () => {
      if (socket.protocol !== expectedProtocol) {
        const error = new Error("native Provider did not echo the exact WebSocket subprotocol");
        session.closed = true;
        session.rejectReady(error);
        session.queue.fail(error);
        closeNativeSocket(socket, 1002, "invalid native Provider subprotocol");
        return;
      }
      session.opened = true;
    }, { once: true });
    socket.addEventListener("message", (event) => {
      if (session.closed) return;
      try {
        if (!session.opened) throw new Error("native Provider sent data before WebSocket open");
        if (typeof event.data !== "string") {
          if (!session.readyReceived) throw new Error("native Provider sent a delta before native.ready");
          if (!session.started) throw new Error("native Provider sent a delta before native.run");
          const frame = event.data instanceof Uint8Array
            ? event.data
            : event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : undefined;
          if (!frame) throw new Error("native Provider Blob messages are unsupported");
          const delta = decodeSaaaDelta(frame);
          session.queue.push({ type: "delta", bytes: delta.payload.slice() }, frame.byteLength);
          return;
        }
        const control = parseNativeProviderControl(event.data);
        if (control.type === "native.ready") {
          if (session.readyReceived) throw new Error("native Provider sent duplicate native.ready");
          if (control.maxConcurrentRuns < (this.options.requiredConcurrentRuns ?? 1)) {
            throw new Error("native Provider capacity is below the advertised run capacity");
          }
          session.readyReceived = true;
          session.settleReady();
          return;
        }
        if (!session.readyReceived) throw new Error("native Provider sent control before native.ready");
        if (!session.started) throw new Error("native Provider sent control before native.run");
        if (control.type === "native.tool-call") {
          session.queue.push({
            type: "tool-call",
            callId: control.callId,
            name: control.name,
            arguments: control.arguments,
          }, Buffer.byteLength(event.data, "utf8"));
        } else if (control.type === "native.completed") {
          session.queue.push({
            type: "completed",
            finishReason: control.finishReason,
            usage: control.usage,
          }, Buffer.byteLength(event.data, "utf8"));
          session.queue.close();
          session.closed = true;
          if (runId !== "__readiness__") this.sessions.delete(runId);
          closeNativeSocket(socket, 1000, "native run complete");
        } else {
          session.queue.push({
            type: "failed",
            code: control.code,
            message: control.message,
            retryable: control.retryable,
          }, Buffer.byteLength(event.data, "utf8"));
          session.queue.close();
          session.closed = true;
          if (runId !== "__readiness__") this.sessions.delete(runId);
          closeNativeSocket(socket, 1000, "native run failed");
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("invalid native Provider message");
        session.closed = true;
        session.rejectReady(failure);
        session.queue.fail(failure);
        closeNativeSocket(socket, 1002, "invalid native Provider message");
        if (runId !== "__readiness__") this.sessions.delete(runId);
      }
    });
    socket.addEventListener("error", () => {
      if (session.closed) return;
      const error = new Error("native Provider WebSocket failed");
      session.closed = true;
      session.rejectReady(error);
      session.queue.fail(error);
      closeNativeSocket(socket, 1011, "native Provider WebSocket failed");
      if (runId !== "__readiness__") this.sessions.delete(runId);
    }, { once: true });
    socket.addEventListener("close", (event) => {
      session.closed = true;
      const error = event.code === 1000
        ? undefined
        : new Error(`native Provider closed (${event.code})`);
      if (error) {
        session.rejectReady(error);
        session.queue.fail(error);
      } else {
        session.queue.close();
      }
      if (runId !== "__readiness__") this.sessions.delete(runId);
    }, { once: true });
    if (signal?.aborted) {
      session.closed = true;
      closeNativeSocket(socket, 1000, "aborted");
      session.rejectReady(new Error("native Provider connection aborted"));
    }
    return session;
  }

  private control(runId: string, message: unknown): void {
    const session = this.sessions.get(runId);
    if (!session || session.closed || !session.started || session.socket.readyState !== 1) {
      throw new Error(`native run ${runId} is unavailable`);
    }
    session.socket.send(JSON.stringify(message));
  }

  private async withTimeout(task: Promise<void>, signal?: AbortSignal): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("native Provider readiness timeout")), timeoutMs);
          abort = () => reject(new Error("native Provider connection aborted"));
          signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }

  private validateUrl(value: string): void {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = isLiteralLoopbackHost(hostname);
    if (
      url.username
      || url.password
      || url.search
      || url.hash
      || (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback))
    ) {
      throw new Error("native Provider URL must use WSS, or WS on literal loopback, without secrets");
    }
  }
}
