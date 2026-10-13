import { ChatInputError } from "@larm/core";
import { z } from "zod";

const engineChatTokenCountSchema = z.object({
  contractVersion: z.literal("llama-chat-token-count.v1"),
  promptTokens: z.number().int().nonnegative(),
  textTokens: z.number().int().nonnegative(),
  imageTokens: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
  engineBuild: z.string().min(1).max(128),
}).strict().refine((v) => v.promptTokens === v.textTokens + v.imageTokens);

/** Requires the exact MTMD-aware extension; a legacy text /tokenize reply fails closed. */
export async function countLlamaChatInput(input: {
  endpoint: string;
  request: Record<string, unknown>;
  expectedImageCount: number;
  signal: AbortSignal;
  requestId: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
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
