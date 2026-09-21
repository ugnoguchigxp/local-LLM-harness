import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const tokenPayloadSchema = z.object({
  v: z.literal(1),
  epoch: z.string().min(1).max(128),
  connection: z.string().min(1).max(192),
  allocation: z.string().min(1).max(192),
  provider: z.string().min(1).max(128),
  capability: z.string().min(1).max(128),
  audience: z.string().min(1).max(128),
  generation: z.number().int().positive(),
  providerRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  instanceId: z.string().min(1).max(192).optional(),
  instanceGeneration: z.number().int().positive().optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  subject: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  scopes: z.array(z.enum([
    "context.source.provision",
    "context.measure",
    "context.view.create",
    "context.generate",
    "context.attempt.cancel",
    "context.forget",
    "context.operation.read",
  ])).max(7).optional(),
}).strict().superRefine((payload, context) => {
  if ((payload.instanceId === undefined) !== (payload.instanceGeneration === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "instanceId and instanceGeneration must be supplied together",
      path: [payload.instanceId === undefined ? "instanceId" : "instanceGeneration"],
    });
  }
  if (payload.instanceId !== undefined && payload.providerRevision === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "providerRevision is required for an instance token",
      path: ["providerRevision"],
    });
  }
});

export type ConnectionTokenPayload = z.infer<typeof tokenPayloadSchema>;

export class ConnectionTokenError extends Error {
  constructor(
    readonly code: "invalid_token" | "expired_token",
    message: string,
  ) {
    super(message);
    this.name = "ConnectionTokenError";
  }
}

function encode(value: Uint8Array | string): string {
  return Buffer.from(value).toString("base64url");
}

export class ConnectionTokenCodec {
  constructor(
    private readonly key: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {
    if (key.length !== 32) throw new Error("connection signing key must contain exactly 32 bytes");
  }

  sign(payload: ConnectionTokenPayload): string {
    const validated = tokenPayloadSchema.parse(payload);
    const encodedPayload = encode(JSON.stringify(validated));
    const signed = `larm_conn_v1.${encodedPayload}`;
    const signature = createHmac("sha256", this.key).update(signed).digest();
    return `${signed}.${encode(signature)}`;
  }

  verify(token: string): ConnectionTokenPayload {
    const segments = token.split(".");
    if (segments.length !== 3 || segments[0] !== "larm_conn_v1") {
      throw new ConnectionTokenError("invalid_token", "provider bearer token is malformed");
    }
    const signed = `${segments[0]}.${segments[1]}`;
    const expected = createHmac("sha256", this.key).update(signed).digest();
    if (!/^[A-Za-z0-9_-]+$/.test(segments[1]!) || !/^[A-Za-z0-9_-]{43}$/.test(segments[2]!)) {
      throw new ConnectionTokenError("invalid_token", "provider bearer token is malformed");
    }
    let actual: Buffer;
    try {
      actual = Buffer.from(segments[2]!, "base64url");
    } catch {
      throw new ConnectionTokenError("invalid_token", "provider bearer token is malformed");
    }
    if (encode(actual) !== segments[2]) {
      throw new ConnectionTokenError("invalid_token", "provider bearer token signature is not canonical");
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ConnectionTokenError("invalid_token", "provider bearer token signature is invalid");
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as unknown;
    } catch {
      throw new ConnectionTokenError("invalid_token", "provider bearer token payload is invalid");
    }
    const parsed = tokenPayloadSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ConnectionTokenError("invalid_token", "provider bearer token payload is invalid");
    }
    if (encode(JSON.stringify(parsed.data)) !== segments[1]) {
      throw new ConnectionTokenError("invalid_token", "provider bearer token payload is not canonical");
    }
    const now = Math.floor(this.now() / 1_000);
    if (parsed.data.iat > now) {
      throw new ConnectionTokenError("invalid_token", "provider bearer token is not active yet");
    }
    if (parsed.data.exp <= now) {
      throw new ConnectionTokenError("expired_token", "provider bearer token has expired");
    }
    return parsed.data;
  }
}
