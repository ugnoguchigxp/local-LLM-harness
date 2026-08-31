import { createHash, randomBytes } from "node:crypto";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATIVE_LLM_STREAM_ENCODING,
  NATIVE_LLM_STREAM_PROTOCOL,
  NativeWebSocketLlmStreamBackend,
} from "@larm/backends";
import {
  decodeSaaaDelta,
  encodeSaaaDelta,
  parseSaaaServerControl,
  SAAA_LLM_STREAM_PROTOCOL,
} from "@larm/core";
import {
  LlmStreamServer,
  type LlmStreamAuthorization,
  type LlmStreamConnection,
} from "./llm-stream-session";

const TURN_COUNT = 100;

test("real Bun WSS isolates two 100-run series, 20 resume flaps, and a 1 MiB upload stall", async () => {
  const tlsDirectory = await mkdtemp(join(tmpdir(), "larm-saaa-wss-"));
  const certificate = join(tlsDirectory, "certificate.pem");
  const privateKey = join(tlsDirectory, "private-key.pem");
  const openssl = Bun.spawn([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", privateKey, "-out", certificate,
  ], { stdout: "ignore", stderr: "ignore" });
  if (await openssl.exited !== 0) throw new Error("could not generate the temporary WSS certificate");
  let nativeRuns = 0;
  let rejectedProtocols = 0;
  let rejectedCredentials = 0;
  const native = Bun.serve<{ connected: true }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (
        url.pathname !== "/v1/native/llm/stream"
        || request.headers.get("sec-websocket-protocol") !== NATIVE_LLM_STREAM_PROTOCOL
      ) return new Response("invalid native upgrade", { status: 400 });
      if (!server.upgrade(request, {
        data: { connected: true },
        headers: { "Sec-WebSocket-Protocol": NATIVE_LLM_STREAM_PROTOCOL },
      })) return new Response("native upgrade failed", { status: 400 });
      return undefined;
    },
    websocket: {
      perMessageDeflate: false,
      open(socket) {
        socket.send(JSON.stringify({
          type: "native.ready",
          protocol: NATIVE_LLM_STREAM_PROTOCOL,
          encoding: NATIVE_LLM_STREAM_ENCODING,
          maxConcurrentRuns: 2,
          capabilities: {
            pauseResume: true,
            cancel: true,
            toolContinuation: true,
            usage: true,
          },
        }), false);
      },
      message(socket, wire) {
        if (typeof wire !== "string") {
          socket.close(1003, "native controls must be text");
          return;
        }
        const message = JSON.parse(wire) as { type?: string };
        if (message.type !== "native.run") return;
        nativeRuns += 1;
        socket.send(encodeSaaaDelta(2, new TextEncoder().encode("hello")), false);
        socket.send(JSON.stringify({
          type: "native.completed",
          finishReason: "stop",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }), false);
      },
    },
  });
  const backend = new NativeWebSocketLlmStreamBackend("qwen-general", {
    url: `ws://127.0.0.1:${native.port}/v1/native/llm/stream`,
    protocol: NATIVE_LLM_STREAM_PROTOCOL,
    connectTimeoutMs: 1_000,
    requiredConcurrentRuns: 2,
  });
  const sessions = new LlmStreamServer({ startHeartbeat: false, random: () => "network" });
  const authorization: LlmStreamAuthorization = {
    connectionScope: "connection:llm",
    allocationId: "allocation-network",
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
      maxConcurrentRuns: 2,
      maxConnections: 2,
      resumeWindowMs: 120_000,
      upstreamTransport: "native",
    },
    backend,
    validate: () => true,
  };
  const gateway = Bun.serve<LlmStreamConnection>({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(certificate), key: Bun.file(privateKey) },
    fetch(request, server) {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== "Bearer larm_conn_v1.network") {
        rejectedCredentials += 1;
        return new Response("invalid credential", { status: 401 });
      }
      if (url.pathname !== "/v1/llm/stream"
        || request.headers.get("sec-websocket-protocol") !== SAAA_LLM_STREAM_PROTOCOL) {
        rejectedProtocols += 1;
        return new Response("invalid public upgrade", { status: 400 });
      }
      const connection = sessions.createConnection({
        ...authorization,
        streaming: {
          ...authorization.streaming,
          url: `wss://127.0.0.1:${gateway.port}/v1/llm/stream`,
        },
      });
      if (!server.upgrade(request, {
        data: connection,
        headers: { "Sec-WebSocket-Protocol": SAAA_LLM_STREAM_PROTOCOL },
      })) {
        sessions.close(connection);
        return new Response("public upgrade failed", { status: 400 });
      }
      return undefined;
    },
    websocket: {
      maxPayloadLength: 1_048_576,
      perMessageDeflate: false,
      open: (socket) => sessions.open(socket.data, socket),
      message: (socket, wire) => sessions.message(
        socket.data,
        typeof wire === "string" ? wire : new Uint8Array(wire),
      ),
      drain: (socket) => sessions.drain(socket.data),
      pong: (socket) => sessions.pong(socket.data),
      close: (socket) => sessions.close(socket.data),
    },
  });

  try {
    const url = `wss://127.0.0.1:${gateway.port}/v1/llm/stream`;
    await expectRejectedCredential(url, certificate);
    expect(rejectedCredentials).toBe(1);
    await expectRejectedProtocol(url, certificate);
    expect(rejectedProtocols).toBe(1);

    const baseline = await runClient(url, certificate, TURN_COUNT);
    expect({ ...baseline, p95TurnMs: undefined }).toEqual({
      turns: TURN_COUNT,
      contentBytes: TURN_COUNT * 5,
      terminalSeq: 3,
      networkFlaps: TURN_COUNT / 10,
      p95TurnMs: undefined,
    });
    const uploadStall = await openUploadStall(url, certificate);
    const stalled = await runClient(url, certificate, TURN_COUNT);
    uploadStall.destroy();
    expect({ ...stalled, p95TurnMs: undefined }).toEqual({
      turns: TURN_COUNT,
      contentBytes: TURN_COUNT * 5,
      terminalSeq: 3,
      networkFlaps: TURN_COUNT / 10,
      p95TurnMs: undefined,
    });
    expect(stalled.p95TurnMs - baseline.p95TurnMs).toBeLessThan(5);
    expect(nativeRuns).toBe(TURN_COUNT * 2);
  } finally {
    await sessions.shutdown(0);
    gateway.stop(true);
    native.stop(true);
    await rm(tlsDirectory, { recursive: true, force: true });
  }
});

