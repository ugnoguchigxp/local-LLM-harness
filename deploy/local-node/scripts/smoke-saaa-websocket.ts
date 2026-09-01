import { createHash, randomUUID } from "node:crypto";
import {
  decodeSaaaDelta,
  parseSaaaServerControl,
  SAAA_LLM_STREAM_PROTOCOL,
} from "../../../packages/core/src/index";

export type SmokeConfig = {
  url: string;
  token: string;
  allocationId: string;
  model: string;
  timeoutMs: number;
  prompt?: string;
  maxOutputTokens?: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseSmokeConfig(): SmokeConfig {
  const url = new URL(required("LARM_SAAA_STREAM_URL"));
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/v1/llm/stream"
    || (url.protocol !== "ws:" && url.protocol !== "wss:")
  ) {
    throw new Error("LARM_SAAA_STREAM_URL must be canonical WS or WSS");
  }
  const timeoutMs = Number(process.env.LARM_SAAA_SMOKE_TIMEOUT_MS ?? "30000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("LARM_SAAA_SMOKE_TIMEOUT_MS must be an integer in 1000..300000");
  }
  return {
    url: url.toString(),
    token: required("LARM_SAAA_PROVIDER_TOKEN"),
    allocationId: required("LARM_SAAA_ALLOCATION_ID"),
    model: required("LARM_SAAA_MODEL"),
    timeoutMs,
  };
}

export async function runSaaaWebSocketSmoke(config: SmokeConfig): Promise<{
  protocol: typeof SAAA_LLM_STREAM_PROTOCOL;
  outcome: "completed";
  deltas: number;
  contentBytes: number;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  firstDeltaMs: number;
  durationMs: number;
}> {
  const startedAt = performance.now();
  const runId = `run_smoke_${randomUUID()}`;
  let expectedSeq = 1;
  let contentBytes = 0;
  let deltas = 0;
  let firstDeltaAt: number | undefined;
  const hash = createHash("sha256");
  let ready = false;
  let accepted = false;
  let settled = false;
  let serial = Promise.resolve();

  try {
    const socket = new WebSocket(config.url, {
      protocols: [SAAA_LLM_STREAM_PROTOCOL],
      headers: { Authorization: `Bearer ${config.token}` },
      perMessageDeflate: false,
    });
    socket.binaryType = "arraybuffer";
    return await new Promise<{
      protocol: typeof SAAA_LLM_STREAM_PROTOCOL;
      outcome: "completed";
      deltas: number;
      contentBytes: number;
      usage: {
        promptTokens: number | null;
        completionTokens: number | null;
        totalTokens: number | null;
      } | null;
      firstDeltaMs: number;
      durationMs: number;
    }>((resolve, reject) => {
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (readyTimer) clearTimeout(readyTimer);
        socket.close(1000, "smoke failed");
        reject(error instanceof Error ? error : new Error("SAAA WebSocket smoke failed"));
      };
      const timer = setTimeout(() => fail(new Error("SAAA WebSocket smoke timed out")), config.timeoutMs);
      socket.addEventListener("error", () => fail(new Error("SAAA WebSocket handshake or transport failed")), {
        once: true,
      });
      socket.addEventListener("open", () => {
        if (socket.protocol !== SAAA_LLM_STREAM_PROTOCOL || socket.extensions !== "") {
          fail(new Error("server did not echo the exact SAAA WebSocket subprotocol"));
          return;
        }
        readyTimer = setTimeout(() => fail(new Error("connection.ready exceeded five seconds")), 5_000);
      }, { once: true });
      socket.addEventListener("close", (event) => {
        if (!settled) fail(new Error(`SAAA WebSocket closed before completion (${event.code})`));
      }, { once: true });
      socket.addEventListener("message", (event) => {
        serial = serial.then(async () => {
          if (settled) return;
          if (typeof event.data !== "string") {
            if (!accepted) throw new Error("delta arrived before run.accepted");
            const bytes = event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : event.data instanceof Blob
                ? new Uint8Array(await event.data.arrayBuffer())
                : event.data instanceof Uint8Array
                  ? event.data
                  : undefined;
            if (!bytes) throw new Error("unsupported WebSocket binary representation");
            const delta = decodeSaaaDelta(bytes);
            if (delta.seq !== BigInt(expectedSeq)) throw new Error("non-contiguous delta sequence");
            expectedSeq += 1;
            deltas += 1;
            firstDeltaAt ??= performance.now();
            contentBytes += delta.payload.byteLength;
            hash.update(delta.payload);
            socket.send(JSON.stringify({
              type: "run.ack",
              runId,
              ackSeq: Number(delta.seq),
              contentSha256: hash.copy().digest("hex"),
            }));
            return;
          }
          const message = parseSaaaServerControl(event.data);
          if (message.type === "connection.ready") {
            if (ready || message.protocol !== SAAA_LLM_STREAM_PROTOCOL) {
              throw new Error("invalid or duplicate connection.ready");
            }
            ready = true;
            if (readyTimer) clearTimeout(readyTimer);
            readyTimer = undefined;
            socket.send(JSON.stringify({
              type: "run.start",
              runId,
              allocationId: config.allocationId,
              model: config.model,
              messages: [{ role: "user", content: config.prompt ?? "Reply with exactly: READY" }],
              maxOutputTokens: config.maxOutputTokens ?? 32,
              maxToolCalls: 0,
              timeoutMs: config.timeoutMs,
            }));
            return;
          }
          if (message.type === "run.accepted") {
            if (!ready || accepted || message.runId !== runId || message.seq !== expectedSeq) {
              throw new Error("invalid run.accepted");
            }
            accepted = true;
            expectedSeq += 1;
            socket.send(JSON.stringify({
              type: "run.ack",
              runId,
              ackSeq: message.seq,
              contentSha256: hash.copy().digest("hex"),
            }));
            return;
          }
          if (message.type === "response.completed") {
            if (
              !ready
              || !accepted
              || message.runId !== runId
              || message.seq !== expectedSeq
              || message.contentBytes !== contentBytes
              || message.contentSha256 !== hash.copy().digest("hex")
              || firstDeltaAt === undefined
              || deltas === 0
            ) throw new Error("terminal integrity validation failed");
            socket.send(JSON.stringify({
              type: "run.ack",
              runId,
              ackSeq: message.seq,
              contentSha256: message.contentSha256,
            }));
            settled = true;
            clearTimeout(timer);
            if (readyTimer) clearTimeout(readyTimer);
            socket.close(1000, "smoke complete");
            resolve({
              protocol: SAAA_LLM_STREAM_PROTOCOL,
              outcome: "completed",
              deltas,
              contentBytes,
              usage: message.usage,
              firstDeltaMs: Math.round(firstDeltaAt - startedAt),
              durationMs: Math.round(performance.now() - startedAt),
            });
            return;
          }
          if (message.type === "response.failed") {
            throw new Error(`run failed: ${message.error.code}`);
          }
          if (message.type === "response.cancelled") throw new Error("run was unexpectedly cancelled");
          if (message.type === "tool.call") throw new Error("provider emitted an unexpected tool call");
          throw new Error(`unexpected server message ${message.type}`);
        }).catch(fail);
      });
    });
  } finally {
    config.token = "";
  }
}

if (import.meta.main) {
  const config = parseSmokeConfig();
  try {
    console.log(JSON.stringify(await runSaaaWebSocketSmoke(config)));
  } finally {
    config.token = "";
  }
}
