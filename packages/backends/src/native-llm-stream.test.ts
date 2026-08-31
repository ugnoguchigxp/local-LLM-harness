import { describe, expect, test } from "bun:test";
import { encodeSaaaDelta, SAAA_LLM_STREAM_LIMITS, type SaaaRunStart } from "@larm/core";
import {
  NATIVE_LLM_STREAM_ENCODING,
  NATIVE_LLM_STREAM_PROTOCOL,
  NativeLlmBackendRegistry,
  NativeWebSocketLlmStreamBackend,
  type NativeWebSocketLike,
} from "./native-llm-stream";

function nativeReady(maxConcurrentRuns = 1): string {
  return JSON.stringify({
    type: "native.ready",
    protocol: NATIVE_LLM_STREAM_PROTOCOL,
    encoding: NATIVE_LLM_STREAM_ENCODING,
    maxConcurrentRuns,
    capabilities: {
      pauseResume: true,
      cancel: true,
      toolContinuation: true,
      usage: true,
    },
  });
}

class FakeSocket implements NativeWebSocketLike {
  binaryType = "";
  readyState = 1;
  sent: Array<string | Uint8Array> = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(readonly protocol = "larm.native-llm-stream.v1") {}

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event?: unknown) => void);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const start: SaaaRunStart = {
  type: "run.start",
  runId: "run_1",
  allocationId: "alloc_1",
  model: "coding-default",
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 128,
  maxToolCalls: 1,
};

describe("NativeWebSocketLlmStreamBackend", () => {
  test("PWS-C10 normalizes binary delta, tool, and terminal events without SSE", async () => {
    const sockets: FakeSocket[] = [];
    const backend = new NativeWebSocketLlmStreamBackend("qwen", {
      url: "ws://127.0.0.1:8090/v1/native/llm/stream",
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          socket.emit("open");
          socket.emit("message", { data: nativeReady() });
        });
        return socket;
      },
    });
    const abort = new AbortController();
    const events = backend.open(start, abort.signal);
    await Bun.sleep(0);
    const socket = sockets[0]!;
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: "native.run", run: start });

    socket.emit("message", { data: encodeSaaaDelta(2, new TextEncoder().encode("hello")) });
    socket.emit("message", {
      data: JSON.stringify({ type: "native.tool-call", callId: "call_1", name: "lookup", arguments: "{}" }),
    });
    backend.submitToolResult({
      type: "tool.result",
      runId: "run_1",
      callId: "call_1",
      toolCallSeq: 3,
      status: "completed",
      content: "ok",
    });
    backend.pause("run_1");
    backend.resume("run_1");
    socket.emit("message", {
      data: JSON.stringify({
        type: "native.completed",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    });

    const received = [];
    for await (const event of events) received.push(event);
    expect(received).toEqual([
      { type: "delta", bytes: new TextEncoder().encode("hello") },
      { type: "tool-call", callId: "call_1", name: "lookup", arguments: "{}" },
      {
        type: "completed",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ]);
    expect(socket.sent.slice(1).map((item) => JSON.parse(item as string).type)).toEqual([
      "native.tool-result",
      "native.pause",
      "native.resume",
    ]);
  });

  test("PWS-C11 probes readiness and registry fails closed for unknown runtimes", async () => {
    const socket = new FakeSocket();
    const backend = new NativeWebSocketLlmStreamBackend("qwen", {
      url: "ws://127.0.0.1:8090/v1/native/llm/stream",
      connectTimeoutMs: 100,
      createSocket: () => {
        queueMicrotask(() => {
          socket.emit("open");
          socket.emit("message", { data: nativeReady() });
        });
        return socket;
      },
    });
    const registry = new NativeLlmBackendRegistry([backend]);
    expect(await registry.ready("qwen")).toBe(true);
    expect(await registry.ready("missing")).toBe(false);
    expect(socket.closes[0]).toEqual({ code: 1000, reason: "readiness complete" });
  });

  test("rejects cleartext non-loopback upstreams", () => {
    expect(() => new NativeWebSocketLlmStreamBackend("qwen", {
      url: "ws://192.0.2.1/native",
    })).toThrow("literal loopback");
    expect(() => new NativeWebSocketLlmStreamBackend("qwen", {
      url: "ws://127.example/native",
    })).toThrow("literal loopback");
  });

  test("fails readiness when the native Provider does not echo the exact subprotocol", async () => {
    const socket = new FakeSocket("");
    const backend = new NativeWebSocketLlmStreamBackend("qwen", {
      url: "ws://127.0.0.1:8090/v1/native/llm/stream",
      connectTimeoutMs: 100,
      createSocket: () => {
        queueMicrotask(() => socket.emit("open"));
        return socket;
      },
    });
    expect(await backend.ready()).toBe(false);
    expect(socket.closes[0]?.code).toBe(1002);
  });

  test("fails readiness when semantic capabilities or capacity are missing", async () => {
    const messages = [
      '{"type":"native.ready"}',
      '{"type":"native.ready","type":"native.ready"}',
      nativeReady(2).replace('"usage":true', '"usage":false'),
      nativeReady(1),
    ];
    for (const message of messages) {
      const socket = new FakeSocket();
      const backend = new NativeWebSocketLlmStreamBackend("qwen", {
        url: "ws://127.0.0.1:8090/v1/native/llm/stream",
        connectTimeoutMs: 100,
        requiredConcurrentRuns: 2,
        createSocket: () => {
          queueMicrotask(() => {
            socket.emit("open");
            socket.emit("message", { data: message });
          });
          return socket;
        },
      });
      expect(await backend.ready()).toBe(false);
      expect(socket.closes.some((close) => close.code === 1002 || close.code === 1011)).toBe(true);
    }
  });

  test("rejects native run events sent before native.run and suppresses the start", async () => {
    const socket = new FakeSocket();
    const backend = new NativeWebSocketLlmStreamBackend("qwen", {
      url: "ws://127.0.0.1:8090/v1/native/llm/stream",
      createSocket: () => {
        queueMicrotask(() => {
          socket.emit("open");
          socket.emit("message", { data: nativeReady() });
          socket.emit("message", { data: encodeSaaaDelta(2, new TextEncoder().encode("premature")) });
        });
        return socket;
      },
    });
    const events = backend.open(start, new AbortController().signal);
    await expect(async () => {
      for await (const _event of events) {
        // A protocol violation must fail without yielding the premature event.
      }
    }).toThrow("before native.run");
    await Bun.sleep(0);
    expect(socket.sent).toHaveLength(0);
    expect(socket.closes.at(-1)?.code).toBe(1002);
  });

  test("fails promptly and closes when the native Provider overruns its bounded queue", async () => {
    const socket = new FakeSocket();
    const backend = new NativeWebSocketLlmStreamBackend("qwen", {
      url: "ws://127.0.0.1:8090/v1/native/llm/stream",
      createSocket: () => {
        queueMicrotask(() => {
          socket.emit("open");
          socket.emit("message", { data: nativeReady() });
        });
        return socket;
      },
    });
    const events = backend.open(start, new AbortController().signal);
    await Bun.sleep(0);
    for (let index = 0; index <= SAAA_LLM_STREAM_LIMITS.maxUnackedEvents; index += 1) {
      socket.emit("message", { data: encodeSaaaDelta(index + 2, new TextEncoder().encode("x")) });
    }

    await expect(async () => {
      for await (const _event of events) {
        // The queue must fail before yielding buffered stale events.
      }
    }).toThrow("bounded event buffer");
    expect(socket.closes.at(-1)?.code).toBe(1002);
  });
});
