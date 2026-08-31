import { createHash } from "node:crypto";
import { z } from "zod";

export const SAAA_LLM_STREAM_PROTOCOL = "saaa.llm-stream.v1" as const;
export const SAAA_LLM_STREAM_ENCODING = "json-control+binary-delta-v1" as const;

export const SAAA_LLM_STREAM_LIMITS = Object.freeze({
  maxClientControlBytes: 1_048_576,
  maxServerMessageBytes: 524_288,
  maxDeltaBytes: 16_384,
  maxContentBytes: 262_144,
  maxContentScalars: 64_000,
  maxUnackedEvents: 64,
  maxUnackedBytes: 524_288,
  maxParallelToolCalls: 4,
  resumeWindowMs: 120_000,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 5_000,
  cancelTimeoutMs: 1_000,
  toolResultTimeoutMs: 30_000,
  deltaBatchBytes: 256,
  deltaBatchMs: 5,
});

export const SAAA_LLM_STREAM_CLOSE = Object.freeze({
  protocol: 1002,
  unsupportedData: 1003,
  invalidPayload: 1007,
  policy: 1008,
  messageTooLarge: 1009,
  internal: 1011,
});

const identifierSchema = z.string().min(1).max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const jsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  jsonPrimitiveSchema,
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const textContentPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().max(SAAA_LLM_STREAM_LIMITS.maxContentScalars),
}).strict();

const imageContentPartSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string().min(1).max(262_144),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }).strict(),
}).strict();

export const saaaLlmMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([
    z.string().max(SAAA_LLM_STREAM_LIMITS.maxContentScalars),
    z.array(z.union([textContentPartSchema, imageContentPartSchema])).max(256),
    z.null(),
  ]),
  name: identifierSchema.optional(),
  toolCallId: identifierSchema.optional(),
}).strict();

const functionToolSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: identifierSchema,
    description: z.string().max(8_192).optional(),
    parameters: jsonValueSchema,
  }).strict(),
}).strict();

export const saaaRunStartSchema = z.object({
  type: z.literal("run.start"),
  runId: identifierSchema,
  allocationId: identifierSchema,
  model: identifierSchema,
  messages: z.array(saaaLlmMessageSchema).min(1).max(1_024),
  tools: z.array(functionToolSchema).max(128).optional(),
  reasoning: z.object({
    effort: z.enum(["none", "low", "medium", "high"]),
  }).strict().optional(),
  maxOutputTokens: z.number().int().min(1).max(262_144),
  maxToolCalls: z.number().int().min(0).max(128).default(0),
  timeoutMs: z.number().int().min(1).max(3_300_000).optional(),
}).strict();

export const saaaRunAckSchema = z.object({
  type: z.literal("run.ack"),
  runId: identifierSchema,
  ackSeq: sequenceSchema,
  contentSha256: sha256Schema,
}).strict();

export const saaaRunResumeSchema = z.object({
  type: z.literal("run.resume"),
  runId: identifierSchema,
  allocationId: identifierSchema,
  ackSeq: sequenceSchema,
  contentSha256: sha256Schema,
}).strict();

export const saaaRunCancelSchema = z.object({
  type: z.literal("run.cancel"),
  runId: identifierSchema,
  reason: z.string().min(1).max(256).optional(),
}).strict();

export const saaaToolResultSchema = z.object({
  type: z.literal("tool.result"),
  runId: identifierSchema,
  callId: identifierSchema,
  toolCallSeq: sequenceSchema,
  status: z.enum(["completed", "failed"]),
  content: z.string().max(262_144),
}).strict();

export const saaaClientControlSchema = z.discriminatedUnion("type", [
  saaaRunStartSchema,
  saaaRunAckSchema,
  saaaRunResumeSchema,
  saaaRunCancelSchema,
  saaaToolResultSchema,
]);

export const saaaConnectionReadySchema = z.object({
  type: z.literal("connection.ready"),
  protocol: z.literal(SAAA_LLM_STREAM_PROTOCOL),
  connectionId: identifierSchema,
  upstreamTransport: z.literal("native"),
  limits: z.object({
    maxConcurrentRuns: z.number().int().min(1).max(8),
    maxConnections: z.number().int().min(1).max(8),
    maxActiveRunsPerConnection: z.literal(1),
    maxUnackedEvents: z.literal(SAAA_LLM_STREAM_LIMITS.maxUnackedEvents),
    maxUnackedBytes: z.literal(SAAA_LLM_STREAM_LIMITS.maxUnackedBytes),
    resumeWindowMs: z.number().int().min(SAAA_LLM_STREAM_LIMITS.resumeWindowMs),
    heartbeatIntervalMs: z.literal(SAAA_LLM_STREAM_LIMITS.heartbeatIntervalMs),
  }).strict(),
}).strict();