async function expectRejectedProtocol(url: string, certificate: string): Promise<void> {
  const socket = new WebSocket(url, {
    protocols: ["wrong.protocol"],
    perMessageDeflate: false,
    headers: { Authorization: "Bearer larm_conn_v1.network" },
    tls: { ca: Bun.file(certificate) },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("invalid protocol connection did not settle")), 1_000);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.addEventListener("error", settle, { once: true });
    socket.addEventListener("close", settle, { once: true });
    socket.addEventListener("open", () => reject(new Error("invalid protocol was upgraded")), { once: true });
  });
}

async function expectRejectedCredential(url: string, certificate: string): Promise<void> {
  const socket = new WebSocket(url, {
    protocols: [SAAA_LLM_STREAM_PROTOCOL],
    perMessageDeflate: false,
    tls: { ca: Bun.file(certificate) },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("invalid credential connection did not settle")), 1_000);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.addEventListener("error", settle, { once: true });
    socket.addEventListener("close", settle, { once: true });
    socket.addEventListener("open", () => reject(new Error("invalid credential was upgraded")), { once: true });
  });
}

async function runClient(
  url: string,
  certificate: string,
  turnCount: number,
): Promise<{
  turns: number;
  contentBytes: number;
  terminalSeq: number;
  networkFlaps: number;
  p95TurnMs: number;
}> {
  let hash = createHash("sha256");
  let content = "";
  let contentBytes = 0;
  let accepted = false;
  let appliedDelta: Uint8Array | undefined;
  let turn = 1;
  let networkFlaps = 0;
  let socket: WebSocket | undefined;
  let reconnectAfterClose: WebSocket | undefined;
  let settled = false;
  let turnStartedAt = 0;
  const turnDurations: number[] = [];
  const completedRunIds = new Set<string>();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("network conformance timed out")), 10_000);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      reject(error instanceof Error ? error : new Error("network conformance failed"));
    };
    const runId = () => `run-network-${turn}`;
    const startRun = () => {
      if (!socket) throw new Error("network socket is not connected");
      turnStartedAt = performance.now();
      socket.send(JSON.stringify({
        type: "run.start",
        runId: runId(),
        allocationId: "allocation-network",
        model: "coding-default",
        messages: [{ role: "user", content: `hello ${turn}` }],
        maxOutputTokens: 8,
        maxToolCalls: 0,
      }));
    };
    const connect = (resume: boolean) => {
      if (settled) return;
      const connectedAt = performance.now();
      let awaitingResume = resume;
      const current = new WebSocket(url, {
        protocols: [SAAA_LLM_STREAM_PROTOCOL],
        perMessageDeflate: false,
        headers: { Authorization: "Bearer larm_conn_v1.network" },
        tls: { ca: Bun.file(certificate) },
      });
      current.binaryType = "arraybuffer";
      socket = current;
      current.addEventListener("open", () => {
        try {
          expect(current.protocol).toBe(SAAA_LLM_STREAM_PROTOCOL);
          expect(current.extensions).toBe("");
        } catch (error) {
          fail(error);
        }
      }, { once: true });
      current.addEventListener("error", () => {
        if (current !== reconnectAfterClose) fail(new Error("network WebSocket failed"));
      }, { once: true });
      current.addEventListener("close", () => {
        if (settled) return;
        if (current !== reconnectAfterClose) {
          fail(new Error("network WebSocket closed unexpectedly"));
          return;
        }
        reconnectAfterClose = undefined;
        setTimeout(() => connect(true), 5);
      }, { once: true });
      current.addEventListener("message", (event) => {
        if (current !== socket || settled) return;
        try {
          if (typeof event.data !== "string") {
            const frame = event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : event.data instanceof Uint8Array
                ? event.data
                : undefined;
            if (!frame) throw new Error("unexpected binary representation");
            const delta = decodeSaaaDelta(frame);
            if (delta.seq !== 2n) throw new Error("unexpected network delta sequence");
            if (appliedDelta) {
              expect(delta.payload).toEqual(appliedDelta);
            } else {
              appliedDelta = delta.payload.slice();
              content += new TextDecoder("utf-8", { fatal: true }).decode(delta.payload);
              hash.update(delta.payload);
              if (turn % 10 === 0) {
                networkFlaps += 1;
                reconnectAfterClose = current;
                socket = undefined;
                current.close(1001, "network flap");
                return;
              }
            }
            current.send(JSON.stringify({
              type: "run.ack",
              runId: runId(),
              ackSeq: 2,
              contentSha256: hash.copy().digest("hex"),
            }));
            return;
          }
          const message = parseSaaaServerControl(event.data);
          if (message.type === "connection.ready") {
            if (performance.now() - connectedAt >= 5_000) {
              throw new Error("connection.ready exceeded the five-second deadline");
            }
            if (resume) {
              current.send(JSON.stringify({
                type: "run.resume",
                runId: runId(),
                allocationId: "allocation-network",
                ackSeq: 1,
                contentSha256: createHash("sha256").digest("hex"),
              }));
            } else {
              startRun();
            }
            return;
          }
          if (message.type === "run.resumed") {
            if (!awaitingResume || message.runId !== runId() || message.ackSeq !== 1) {
              throw new Error("invalid network resume cursor");
            }
            awaitingResume = false;
            return;
          }
          if (message.type === "run.accepted") {
            if (awaitingResume || message.runId !== runId()) throw new Error("unexpected accepted run id");
            accepted = true;
            current.send(JSON.stringify({
              type: "run.ack",
              runId: runId(),
              ackSeq: 1,
              contentSha256: hash.copy().digest("hex"),
            }));
            return;
          }
          if (message.type !== "response.completed") throw new Error(`unexpected ${message.type}`);
          if (
            message.runId !== runId()
            || completedRunIds.has(message.runId)
            || !accepted
            || content !== "hello"
            || message.contentSha256 !== hash.copy().digest("hex")
          ) {
            throw new Error("network terminal integrity mismatch");
          }
          completedRunIds.add(message.runId);
          turnDurations.push(performance.now() - turnStartedAt);
          contentBytes += message.contentBytes;
          current.send(JSON.stringify({
            type: "run.ack",
            runId: runId(),
            ackSeq: message.seq,
            contentSha256: message.contentSha256,
          }));
          if (turn < turnCount) {
            turn += 1;
            content = "";
            hash = createHash("sha256");
            accepted = false;
            appliedDelta = undefined;
            startRun();
            return;
          }
          settled = true;
          clearTimeout(timer);
          current.close(1000, "complete");
          resolve({
            turns: completedRunIds.size,
            contentBytes,
            terminalSeq: message.seq,
            networkFlaps,
            p95TurnMs: percentile(turnDurations, 0.95),
          });
        } catch (error) {
          fail(error);
        }
      });
    };
    connect(false);
  });
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

