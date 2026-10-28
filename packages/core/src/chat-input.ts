import { z } from "zod";

/** Internal text-only engine contract; public callers use the existing count API. */
export const textChatInputPolicySchema = z.object({
  protocol: z.literal("llama-chat-input-tokens.v1"),
  engineBuild: z.string().min(1).max(128),
  maxRequestBytes: z.number().int().positive().max(64 * 1024 * 1024).default(4 * 1024 * 1024),
}).strict();
export type TextChatInputPolicy = z.infer<typeof textChatInputPolicySchema>;

export const chatInputPolicySchema = z.object({
  contractVersion: z.literal("larm-chat-input.v1").default("larm-chat-input.v1"),
  maxRequestBytes: z.number().int().positive().max(64 * 1024 * 1024).default(4 * 1024 * 1024),
  images: z.object({
    mimeTypes: z.array(z.enum(["image/jpeg", "image/png", "image/bmp"])).min(1).default(["image/jpeg", "image/png", "image/bmp"]),
    referenceTypes: z.tuple([z.literal("data-url")]).default(["data-url"]),
    roles: z.tuple([z.literal("user")]).default(["user"]),
    maxImages: z.number().int().min(1).max(32).default(8),
    maxBytes: z.number().int().positive().max(16 * 1024 * 1024).default(3 * 1024 * 1024),
    maxWidth: z.number().int().positive().max(32768).default(8192),
    maxHeight: z.number().int().positive().max(32768).default(8192),
    maxPixels: z.number().int().positive().max(64 * 1024 * 1024).default(16 * 1024 * 1024),
    maxAspectRatio: z.number().positive().max(100).default(100),
    detail: z.literal("auto-only").default("auto-only"),
    orientation: z.literal("encoded-pixels").default("encoded-pixels"),
    alpha: z.literal("discard").default("discard"),
  }).strict().default({ mimeTypes: ["image/jpeg", "image/png", "image/bmp"], referenceTypes: ["data-url"], roles: ["user"], maxImages: 8, maxBytes: 3 * 1024 * 1024, maxWidth: 8192, maxHeight: 8192, maxPixels: 16 * 1024 * 1024, maxAspectRatio: 100, detail: "auto-only", orientation: "encoded-pixels", alpha: "discard" }),
  tokenCounting: z.object({
    protocol: z.literal("llama-chat-token-count.v1").default("llama-chat-token-count.v1"),
    endpoint: z.literal("/v1/chat/completions/input-tokens").default("/v1/chat/completions/input-tokens"),
  }).strict().default({ protocol: "llama-chat-token-count.v1", endpoint: "/v1/chat/completions/input-tokens" }),
}).strict();
export type ChatInputPolicy = z.infer<typeof chatInputPolicySchema>;
export const chatInputContractSchema = chatInputPolicySchema.extend({
  retention: z.object({
    inferenceAudit: z.enum(["off", "metadata", "full-required"]),
    requestPayloadStored: z.boolean(),
    maxRetentionSeconds: z.number().int().nonnegative(),
    encrypted: z.boolean(),
    tokenCountPayloadStored: z.literal(false),
    providerImageStore: z.literal(false),
    historyResendRequired: z.literal(true),
  }).strict(),
});
export const chatInputTokenCountSchema = z.object({
  contractVersion: z.literal("larm-chat-input-token-count.v1"),
  model: z.string().min(1),
  promptTokens: z.number().int().nonnegative(),
  textTokens: z.number().int().nonnegative(),
  imageTokens: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
  requestedOutputTokens: z.number().int().positive(),
  safetyMarginTokens: z.number().int().nonnegative(),
  inputBudgetTokens: z.number().int().positive(),
  maxContextTokens: z.number().int().positive(),
  fits: z.boolean(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.string().min(1),
  runtimeRelease: z.string().optional(),
  configRevision: z.string().min(1),
  bootEpoch: z.string().min(1),
  engineBuild: z.string().min(1),
}).strict().refine((v) => v.promptTokens === v.textTokens + v.imageTokens, "token totals must agree");
export type ChatInputTokenCount = z.infer<typeof chatInputTokenCountSchema>;

export class ChatInputError extends Error {
  constructor(readonly status: 400 | 413 | 415 | 422 | 503, readonly code: string) {
    super(code.replaceAll("_", " "));
    this.name = "ChatInputError";
  }
}

type ImageHeader = { mime: string; width: number; height: number };
function imageHeader(bytes: Buffer): ImageHeader {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(8) !== 13) throw new ChatInputError(422, "image_invalid");
    return { mime: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 26 && bytes.toString("ascii", 0, 2) === "BM") {
    const dib = bytes.readUInt32LE(14);
    if (![12,40,56,108,124].includes(dib) || bytes.length < 14 + dib) throw new ChatInputError(415, "image_format_unsupported");
    const width = dib === 12 ? bytes.readUInt16LE(18) : bytes.readInt32LE(18);
    const height = dib === 12 ? bytes.readUInt16LE(20) : Math.abs(bytes.readInt32LE(22));
    const bpp = bytes.readUInt16LE(dib === 12 ? 24 : 28);
    const compression = dib === 12 ? 0 : bytes.readUInt32LE(30);
    if (![1,4,8,16,24,32].includes(bpp) || ![0,3].includes(compression) || (compression === 3 && ![16,32].includes(bpp))) throw new ChatInputError(415, "image_format_unsupported");
    return { mime: "image/bmp", width, height };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw new ChatInputError(422, "image_invalid");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker !== undefined && marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker !== undefined && marker >= 192 && marker <= 207 && ![196,200,204].includes(marker)) {
        if (![192,193,194].includes(marker) || bytes[offset + 2] !== 8) throw new ChatInputError(415, "image_format_unsupported");
        if (length < 8) break;
        return { mime: "image/jpeg", height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
  }
  throw new ChatInputError(422, "image_invalid");
}

/** Validate raw dimensions BEFORE the Provider allocates decoded image buffers. */
export function validateChatImages(request: Record<string, unknown>, policy?: ChatInputPolicy): number {
  if (!Array.isArray(request.messages)) throw new ChatInputError(400, "invalid_request");
  let count = 0;
  for (const message of request.messages) {
    if (!message || typeof message !== "object") throw new ChatInputError(400, "invalid_request");
    const msg = message as Record<string, unknown>;
    if (!Array.isArray(msg.content)) continue;
    for (const item of msg.content) {
      if (!item || typeof item !== "object") throw new ChatInputError(400, "invalid_request");
      const part = item as Record<string, unknown>;
      if (part.type !== "image_url") continue;
      if (!policy) throw new ChatInputError(415, "image_not_supported");
      if (++count > policy.images.maxImages) throw new ChatInputError(413, "image_count_exceeded");
      if (msg.role !== "user") throw new ChatInputError(400, "image_role_unsupported");
      const image = part.image_url as Record<string, unknown> | undefined;
      if (!image || typeof image.url !== "string") throw new ChatInputError(400, "image_invalid");
      if (image.detail !== undefined && image.detail !== "auto") throw new ChatInputError(400, "image_detail_unsupported");
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.url);
      if (!match) throw new ChatInputError(400, "image_reference_unsupported");
      if (!policy.images.mimeTypes.includes(match[1] as "image/jpeg")) throw new ChatInputError(415, "image_format_unsupported");
      const encoded = match[2]!;
      if (encoded.length > 4 * Math.ceil(policy.images.maxBytes / 3)) throw new ChatInputError(413, "image_too_large");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length === 0 || bytes.toString("base64") !== encoded) throw new ChatInputError(422, "image_invalid");
      if (bytes.length > policy.images.maxBytes) throw new ChatInputError(413, "image_too_large");
      const header = imageHeader(bytes);
      if (header.mime !== match[1]) throw new ChatInputError(415, "image_mime_mismatch");
      if (header.width <= 0 || header.height <= 0) throw new ChatInputError(422, "image_invalid");
      if (header.width > policy.images.maxWidth || header.height > policy.images.maxHeight || header.width * header.height > policy.images.maxPixels || Math.max(header.width / header.height, header.height / header.width) > policy.images.maxAspectRatio) throw new ChatInputError(413, "image_dimensions_exceeded");
    }
  }
  return count;
}