const usageSchema = z.object({
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
}).strict().nullable();

export const saaaRunAcceptedSchema = z.object({
  type: z.literal("run.accepted"),
  runId: identifierSchema,
  seq: z.literal(1),
}).strict();

export const saaaRunResumedSchema = z.object({
  type: z.literal("run.resumed"),
  runId: identifierSchema,
  ackSeq: sequenceSchema,
}).strict();

export const saaaToolCallSchema = z.object({
  type: z.literal("tool.call"),
  runId: identifierSchema,
  seq: sequenceSchema.min(1),
  callId: identifierSchema,
  name: identifierSchema,
  arguments: z.string().max(262_144),
}).strict();

const terminalShared = {
  runId: identifierSchema,
  seq: sequenceSchema.min(1),
  contentBytes: z.number().int().nonnegative().max(SAAA_LLM_STREAM_LIMITS.maxContentBytes),
  contentSha256: sha256Schema,
};

export const saaaResponseCompletedSchema = z.object({
  type: z.literal("response.completed"),
  ...terminalShared,
  finishReason: z.enum(["stop", "length", "tool_calls", "content_filter", "other"]),
  usage: usageSchema,
}).strict();

export const saaaResponseFailedSchema = z.object({
  type: z.literal("response.failed"),
  ...terminalShared,
  error: z.object({
    code: z.enum([
      "invalid-request",
      "capacity",
      "model-unavailable",
      "provider-error",
      "provider-timeout",
      "response-too-large",
      "backpressure",
      "tool-error",
      "tool-timeout",
      "allocation-inactive",
      "internal-error",
    ]),
    message: z.string().min(1).max(512),
    retryable: z.boolean(),
  }).strict(),
}).strict();

export const saaaResponseCancelledSchema = z.object({
  type: z.literal("response.cancelled"),
  ...terminalShared,
}).strict();

export const saaaServerControlSchema = z.discriminatedUnion("type", [
  saaaConnectionReadySchema,
  saaaRunAcceptedSchema,
  saaaRunResumedSchema,
  saaaToolCallSchema,
  saaaResponseCompletedSchema,
  saaaResponseFailedSchema,
  saaaResponseCancelledSchema,
]);

export type SaaaRunStart = z.infer<typeof saaaRunStartSchema>;
export type SaaaRunAck = z.infer<typeof saaaRunAckSchema>;
export type SaaaRunResume = z.infer<typeof saaaRunResumeSchema>;
export type SaaaRunCancel = z.infer<typeof saaaRunCancelSchema>;
export type SaaaToolResult = z.infer<typeof saaaToolResultSchema>;
export type SaaaClientControl = z.infer<typeof saaaClientControlSchema>;
export type SaaaServerControl = z.infer<typeof saaaServerControlSchema>;

export class SaaaLlmStreamProtocolError extends Error {
  constructor(
    readonly code: "invalid-json" | "invalid-message" | "message-too-large" | "invalid-delta",
    message: string,
  ) {
    super(message);
    this.name = "SaaaLlmStreamProtocolError";
  }
}

class StrictJsonScanner {
  private offset = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.whitespace();
    this.value();
    this.whitespace();
    if (this.offset !== this.source.length) throw new Error("trailing JSON data");
  }

  private value(): void {
    this.whitespace();
    const char = this.source[this.offset];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return void this.string();
    if (char === "t") return this.literal("true");
    if (char === "f") return this.literal("false");
    if (char === "n") return this.literal("null");
    this.number();
  }

  private object(): void {
    this.offset += 1;
    this.whitespace();
    const keys = new Set<string>();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return;
    }
    while (true) {
      if (this.source[this.offset] !== '"') throw new Error("object key must be a string");
      const key = this.string();
      if (keys.has(key)) throw new Error(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      this.whitespace();
      if (this.source[this.offset] !== ":") throw new Error("missing object colon");
      this.offset += 1;
      this.value();
      this.whitespace();
      const delimiter = this.source[this.offset++];
      if (delimiter === "}") return;
      if (delimiter !== ",") throw new Error("invalid object delimiter");
      this.whitespace();
    }
  }

  private array(): void {
    this.offset += 1;
    this.whitespace();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return;
    }
    while (true) {
      this.value();
      this.whitespace();
      const delimiter = this.source[this.offset++];
      if (delimiter === "]") return;
      if (delimiter !== ",") throw new Error("invalid array delimiter");
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset++];
      if (char === '"') {
        return JSON.parse(this.source.slice(start, this.offset)) as string;
      }
      if (char === "\\") {
        const escaped = this.source[this.offset++];
        if (escaped === "u") {
          const hex = this.source.slice(this.offset, this.offset + 4);
          if (!/^[a-fA-F0-9]{4}$/.test(hex)) throw new Error("invalid unicode escape");
          this.offset += 4;
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) {
          throw new Error("invalid string escape");
        }
      } else if (char === undefined || char.charCodeAt(0) < 0x20) {
        throw new Error("invalid string character");
      }
    }
    throw new Error("unterminated string");
  }

  private literal(expected: string): void {
    if (this.source.slice(this.offset, this.offset + expected.length) !== expected) {
      throw new Error("invalid JSON literal");
    }
    this.offset += expected.length;
  }

  private number(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.offset));
    if (!match) throw new Error("invalid JSON value");
    this.offset += match[0].length;
  }

  private whitespace(): void {
    while (this.offset < this.source.length && /[\t\n\r ]/.test(this.source[this.offset]!)) {
      this.offset += 1;
    }
  }
}

