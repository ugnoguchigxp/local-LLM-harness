import { z } from "zod";

export const inferenceAuditModeSchema = z.enum([
  "off",
  "metadata",
  "full-required",
]);

export const inferenceAuditStatusSchema = z.enum([
  "active",
  "completed",
  "interrupted",
]);

export const inferenceAuditPayloadSchema = z.object({
  file: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
  plainBytes: z.number().int().nonnegative(),
  storedBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  encoding: z.literal("gzip+aes-256-gcm"),
  keyId: z.string().regex(/^[a-f0-9]{16}$/),
}).strict();

export const inferenceAuditRecordSchema = z.object({
  version: z.literal(1),
  requestId: z.string().regex(/^req_[a-zA-Z0-9._-]{1,186}$/),
  allocationId: z.string().regex(/^alloc_[a-zA-Z0-9._-]{1,186}$/),
  protocol: z.literal("openai.chat-completions.v1"),
  capability: z.string().min(1).max(128),
  route: z.string().min(1).max(128),
  runtime: z.string().min(1).max(128),
  runtimeRelease: z.string().min(1).max(128).optional(),
  bootEpoch: z.string().min(1).max(128),
  configRevision: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  status: inferenceAuditStatusSchema,
  outcome: z.string().min(1).max(128).optional(),
  upstreamStatus: z.number().int().min(100).max(599).optional(),
  requestBytes: z.number().int().nonnegative(),
  responseBytes: z.number().int().nonnegative().default(0),
  responseTruncated: z.boolean().default(false),
  promptCharacters: z.number().int().nonnegative().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  materializationError: z.string().min(1).max(256).optional(),
  personalState: z.object({
    subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
    attemptId: z.string().min(1).max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    viewId: z.string().min(1).max(192).optional(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(512),
    dataEpoch: z.number().int().nonnegative(),
  }).strict().optional(),
  payloads: z.object({
    request: inferenceAuditPayloadSchema.optional(),
    prompt: inferenceAuditPayloadSchema.optional(),
    tokens: inferenceAuditPayloadSchema.optional(),
    response: inferenceAuditPayloadSchema.optional(),
  }).strict(),
}).strict().superRefine((record, context) => {
  const createdAt = Date.parse(record.createdAt);
  const expiresAt = Date.parse(record.expiresAt);
  for (const [field, value] of [
    ["createdAt", record.createdAt],
    ["expiresAt", record.expiresAt],
    ...(record.completedAt ? [["completedAt", record.completedAt]] : []),
  ] as Array<["createdAt" | "expiresAt" | "completedAt", string]>) {
    if (new Date(Date.parse(value)).toISOString() !== value) {
      context.addIssue({
        code: "custom",
        message: `${field} must be canonical ISO-8601`,
        path: [field],
      });
    }
  }
  if (expiresAt <= createdAt || expiresAt - createdAt > 7 * 24 * 60 * 60 * 1000) {
    context.addIssue({
      code: "custom",
      message: "expiresAt must be after createdAt and no more than seven days later",
      path: ["expiresAt"],
    });
  }
  if (record.status === "active") {
    if (
      record.completedAt !== undefined
      || record.outcome !== undefined
      || record.upstreamStatus !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "active records must not contain terminal fields",
        path: ["status"],
      });
    }
  } else if (record.completedAt === undefined || record.outcome === undefined) {
    context.addIssue({
      code: "custom",
      message: "terminal records require completedAt and outcome",
      path: ["status"],
    });
  }
  if (
    record.completedAt !== undefined
    && Date.parse(record.completedAt) < createdAt
  ) {
    context.addIssue({
      code: "custom",
      message: "completedAt must not precede createdAt",
      path: ["completedAt"],
    });
  }
  for (const [kind, descriptor, expectedFile] of [
    ["request", record.payloads.request, "request.json.gz.enc"],
    ["prompt", record.payloads.prompt, "prompt.txt.gz.enc"],
    ["tokens", record.payloads.tokens, "tokens.json.gz.enc"],
    ["response", record.payloads.response, "response.bin.gz.enc"],
  ] as const) {
    if (descriptor && descriptor.file !== expectedFile) {
      context.addIssue({
        code: "custom",
        message: `${kind} payload uses the wrong file`,
        path: ["payloads", kind, "file"],
      });
    }
  }
  if (
    record.payloads.request
    && record.payloads.request.plainBytes !== record.requestBytes
  ) {
    context.addIssue({
      code: "custom",
      message: "request payload size must match requestBytes",
      path: ["payloads", "request", "plainBytes"],
    });
  }
  if (record.status === "completed" && !record.payloads.request) {
    context.addIssue({
      code: "custom",
      message: "completed records require a request payload",
      path: ["payloads", "request"],
    });
  }
  if (record.payloads.response) {
    const captured = record.payloads.response.plainBytes;
    if (
      captured > record.responseBytes
      || (!record.responseTruncated && captured !== record.responseBytes)
    ) {
      context.addIssue({
        code: "custom",
        message: "response payload size is inconsistent with responseBytes",
        path: ["payloads", "response", "plainBytes"],
      });
    }
  } else if (
    record.status === "completed"
    && record.responseBytes > 0
    && !record.responseTruncated
  ) {
    context.addIssue({
      code: "custom",
      message: "completed records with response bytes require a response payload",
      path: ["payloads", "response"],
    });
  }
  if (record.promptTokens !== undefined && !record.payloads.tokens) {
    context.addIssue({
      code: "custom",
      message: "promptTokens requires a token payload",
      path: ["promptTokens"],
    });
  }
  if (record.promptCharacters !== undefined && !record.payloads.prompt) {
    context.addIssue({
      code: "custom",
      message: "promptCharacters requires a prompt payload",
      path: ["promptCharacters"],
    });
  }
});

export type InferenceAuditMode = z.infer<typeof inferenceAuditModeSchema>;
export type InferenceAuditPayload = z.infer<typeof inferenceAuditPayloadSchema>;
export type InferenceAuditRecord = z.input<typeof inferenceAuditRecordSchema>;
export type ParsedInferenceAuditRecord = z.output<typeof inferenceAuditRecordSchema>;

export function inferenceAuditExpired(
  record: Pick<ParsedInferenceAuditRecord, "expiresAt">,
  nowMs: number,
): boolean {
  return nowMs >= Date.parse(record.expiresAt);
}
