import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { NativeLlmEvent, NativeLlmStreamBackend } from "@larm/backends";
import {
  decodeSaaaDelta,
  emptySaaaContentSha256,
  SAAA_LLM_STREAM_PROTOCOL,
  type SaaaRunStart,
  type SaaaToolResult,
} from "@larm/core";
import {
  LlmStreamCapacityError,
  LlmStreamServer,
  type LlmStreamAuthorization,
  type LlmStreamSocket,
} from "./llm-stream-session";

class EventQueue implements AsyncIterable<NativeLlmEvent> {
  private events: NativeLlmEvent[] = [];
  private waits: Array<(result: IteratorResult<NativeLlmEvent>) => void> = [];
  private closed = false;

  push(event: NativeLlmEvent): void {
    const waiter = this.waits.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.events.push(event);
  }

  end(): void {
    this.closed = true;
    for (const waiter of this.waits.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<NativeLlmEvent> {
    return {
      next: async () => {
        const event = this.events.shift();
        if (event) return { value: event, done: false };
        if (this.closed) return { value: undefined, done: true };
        return await new Promise((resolve) => this.waits.push(resolve));
      },
    };
  }
}

class FakeBackend implements NativeLlmStreamBackend {
  readonly runtimeId = "qwen-general";
  readonly queue = new EventQueue();
  starts: SaaaRunStart[] = [];
  pauses: string[] = [];
  resumes: string[] = [];
  results: SaaaToolResult[] = [];
  cancels: string[] = [];
  cancelDelayMs = 0;

  async ready(): Promise<boolean> {
    return true;
  }

  open(input: SaaaRunStart): AsyncIterable<NativeLlmEvent> {
    this.starts.push(input);
    return this.queue;
  }

  pause(runId: string): void {
    this.pauses.push(runId);
  }

  resume(runId: string): void {
    this.resumes.push(runId);
  }

  submitToolResult(result: SaaaToolResult): void {
    this.results.push(result);
  }

  async cancel(runId: string): Promise<void> {
    this.cancels.push(runId);
    if (this.cancelDelayMs > 0) await Bun.sleep(this.cancelDelayMs);
    this.queue.end();
  }
}

class MultiRunBackend implements NativeLlmStreamBackend {
  readonly runtimeId = "qwen-general";
  readonly queues = new Map<string, EventQueue>();
  cancelDelayMs = 0;

  async ready(): Promise<boolean> {
    return true;
  }

  open(input: SaaaRunStart): AsyncIterable<NativeLlmEvent> {
    const queue = new EventQueue();
    this.queues.set(input.runId, queue);
    return queue;
  }

  pause(): void {}
  resume(): void {}
  submitToolResult(): void {}

  async cancel(runId: string): Promise<void> {
    if (this.cancelDelayMs > 0) await Bun.sleep(this.cancelDelayMs);
    this.queues.get(runId)?.end();
  }
}

class FakeSocket implements LlmStreamSocket {
  sent: Array<string | Uint8Array> = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  pings = 0;
  backpressured = false;

  send(data: string | Uint8Array): number {
    this.sent.push(data);
    return this.backpressured ? -1 : typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  ping(): number {
    this.pings += 1;
    return 1;
  }
}

function authorization(backend: NativeLlmStreamBackend): LlmStreamAuthorization {
  return {
    connectionScope: "aconn_1:llm",
    allocationId: "alloc_1",
    providerName: "llm",
    capability: "llm.coding",
    publicModel: "coding-default",
    runtimeId: "qwen-general",
    credentialFingerprint: "a".repeat(64),
    streaming: {
      protocol: SAAA_LLM_STREAM_PROTOCOL,
      url: "ws://127.0.0.1:9810/v1/llm/stream",
      encoding: "json-control+binary-delta-v1",
      compression: "none",
      maxConcurrentRuns: 1,
      maxConnections: 1,
      resumeWindowMs: 120_000,
      upstreamTransport: "native",
    },
    backend,
    validate: () => true,
  };
}

function start(runId = "run_1") {
  return JSON.stringify({
    type: "run.start",
    runId,
    allocationId: "alloc_1",
    model: "coding-default",
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens: 128,
    maxToolCalls: 1,
  });
}

function jsonMessages(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.filter((item): item is string => typeof item === "string")
    .map((item) => JSON.parse(item) as Record<string, unknown>);
}

describe("LlmStreamServer", () => {
  test("PWS-C12 runs accepted -> binary delta -> completed and releases only after terminal ACK", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false, random: () => "1" });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("hello") });
    backend.queue.push({
      type: "completed",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await Bun.sleep(10);

    expect(jsonMessages(socket).map((message) => message.type)).toEqual([
      "connection.ready",
      "run.accepted",
      "response.completed",
    ]);
    const binary = socket.sent.find((item): item is Uint8Array => item instanceof Uint8Array)!;
    expect(decodeSaaaDelta(binary)).toEqual({ seq: 2n, payload: new TextEncoder().encode("hello") });
    const terminal = jsonMessages(socket).at(-1)!;
    expect(terminal).not.toHaveProperty("content");
    expect(terminal.contentBytes).toBe(5);
    expect(terminal.contentSha256).toBe(createHash("sha256").update("hello").digest("hex"));

    server.message(connection, JSON.stringify({
      type: "run.ack",
      runId: "run_1",
      ackSeq: 3,
      contentSha256: terminal.contentSha256,
    }));
    server.message(connection, start("run_2"));
    expect(backend.starts.map((item) => item.runId)).toEqual(["run_1", "run_2"]);
  });

  test("accepts the production SAAA tool set and preserves Function Tool strict", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    const tools = [
      "web_search",
      "fetch_content",
      "update_conversation_voice_behavior",
    ].map((name, index) => ({
      type: "function" as const,
      function: {
        name,
        parameters: { type: "object", additionalProperties: false, properties: {} },
        strict: index !== 1,
      },
    }));
    server.open(connection, socket);
    server.message(connection, JSON.stringify({
      ...JSON.parse(start()),
      tools,
      maxToolCalls: 32,
    }));
    await Bun.sleep(0);

    expect(jsonMessages(socket).map((message) => message.type)).toEqual([
      "connection.ready",
      "run.accepted",
    ]);
    expect(backend.starts[0]?.tools).toEqual(tools);
    await server.shutdown(0);
  });