export function parseStrictJsonValue(text: string): unknown {
  new StrictJsonScanner(text).scan();
  return JSON.parse(text) as unknown;
}

export function parseSaaaClientControl(text: string): SaaaClientControl {
  if (Buffer.byteLength(text, "utf8") > SAAA_LLM_STREAM_LIMITS.maxClientControlBytes) {
    throw new SaaaLlmStreamProtocolError("message-too-large", "client control message exceeds 1048576 bytes");
  }
  let candidate: unknown;
  try {
    candidate = parseStrictJsonValue(text);
  } catch {
    throw new SaaaLlmStreamProtocolError("invalid-json", "client control must be one strict JSON object");
  }
  const parsed = saaaClientControlSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SaaaLlmStreamProtocolError("invalid-message", "client control does not match saaa.llm-stream.v1");
  }
  return parsed.data;
}

export function parseSaaaServerControl(text: string): SaaaServerControl {
  if (Buffer.byteLength(text, "utf8") > SAAA_LLM_STREAM_LIMITS.maxServerMessageBytes) {
    throw new SaaaLlmStreamProtocolError("message-too-large", "server control message exceeds 524288 bytes");
  }
  let candidate: unknown;
  try {
    candidate = parseStrictJsonValue(text);
  } catch {
    throw new SaaaLlmStreamProtocolError("invalid-json", "server control must be one strict JSON object");
  }
  const parsed = saaaServerControlSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SaaaLlmStreamProtocolError("invalid-message", "server control does not match saaa.llm-stream.v1");
  }
  return parsed.data;
}

export function serializeSaaaServerControl(message: SaaaServerControl): string {
  const parsed = saaaServerControlSchema.parse(message);
  const text = JSON.stringify(parsed);
  if (Buffer.byteLength(text, "utf8") > SAAA_LLM_STREAM_LIMITS.maxServerMessageBytes) {
    throw new SaaaLlmStreamProtocolError("message-too-large", "server message exceeds 524288 bytes");
  }
  return text;
}

export function encodeSaaaDelta(seq: number | bigint, payload: Uint8Array): Uint8Array {
  if (typeof seq === "number" && (!Number.isSafeInteger(seq) || seq < 1)) {
    throw new SaaaLlmStreamProtocolError("invalid-delta", "delta sequence must be a positive safe integer or bigint");
  }
  const numericSeq = typeof seq === "bigint" ? seq : BigInt(seq);
  if (numericSeq < 1n || numericSeq > 0xffff_ffff_ffff_ffffn) {
    throw new SaaaLlmStreamProtocolError("invalid-delta", "delta sequence is out of u64 range");
  }
  if (payload.byteLength < 1 || payload.byteLength > SAAA_LLM_STREAM_LIMITS.maxDeltaBytes) {
    throw new SaaaLlmStreamProtocolError("invalid-delta", "delta payload must contain 1..16384 bytes");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new SaaaLlmStreamProtocolError("invalid-delta", "delta payload must be valid UTF-8");
  }
  const frame = new Uint8Array(16 + payload.byteLength);
  frame.set([0x53, 0x41, 0x44, 0x31, 0x01, 0x00, 0x00, 0x10], 0);
  new DataView(frame.buffer).setBigUint64(8, numericSeq, false);
  frame.set(payload, 16);
  return frame;
}