async function openUploadStall(url: string, certificate: string): Promise<TLSSocket> {
  const target = new URL(url);
  const socket = connectTls({
    host: target.hostname,
    port: Number(target.port),
    ca: await Bun.file(certificate).text(),
    rejectUnauthorized: true,
  });
  const key = randomBytes(16).toString("base64");
  socket.write([
    `GET ${target.pathname} HTTP/1.1`,
    `Host: ${target.host}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Protocol: ${SAAA_LLM_STREAM_PROTOCOL}`,
    "Sec-WebSocket-Extensions: permessage-deflate",
    "Authorization: Bearer larm_conn_v1.network",
    "",
    "",
  ].join("\r\n"));
  await new Promise<void>((resolve, reject) => {
    let response = "";
    const timer = setTimeout(() => reject(new Error("raw WSS upgrade timed out")), 1_000);
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      if (!response.startsWith("HTTP/1.1 101 ")) {
        reject(new Error("raw WSS upload stall was not upgraded"));
        return;
      }
      const headers = response.slice(0, response.indexOf("\r\n\r\n")).toLowerCase();
      if (headers.includes("sec-websocket-extensions:")) {
        reject(new Error("WSS server negotiated forbidden permessage-deflate"));
        return;
      }
      resolve();
    });
  });
  const framePrefix = Buffer.alloc(15);
  framePrefix[0] = 0x81;
  framePrefix[1] = 0xff;
  framePrefix.writeBigUInt64BE(1_048_576n, 2);
  const mask = randomBytes(4);
  mask.copy(framePrefix, 10);
  framePrefix[14] = 0x7b ^ mask[0]!;
  socket.write(framePrefix);
  return socket;
}