  test("PWS-C12 isolates sequence and content across eight concurrent connections", async () => {
    const backend = new MultiRunBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const auth = authorization(backend);
    auth.streaming = { ...auth.streaming, maxConcurrentRuns: 8, maxConnections: 8 };
    const fixtures = Array.from({ length: 8 }, (_, index) => {
      const connection = server.createConnection(auth);
      const socket = new FakeSocket();
      const runId = `run_parallel_${index}`;
      const payload = new TextEncoder().encode(`delta-${index}`);
      server.open(connection, socket);
      server.message(connection, start(runId));
      const queue = backend.queues.get(runId)!;
      queue.push({ type: "delta", bytes: payload });
      queue.push({ type: "completed", finishReason: "stop", usage: null });
      queue.end();
      return { connection, socket, runId, payload };
    });
    expect(() => server.createConnection(auth)).toThrow(LlmStreamCapacityError);
    await Bun.sleep(10);

    for (const fixture of fixtures) {
      const deltas = fixture.socket.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
      expect(deltas).toHaveLength(1);
      expect(decodeSaaaDelta(deltas[0]!)).toEqual({ seq: 2n, payload: fixture.payload });
      const terminal = jsonMessages(fixture.socket).at(-1)!;
      expect(terminal).toMatchObject({
        type: "response.completed",
        runId: fixture.runId,
        seq: 3,
        contentBytes: fixture.payload.byteLength,
      });
      server.message(fixture.connection, JSON.stringify({
        type: "run.ack",
        runId: fixture.runId,
        ackSeq: 3,
        contentSha256: terminal.contentSha256,
      }));
    }
    server.close(fixtures[0]!.connection);
    const replacement = server.createConnection(auth);
    expect(replacement).toBeDefined();
    server.close(replacement);
    await server.shutdown(0);
  });

