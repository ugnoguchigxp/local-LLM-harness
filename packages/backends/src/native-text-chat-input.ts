import { ChatInputError, validateChatImages } from "@larm/core";
import { validateLlamaInstructionMessages } from "./chat-input-tokenizer";

/** Exact token count from the pinned engine's inference parser, never an estimate. */
export async function countNativeTextChatInput(input: {
  endpoint: string;
  engineBuild: string;
  request: Record<string, unknown>;
  expectedImageCount: number;
  signal: AbortSignal;
  requestId: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  validateChatImages(input.request, undefined);
  if (input.expectedImageCount !== 0) throw new ChatInputError(415, "image_not_supported");
  await validateLlamaInstructionMessages(input);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${input.endpoint.replace(/\/+$/, "")}/v1/chat/completions/input_tokens`, {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": input.requestId },
      body: JSON.stringify(input.request), signal: input.signal, redirect: "error",
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
      const chunk = await reader.read();
      input.signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 32768) throw new Error("invalid count response");
      chunks.push(chunk.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok || !Number.isSafeInteger(value?.input_tokens) || value.input_tokens < 0) throw new Error("invalid count response");
    return { contractVersion: "llama-chat-token-count.v1", promptTokens: value.input_tokens as number,
      textTokens: value.input_tokens as number, imageTokens: 0, imageCount: 0,
      engineBuild: input.engineBuild };
  } catch {
    await reader.cancel().catch(() => undefined);
    input.signal.throwIfAborted();
    throw new ChatInputError(503, "chat_token_count_unavailable");
  } finally { reader.releaseLock(); }
}
