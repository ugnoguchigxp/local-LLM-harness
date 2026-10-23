import { ChatInputError } from "@larm/core";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const engineChatTokenCountSchema = z.object({
  contractVersion: z.literal("llama-chat-token-count.v1"),
  promptTokens: z.number().int().nonnegative(),
  textTokens: z.number().int().nonnegative(),
  imageTokens: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
  engineBuild: z.string().min(1).max(128),
}).strict().refine((v) => v.promptTokens === v.textTokens + v.imageTokens);

/** Probe the actual template without changing the request used for counting or
 * generation. Some templates advertise system support but silently skip later
 * instruction messages. Unique markers also detect duplicate/empty messages
 * that a substring check against the real content would miss. */
export async function validateLlamaInstructionMessages(input: {
  endpoint: string;
  request: Record<string, unknown>;
  signal: AbortSignal;
  requestId: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
  const markers: string[] = [];
  const messages = (input.request.messages as Record<string, unknown>[]).map(message => {
    if (message.role !== "system" && message.role !== "developer") return message;
    const marker = `LARM_INSTRUCTION_${randomUUID().replaceAll("-", "")}_END`;
    markers.push(marker);
    // Probe only: preserve role, position, tools and content representation.
    const content = typeof message.content === "string" ? `${message.content}\n${marker}`
      : Array.isArray(message.content) ? [...message.content, { type: "text", text: marker }]
      : marker;
    return { ...message, content };
  });
  if (markers.length === 0) return;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${input.endpoint.replace(/\/+$/, "")}/apply-template`, {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": input.requestId },
      body: JSON.stringify({ ...input.request, messages }), signal: input.signal, redirect: "error",
    });
  } catch {
    input.signal.throwIfAborted();
    throw new ChatInputError(503, "chat_template_validation_unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ChatInputError(503, "chat_template_validation_unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Prompt JSON can expand control characters; bound even a malformed backend.
  const limit = Buffer.byteLength(JSON.stringify(input.request)) * 8 + 65536;
  try {
    while (true) {
      const part = await reader.read();
      input.signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new ChatInputError(503, "chat_template_validation_unavailable");
      chunks.push(part.value);
    }
    if (!response.ok) throw new ChatInputError(response.status === 400 ? 422 : 503,
      response.status === 400 ? "chat_instruction_template_unsupported" : "chat_template_validation_unavailable");
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value?.prompt !== "string") throw new ChatInputError(503, "chat_template_validation_unavailable");
    if (markers.some(marker => !value.prompt.includes(marker))) throw new ChatInputError(422, "chat_instruction_template_unsupported");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    input.signal.throwIfAborted();
    if (error instanceof ChatInputError) throw error;
    throw new ChatInputError(503, "chat_template_validation_unavailable");
  } finally { reader.releaseLock(); }
}

/** Requires the exact MTMD-aware extension; a legacy text /tokenize reply fails closed. */
export async function countLlamaChatInput(input: {
  endpoint: string;
  request: Record<string, unknown>;
  expectedImageCount: number;
  signal: AbortSignal;
  requestId: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  await validateLlamaInstructionMessages(input);
  let response: Response;
  try { response = await (input.fetchImpl ?? fetch)(`${input.endpoint.replace(/\/+$/, "")}/tokenize`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": input.requestId },
    body: JSON.stringify(input.request),
    signal: input.signal,
    redirect: "error",
  });
  } catch {
    input.signal.throwIfAborted();
    throw new ChatInputError(503, "chat_token_count_unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ChatInputError(503, "chat_token_count_unavailable");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      input.signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32768) throw new ChatInputError(503, "chat_token_count_unavailable");
      chunks.push(part.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) {
      // Only fixed extension codes are interpreted. Never forward backend diagnostics.
      if (response.status === 400 && value?.error?.message === "larm_image_invalid") throw new ChatInputError(422, "image_invalid");
      if (response.status === 400 && value?.error?.message === "larm_chat_input_invalid") throw new ChatInputError(400, "invalid_request");
      throw new ChatInputError(503, "chat_token_count_unavailable");
    }
    const parsed = engineChatTokenCountSchema.safeParse(value);
    if (!parsed.success || parsed.data.imageCount !== input.expectedImageCount) throw new ChatInputError(503, "chat_token_count_unavailable");
    return parsed.data;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    input.signal.throwIfAborted();
    if (error instanceof ChatInputError) throw error;
    throw new ChatInputError(503, "chat_token_count_unavailable");
  } finally { reader.releaseLock(); }
}