  test("PWS-C12 sends the first delta immediately and flushes on 5 ms, 256 bytes, or terminal", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("a") });
    await Bun.sleep(0);
    expect(socket.sent.filter((item) => item instanceof Uint8Array)).toHaveLength(1);

    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("b") });
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("c") });
    await Bun.sleep(1);
    expect(socket.sent.filter((item) => item instanceof Uint8Array)).toHaveLength(1);
    await Bun.sleep(10);
    let deltas = socket.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
    expect(new TextDecoder().decode(decodeSaaaDelta(deltas[1]!).payload)).toBe("bc");

    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("d".repeat(256)) });
    await Bun.sleep(0);
    deltas = socket.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
    expect(decodeSaaaDelta(deltas[2]!).payload.byteLength).toBe(256);

    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("e") });
    backend.queue.push({ type: "completed", finishReason: "stop", usage: null });
    backend.queue.end();
    await Bun.sleep(0);
    deltas = socket.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
    expect(new TextDecoder().decode(decodeSaaaDelta(deltas[3]!).payload)).toBe("e");
    expect(jsonMessages(socket).at(-1)).toMatchObject({ type: "response.completed", seq: 6 });
    await server.shutdown(0);
  });

  test("PWS-C13 resumes with a rotated valid credential and replays the same sequence and terminal", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false, random: () => "1" });
    const auth = authorization(backend);
    const first = server.createConnection(auth);
    const firstSocket = new FakeSocket();
    server.open(first, firstSocket);
    server.message(first, start());
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("hello") });
    backend.queue.push({
      type: "completed",
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
    await Bun.sleep(0);
    server.close(first);

    const resumed = server.createConnection({ ...auth, credentialFingerprint: "b".repeat(64) });
    const resumedSocket = new FakeSocket();
    server.open(resumed, resumedSocket);
    server.message(resumed, JSON.stringify({
      type: "run.resume",
      runId: "run_1",
      allocationId: "alloc_1",
      ackSeq: 1,
      contentSha256: emptySaaaContentSha256(),
    }));
    const replay = resumedSocket.sent.find((item): item is Uint8Array => item instanceof Uint8Array)!;
    expect(decodeSaaaDelta(replay).seq).toBe(2n);
    expect(jsonMessages(resumedSocket).map((message) => message.type)).toEqual([
      "connection.ready",
      "run.resumed",
      "response.completed",
    ]);
    expect(jsonMessages(resumedSocket).at(-1)?.seq).toBe(3);
    await server.shutdown(0);
  });

  test("PWS-C13 replays exactly sequence 8 onward after cumulative ACK 7", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const auth = authorization(backend);
    const first = server.createConnection(auth);
    const firstSocket = new FakeSocket();
    server.open(first, firstSocket);
    server.message(first, start());
    const chunks = Array.from({ length: 8 }, (_, index) =>
      new TextEncoder().encode(String(index).repeat(256)));
    for (const chunk of chunks) backend.queue.push({ type: "delta", bytes: chunk });
    backend.queue.push({ type: "completed", finishReason: "stop", usage: null });
    backend.queue.end();
    await Bun.sleep(10);
    const ackHash = createHash("sha256");
    for (const chunk of chunks.slice(0, 6)) ackHash.update(chunk);
    server.message(first, JSON.stringify({
      type: "run.ack",
      runId: "run_1",
      ackSeq: 7,
      contentSha256: ackHash.digest("hex"),
    }));
    server.close(first);

    const resumed = server.createConnection(auth);
    const resumedSocket = new FakeSocket();
    server.open(resumed, resumedSocket);
    server.message(resumed, JSON.stringify({
      type: "run.resume",
      runId: "run_1",
      allocationId: "alloc_1",
      ackSeq: 7,
      contentSha256: createHash("sha256").update(Buffer.concat(chunks.slice(0, 6))).digest("hex"),
    }));
    expect(resumedSocket.sent
      .filter((item): item is Uint8Array => item instanceof Uint8Array)
      .map((item) => decodeSaaaDelta(item).seq)).toEqual([8n, 9n]);
    expect(jsonMessages(resumedSocket).map((message) => [message.type, message.seq])).toEqual([
      ["connection.ready", undefined],
      ["run.resumed", undefined],
      ["response.completed", 10],
    ]);
    await server.shutdown(0);
  });

  test("PWS-C13 clears stale socket backpressure when a detached run resumes", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const auth = authorization(backend);
    const first = server.createConnection(auth);
    const firstSocket = new FakeSocket();
    server.open(first, firstSocket);
    server.message(first, start());
    firstSocket.backpressured = true;
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("hello") });
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("again") });
    await Bun.sleep(10);
    expect(backend.pauses).toContain("run_1");
    server.close(first);

    const resumed = server.createConnection(auth);
    const resumedSocket = new FakeSocket();
    server.open(resumed, resumedSocket);
    server.message(resumed, JSON.stringify({
      type: "run.resume",
      runId: "run_1",
      allocationId: "alloc_1",
      ackSeq: 1,
      contentSha256: emptySaaaContentSha256(),
    }));
    await Bun.sleep(10);
    expect(backend.resumes).toContain("run_1");
    expect(resumedSocket.sent
      .filter((item): item is Uint8Array => item instanceof Uint8Array)
      .map((item) => decodeSaaaDelta(item).seq)).toEqual([2n, 3n]);
    await server.shutdown(0);
  });

  test("PWS-C13 resumes replay incrementally across public socket backpressure", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const auth = authorization(backend);
    const first = server.createConnection(auth);
    const firstSocket = new FakeSocket();
    server.open(first, firstSocket);
    server.message(first, start());
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("first") });
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("second") });
    backend.queue.push({ type: "completed", finishReason: "stop", usage: null });
    backend.queue.end();
    await Bun.sleep(10);
    server.close(first);

    const resumed = server.createConnection(auth);
    const resumedSocket = new FakeSocket();
    server.open(resumed, resumedSocket);
    resumedSocket.backpressured = true;
    server.message(resumed, JSON.stringify({
      type: "run.resume",
      runId: "run_1",
      allocationId: "alloc_1",
      ackSeq: 1,
      contentSha256: emptySaaaContentSha256(),
    }));
    expect(jsonMessages(resumedSocket).map((message) => message.type)).toEqual([
      "connection.ready",
      "run.resumed",
    ]);
    expect(resumedSocket.sent.filter((item) => item instanceof Uint8Array)).toHaveLength(0);

    resumedSocket.backpressured = false;
    server.drain(resumed);
    expect(resumedSocket.sent
      .filter((item): item is Uint8Array => item instanceof Uint8Array)
      .map((item) => decodeSaaaDelta(item).seq)).toEqual([2n, 3n]);
    expect(jsonMessages(resumedSocket).at(-1)).toMatchObject({ type: "response.completed", seq: 4 });
    await server.shutdown(0);
  });

  test("PWS-C13 releases a detached terminal acknowledged by run.resume", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const auth = authorization(backend);
    const first = server.createConnection(auth);
    const firstSocket = new FakeSocket();
    server.open(first, firstSocket);
    server.message(first, start());
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("hello") });
    backend.queue.push({ type: "completed", finishReason: "stop", usage: null });
    await Bun.sleep(0);
    const terminal = jsonMessages(firstSocket).at(-1)!;
    server.close(first);

    const resumed = server.createConnection(auth);
    const resumedSocket = new FakeSocket();
    server.open(resumed, resumedSocket);
    server.message(resumed, JSON.stringify({
      type: "run.resume",
      runId: "run_1",
      allocationId: "alloc_1",
      ackSeq: terminal.seq,
      contentSha256: terminal.contentSha256,
    }));
    server.message(resumed, start("run_2"));
    expect(jsonMessages(resumedSocket).some((message) => message.type === "run.resumed")).toBe(true);
    expect(backend.starts.map((item) => item.runId)).toEqual(["run_1", "run_2"]);
    await server.shutdown(0);
  });

  test("PWS-C13 rejects resume after retention expiry and releases runtime capacity", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const auth = authorization(backend);
    const first = server.createConnection(auth);
    const firstSocket = new FakeSocket();
    server.open(first, firstSocket);
    server.message(first, start());
    const actor = first.activeRun!;
    server.close(first);
    actor.expire();

    const expired = server.createConnection(auth);
    const expiredSocket = new FakeSocket();
    server.open(expired, expiredSocket);
    server.message(expired, JSON.stringify({
      type: "run.resume",
      runId: "run_1",
      allocationId: "alloc_1",
      ackSeq: 0,
      contentSha256: emptySaaaContentSha256(),
    }));
    expect(expiredSocket.closes.at(-1)?.code).toBe(1002);

    const replacement = server.createConnection(auth);
    const replacementSocket = new FakeSocket();
    server.open(replacement, replacementSocket);
    server.message(replacement, start("run_2"));
    expect(replacement.activeRun?.runId).toBe("run_2");
    await server.shutdown(0);
  });

  test("PWS-C13 enforces the resume deadline even before the timer callback runs", async () => {
    let now = 1_000;
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false, now: () => now });
    const auth = authorization(backend);
    const first = server.createConnection(auth);
    server.open(first, new FakeSocket());
    server.message(first, start());
    server.close(first);
    now += auth.streaming.resumeWindowMs;

    const resumed = server.createConnection(auth);
    const resumedSocket = new FakeSocket();
    server.open(resumed, resumedSocket);
    server.message(resumed, JSON.stringify({
      type: "run.resume",
      runId: "run_1",
      allocationId: "alloc_1",
      ackSeq: 0,
      contentSha256: emptySaaaContentSha256(),
    }));
    expect(resumedSocket.closes.at(-1)?.code).toBe(1002);

    const replacement = server.createConnection(auth);
    const replacementSocket = new FakeSocket();
    server.open(replacement, replacementSocket);
    server.message(replacement, start("run_2"));
    expect(replacement.activeRun?.runId).toBe("run_2");
    await server.shutdown(0);
  });

  test("PWS-C14 pauses at 64 unacknowledged events and resumes after a cumulative ACK", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    const chunk = new TextEncoder().encode("x".repeat(256));
    for (let index = 0; index < 64; index += 1) {
      backend.queue.push({ type: "delta", bytes: chunk });
    }
    await Bun.sleep(10);
    expect(backend.pauses).toContain("run_1");
    const beforeAck = socket.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
    expect(decodeSaaaDelta(beforeAck.at(-1)!).seq).toBe(64n);
    const hash = createHash("sha256").update(Buffer.alloc(63 * 256, "x")).digest("hex");
    server.message(connection, JSON.stringify({
      type: "run.ack",
      runId: "run_1",
      ackSeq: 64,
      contentSha256: hash,
    }));
    await Bun.sleep(10);
    expect(backend.resumes).toContain("run_1");
    const afterAck = socket.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
    expect(decodeSaaaDelta(afterAck.at(-1)!).seq).toBe(65n);
    await server.shutdown(0);
  });

  test("PWS-C14 propagates socket backpressure and waits for drain before the next delta", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    socket.backpressured = true;
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("first") });
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("second") });
    await Bun.sleep(10);
    expect(socket.sent.filter((item) => item instanceof Uint8Array)).toHaveLength(1);
    expect(backend.pauses).toContain("run_1");

    socket.backpressured = false;
    server.drain(connection);
    await Bun.sleep(10);
    expect(socket.sent.filter((item) => item instanceof Uint8Array)).toHaveLength(2);
    expect(backend.resumes).toContain("run_1");
    await server.shutdown(0);
  });

  test("PWS-C15 handles tool continuation and idempotent cancellation as run-level messages", async () => {
    const backend = new FakeBackend();
    backend.cancelDelayMs = 200;
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    backend.queue.push({ type: "tool-call", callId: "call_1", name: "lookup", arguments: "{}" });
    await Bun.sleep(0);
    server.message(connection, JSON.stringify({
      type: "tool.result",
      runId: "run_1",
      callId: "call_1",
      toolCallSeq: 2,
      status: "completed",
      content: "ok",
    }));
    expect(backend.results).toHaveLength(1);
    const cancelledAt = performance.now();
    server.message(connection, JSON.stringify({ type: "run.cancel", runId: "run_1" }));
    server.message(connection, JSON.stringify({ type: "run.cancel", runId: "run_1" }));
    await Bun.sleep(10);
    expect(jsonMessages(socket).filter((message) => message.type === "response.cancelled")).toHaveLength(1);
    expect(performance.now() - cancelledAt).toBeLessThan(50);
  });

  test("PWS-C15 treats cancellation of an absent run as an idempotent no-op", () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, JSON.stringify({ type: "run.cancel", runId: "run_absent" }));
    expect(socket.closes).toHaveLength(0);
    expect(jsonMessages(socket).map((message) => message.type)).toEqual(["connection.ready"]);
  });

  test("PWS-C15 reports a tool result for an absent run without closing the connection", () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, JSON.stringify({
      type: "tool.result",
      runId: "run_absent",
      callId: "call_absent",
      toolCallSeq: 2,
      status: "failed",
      content: "not found",
    }));
    expect(jsonMessages(socket).at(-1)).toMatchObject({
      type: "response.failed",
      runId: "run_absent",
      error: { code: "tool-error", retryable: false },
    });
    expect(socket.closes).toHaveLength(0);
  });

  test("PWS-C15 permits four parallel tool calls and rejects the fifth without closing", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    const request = JSON.parse(start()) as Record<string, unknown>;
    request.maxToolCalls = 5;
    server.message(connection, JSON.stringify(request));
    for (let index = 0; index < 5; index += 1) {
      backend.queue.push({
        type: "tool-call",
        callId: `call_${index}`,
        name: "lookup",
        arguments: "{}",
      });
    }
    await Bun.sleep(10);
    expect(jsonMessages(socket).filter((message) => message.type === "tool.call")).toHaveLength(4);
    expect(jsonMessages(socket).at(-1)).toMatchObject({
      type: "response.failed",
      error: { code: "tool-error" },
    });
    expect(socket.closes).toHaveLength(0);
    await server.shutdown(0);
  });

  test("PWS-C15 makes identical tool results idempotent and conflicting duplicates terminal", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    backend.queue.push({ type: "tool-call", callId: "call_1", name: "lookup", arguments: "{}" });
    await Bun.sleep(0);
    const result = {
      type: "tool.result",
      runId: "run_1",
      callId: "call_1",
      toolCallSeq: 2,
      status: "completed",
      content: "ok",
    };
    server.message(connection, JSON.stringify(result));
    server.message(connection, JSON.stringify(result));
    expect(backend.results).toHaveLength(1);
    server.message(connection, JSON.stringify({ ...result, content: "different" }));
    await Bun.sleep(0);
    expect(jsonMessages(socket).at(-1)).toMatchObject({
      type: "response.failed",
      error: { code: "tool-error" },
    });
    expect(socket.closes).toHaveLength(0);
    await server.shutdown(0);
  });

  test("PWS-C15 rejects Provider text while tool results are outstanding", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    const request = JSON.parse(start()) as Record<string, unknown>;
    request.maxToolCalls = 1;
    server.message(connection, JSON.stringify(request));
    backend.queue.push({ type: "tool-call", callId: "call_1", name: "lookup", arguments: "{}" });
    await Bun.sleep(0);
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("premature") });
    await Bun.sleep(0);

    expect(socket.sent.filter((wire) => wire instanceof Uint8Array)).toHaveLength(0);
    expect(jsonMessages(socket).at(-1)).toMatchObject({
      type: "response.failed",
      error: { code: "tool-error", retryable: false },
    });
    await server.shutdown(0);
  });

  test("PWS-C15 reserves replay capacity so cancel remains terminal under an ACK stall", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    for (let index = 0; index < 64; index += 1) {
      backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("x".repeat(256)) });
    }
    await Bun.sleep(10);
    const startedAt = performance.now();
    server.message(connection, JSON.stringify({ type: "run.cancel", runId: "run_1" }));
    await Bun.sleep(10);
    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(jsonMessages(socket).filter((message) => message.type === "response.cancelled")).toHaveLength(1);
    expect(socket.sent.length).toBeLessThanOrEqual(66); // ready plus at most 64 replay events and one terminal
    await server.shutdown(0);
  });

  test("PWS-C15 ignores a queued Provider terminal after cancellation starts", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    backend.queue.push({ type: "completed", finishReason: "stop", usage: null });
    server.message(connection, JSON.stringify({ type: "run.cancel", runId: "run_1" }));
    await Bun.sleep(0);
    expect(jsonMessages(socket).filter((message) => message.type === "response.cancelled")).toHaveLength(1);
    expect(jsonMessages(socket).filter((message) => message.type === "response.completed")).toHaveLength(0);
    await server.shutdown(0);
  });

  test("PWS-C15 keeps cancel p95 below 50 ms across 100 runs while Provider cancellation is slow", async () => {
    const backend = new MultiRunBackend();
    backend.cancelDelayMs = 100;
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    const samples: number[] = [];

    for (let index = 0; index < 100; index += 1) {
      const runId = `run_cancel_${index}`;
      server.message(connection, start(runId));
      const startedAt = performance.now();
      server.message(connection, JSON.stringify({ type: "run.cancel", runId }));
      let terminal: Record<string, unknown> | undefined;
      for (let poll = 0; poll < 50; poll += 1) {
        terminal = jsonMessages(socket).reverse().find((message) =>
          message.type === "response.cancelled" && message.runId === runId);
        if (terminal) break;
        await Bun.sleep(1);
      }
      if (!terminal) throw new Error(`cancel terminal missing for ${runId}`);
      samples.push(performance.now() - startedAt);
      server.message(connection, JSON.stringify({
        type: "run.ack",
        runId,
        ackSeq: terminal.seq,
        contentSha256: terminal.contentSha256,
      }));
    }

    samples.sort((left, right) => left - right);
    expect(samples[Math.ceil(samples.length * 0.95) - 1]).toBeLessThan(50);
    expect(jsonMessages(socket).filter((message) => message.type === "response.cancelled")).toHaveLength(100);
    await Bun.sleep(110);
    expect(await server.shutdown(0)).toBe(true);
  });

  test("PWS-C16 closes framing violations without closing for run-level validation", () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, new Uint8Array([1]));
    expect(socket.closes[0]?.code).toBe(1003);

    const second = server.createConnection(authorization(backend));
    const secondSocket = new FakeSocket();
    server.open(second, secondSocket);
    server.message(second, start().replace("alloc_1", "alloc_wrong"));
    expect(secondSocket.closes).toHaveLength(0);
    expect(jsonMessages(secondSocket).at(-1)?.type).toBe("response.failed");
  });

  test("PWS-C16 maps malformed, schema, oversized, and expired controls to exact close codes", () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const cases: Array<{ message: string; closeCode: number }> = [
      { message: "{", closeCode: 1007 },
      { message: '{"type":"run.cancel","runId":"run_1","extra":true}', closeCode: 1002 },
      { message: "x".repeat(1_048_577), closeCode: 1009 },
    ];
    for (const fixture of cases) {
      const connection = server.createConnection(authorization(backend));
      const socket = new FakeSocket();
      server.open(connection, socket);
      server.message(connection, fixture.message);
      expect(socket.closes.at(-1)?.code).toBe(fixture.closeCode);
    }
    const expiredAuth = authorization(backend);
    expiredAuth.validate = () => false;
    const expired = server.createConnection(expiredAuth);
    const expiredSocket = new FakeSocket();
    server.open(expired, expiredSocket);
    server.message(expired, JSON.stringify({ type: "run.cancel", runId: "run_1" }));
    expect(expiredSocket.closes.at(-1)?.code).toBe(1008);
  });

  test("PWS-C16 reports a run deadline as provider-timeout without closing the connection", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    const request = JSON.parse(start()) as Record<string, unknown>;
    request.timeoutMs = 1;
    server.message(connection, JSON.stringify(request));
    await Bun.sleep(10);
    expect(jsonMessages(socket).at(-1)).toMatchObject({
      type: "response.failed",
      error: { code: "provider-timeout", retryable: true },
    });
    expect(socket.closes).toHaveLength(0);
    await server.shutdown(0);
  });

  test("PWS-C16 bounds the assistant accumulator by Unicode scalar count", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    const chunk = new TextEncoder().encode("x".repeat(16_384));
    for (let index = 0; index < 4; index += 1) backend.queue.push({ type: "delta", bytes: chunk });
    await Bun.sleep(10);
    expect(jsonMessages(socket).at(-1)).toMatchObject({
      type: "response.failed",
      contentBytes: 49_152,
      error: { code: "response-too-large", retryable: false },
    });
    expect(socket.closes).toHaveLength(0);
    await server.shutdown(0);
  });

  test("PWS-C16 turns allocation expiry into a run terminal without closing the connection", async () => {
    const backend = new FakeBackend();
    const lifecycle = new AbortController();
    const auth = authorization(backend);
    auth.lifecycleSignal = lifecycle.signal;
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(auth);
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    lifecycle.abort();
    await Bun.sleep(0);
    expect(jsonMessages(socket).at(-1)).toMatchObject({
      type: "response.failed",
      error: { code: "allocation-inactive", retryable: false },
    });
    expect(socket.closes).toHaveLength(0);
    await server.shutdown(0);
  });

  test("PWS-C17 enforces advertised connection capacity before upgrade reservation", () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const auth = authorization(backend);
    const first = server.createConnection(auth);
    expect(() => server.createConnection(auth)).toThrow(LlmStreamCapacityError);
    server.close(first);
    expect(server.createConnection(auth)).toBeDefined();
  });

  test("PWS-C18 uses RFC 6455 ping and closes after two consecutive pong timeouts", () => {
    let now = 0;
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false, now: () => now });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    now = 15_000;
    server.heartbeatSweep();
    expect(socket.pings).toBe(1);
    now = 20_000;
    server.heartbeatSweep();
    expect(socket.pings).toBe(2);
    now = 25_000;
    server.heartbeatSweep();
    expect(socket.closes.at(-1)?.reason).toBe("heartbeat timeout");
  });

  test("PWS-C18 keeps an empty ping with a zero send status pending for pong", () => {
    let now = 0;
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false, now: () => now });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    socket.ping = () => {
      socket.pings += 1;
      return 0;
    };
    server.open(connection, socket);

    now = 15_000;
    server.heartbeatSweep();
    expect(connection.state).toBe("ready");
    expect(socket.pings).toBe(1);

    server.pong(connection);
    now = 30_000;
    server.heartbeatSweep();
    expect(connection.state).toBe("ready");
    expect(socket.pings).toBe(2);
  });

  test("PWS-C18 contains a transport ping exception and releases connection capacity", () => {
    let now = 0;
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false, now: () => now });
    const auth = authorization(backend);
    const connection = server.createConnection(auth);
    const socket = new FakeSocket();
    socket.ping = () => {
      throw new Error("transport closed");
    };
    server.open(connection, socket);
    now = 15_000;
    expect(() => server.heartbeatSweep()).not.toThrow();
    expect(socket.closes.at(-1)?.code).toBe(1011);
    expect(() => server.createConnection(auth)).not.toThrow();
  });

  test("PWS-C18 does not count ping backpressure as an additional missed pong", () => {
    let now = 0;
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false, now: () => now });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    socket.ping = () => {
      socket.pings += 1;
      return -1;
    };
    server.open(connection, socket);
    now = 15_000;
    server.heartbeatSweep();
    now = 20_000;
    server.heartbeatSweep();
    expect(socket.pings).toBe(2);
    expect(socket.closes).toHaveLength(0);
    now = 25_000;
    server.heartbeatSweep();
    expect(socket.closes.at(-1)?.reason).toBe("heartbeat timeout");
  });

  test("PWS-C19 closes an ACK hash mismatch as a protocol violation", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    backend.queue.push({ type: "delta", bytes: new TextEncoder().encode("hello") });
    await Bun.sleep(0);
    server.message(connection, JSON.stringify({
      type: "run.ack",
      runId: "run_1",
      ackSeq: 2,
      contentSha256: "0".repeat(64),
    }));
    expect(socket.closes.at(-1)?.code).toBe(1002);
  });

  test("PWS-C19 rejects a duplicate active run ID before it can create a second terminal", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    server.message(connection, start());
    expect(socket.closes.at(-1)?.code).toBe(1002);
    expect(jsonMessages(socket).filter((message) =>
      String(message.type).startsWith("response."))).toHaveLength(0);
    await server.shutdown(0);
  });

  test("drain deadline sends a run terminal before Close 1001", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());

    expect(await server.shutdown(0)).toBe(false);
    expect(jsonMessages(socket).at(-1)).toMatchObject({
      type: "response.failed",
      runId: "run_1",
      seq: 2,
      error: { code: "internal-error", retryable: true },
    });
    expect(socket.closes.at(-1)).toEqual({ code: 1001, reason: "server draining" });
    expect(backend.cancels).toContain("run_1");
  });

  test("concurrent shutdown requests share one terminal transition", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());

    await Promise.all([server.shutdown(0), server.shutdown(0)]);
    expect(jsonMessages(socket).filter((message) =>
      String(message.type).startsWith("response."))).toHaveLength(1);
  });

  test("shutdown preserves an in-flight cancel terminal without waiting for slow Provider cancellation", async () => {
    const backend = new FakeBackend();
    backend.cancelDelayMs = 500;
    const server = new LlmStreamServer({ startHeartbeat: false });
    const connection = server.createConnection(authorization(backend));
    const socket = new FakeSocket();
    server.open(connection, socket);
    server.message(connection, start());
    server.message(connection, JSON.stringify({ type: "run.cancel", runId: "run_1" }));

    const startedAt = performance.now();
    expect(await server.shutdown(0)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(jsonMessages(socket).filter((message) =>
      message.type === "response.cancelled")).toHaveLength(1);
    expect(jsonMessages(socket).filter((message) =>
      String(message.type).startsWith("response."))).toHaveLength(1);
    expect(socket.closes.at(-1)?.code).toBe(1001);
  });

  test("send failures release connection capacity without emitting an unmatched close metric", () => {
    const backend = new FakeBackend();
    const events: string[] = [];
    const server = new LlmStreamServer({
      startHeartbeat: false,
      onEvent: (event) => events.push(event.name),
    });
    const auth = authorization(backend);
    const failed = server.createConnection(auth);
    server.open(failed, {
      send: () => {
        throw new Error("socket is closed");
      },
      close: () => {},
      ping: () => 0,
    });
    expect(events).toEqual([]);
    expect(() => server.createConnection(auth)).not.toThrow();
  });

  test("shutdown uses a monotonic deadline when the injected lifecycle clock is fixed", async () => {
    const backend = new FakeBackend();
    const server = new LlmStreamServer({ startHeartbeat: false, now: () => 1_000 });
    const connection = server.createConnection(authorization(backend));
    server.open(connection, new FakeSocket());
    server.message(connection, start());
    const startedAt = performance.now();
    expect(await server.shutdown(15)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});