export function decodeSaaaDelta(frame: Uint8Array): { seq: bigint; payload: Uint8Array } {
  if (
    frame.byteLength < 17
    || frame.byteLength > 16 + SAAA_LLM_STREAM_LIMITS.maxDeltaBytes
    || frame[0] !== 0x53
    || frame[1] !== 0x41
    || frame[2] !== 0x44
    || frame[3] !== 0x31
    || frame[4] !== 0x01
    || frame[5] !== 0x00
    || frame[6] !== 0x00
    || frame[7] !== 0x10
  ) {
    throw new SaaaLlmStreamProtocolError("invalid-delta", "invalid binary delta header or size");
  }
  const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(8, false);
  if (seq === 0n) throw new SaaaLlmStreamProtocolError("invalid-delta", "delta sequence must be positive");
  const payload = frame.subarray(16);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new SaaaLlmStreamProtocolError("invalid-delta", "delta payload must be valid UTF-8");
  }
  return { seq, payload };
}

export function emptySaaaContentSha256(): string {
  return createHash("sha256").digest("hex");
}

export const saaaStreamAdvertisementSchema = z.object({
  protocol: z.literal(SAAA_LLM_STREAM_PROTOCOL),
  url: z.string().url().max(2_048),
  encoding: z.literal(SAAA_LLM_STREAM_ENCODING),
  compression: z.literal("none"),
  maxConcurrentRuns: z.number().int().min(1).max(8),
  maxConnections: z.number().int().min(1).max(8),
  resumeWindowMs: z.number().int().min(SAAA_LLM_STREAM_LIMITS.resumeWindowMs),
  upstreamTransport: z.literal("native"),
}).strict().refine(
  (value) => value.maxConcurrentRuns === value.maxConnections,
  { message: "maxConnections must equal maxConcurrentRuns", path: ["maxConnections"] },
).superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return;
  }
  const loopback = isLiteralLoopbackHost(url.hostname);
  if (
    url.pathname !== "/v1/llm/stream"
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol === "ws:" && !loopback)
    || (url.protocol !== "ws:" && url.protocol !== "wss:")
  ) {
    context.addIssue({
      code: "custom",
      path: ["url"],
      message: "streaming URL must be canonical WSS, or WS on literal loopback",
    });
  }
});

export type SaaaStreamAdvertisement = z.infer<typeof saaaStreamAdvertisementSchema>;

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function isLiteralLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

export function saaaStreamRequestMatchesAdvertisement(
  requestUrl: string,
  advertisement: SaaaStreamAdvertisement,
): boolean {
  try {
    const request = new URL(requestUrl);
    const advertised = new URL(advertisement.url);
    advertised.protocol = advertised.protocol === "wss:" ? "https:" : "http:";
    return request.username === ""
      && request.password === ""
      && request.search === ""
      && request.hash === ""
      && request.toString() === advertised.toString();
  } catch {
    return false;
  }
}

export function createSaaaStreamAdvertisement(input: {
  baseUrl: string;
  maxConcurrentRuns: number;
  maxConnections: number;
  resumeWindowMs?: number;
}): SaaaStreamAdvertisement {
  if (
    !Number.isInteger(input.maxConcurrentRuns)
    || input.maxConcurrentRuns < 1
    || input.maxConcurrentRuns > 8
    || input.maxConnections !== input.maxConcurrentRuns
  ) {
    throw new Error("streaming capacity must use equal maxConnections/maxConcurrentRuns in range 1..8");
  }
  const url = new URL(input.baseUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/v1") {
    throw new Error("streaming base URL must be a canonical /v1 URL");
  }
  const loopback = isLiteralLoopbackHost(normalizedHostname(url));
  if (url.protocol === "http:" && !loopback) {
    throw new Error("non-loopback streaming requires HTTPS/WSS");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("streaming base URL must use HTTP or HTTPS");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/llm/stream";
  const resumeWindowMs = input.resumeWindowMs ?? SAAA_LLM_STREAM_LIMITS.resumeWindowMs;
  if (!Number.isInteger(resumeWindowMs) || resumeWindowMs < SAAA_LLM_STREAM_LIMITS.resumeWindowMs) {
    throw new Error("resume window must be at least 120000 ms");
  }
  return {
    protocol: SAAA_LLM_STREAM_PROTOCOL,
    url: url.toString(),
    encoding: SAAA_LLM_STREAM_ENCODING,
    compression: "none",
    maxConcurrentRuns: input.maxConcurrentRuns,
    maxConnections: input.maxConnections,
    resumeWindowMs,
    upstreamTransport: "native",
  };
}
