import { createHash } from "node:crypto";
import { countLlamaChatInput, countNativeTextChatInput } from "@larm/backends";
import { ChatInputError, validateChatImages, chatCompletionRequestSchema, type TextChatInputPolicy, type ChatInputPolicy, type AgentProviderContextWindow, type ChatInputTokenCount } from "@larm/core";

export async function prepareChatInput(input: {
  body: Uint8Array;
  endpoint: string;
  policy?: ChatInputPolicy;
  textInput?: TextChatInputPolicy;
  window: AgentProviderContextWindow;
  runtime: string;
  runtimeRelease?: string;
  configRevision: string;
  bootEpoch: string;
  requestId: string;
  signal: AbortSignal;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ body: Uint8Array; count: ChatInputTokenCount }> {
  if (Boolean(input.policy) === Boolean(input.textInput)) throw new ChatInputError(503, "chat_input_contract_unavailable");
  const maxRequestBytes = (input.policy ?? input.textInput)!.maxRequestBytes;
  if (input.body.byteLength > maxRequestBytes) throw new ChatInputError(413, "body_too_large");
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.body));
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error();
  } catch { throw new ChatInputError(400, "invalid_request"); }
  if (!chatCompletionRequestSchema.safeParse(request).success) throw new ChatInputError(400, "invalid_request");
  const imageCount = validateChatImages(request, input.policy);
  if (request.n_predict !== undefined || request.max_completion_tokens !== undefined) throw new ChatInputError(400, "output_parameter_unsupported");
  const requestedOutputTokens = request.max_tokens ?? input.window.outputReserveTokens;
  if (!Number.isSafeInteger(requestedOutputTokens) || (requestedOutputTokens as number) < 1 || (requestedOutputTokens as number) > input.window.outputReserveTokens) throw new ChatInputError(400, "output_budget_exceeded");
  request.max_tokens = requestedOutputTokens;
  const body = new TextEncoder().encode(JSON.stringify(request));
  if (body.byteLength > maxRequestBytes) throw new ChatInputError(413, "body_too_large");
  const countInput = { ...input, request, expectedImageCount: imageCount };
  const measured = input.textInput
    ? await countNativeTextChatInput({ ...countInput, engineBuild: input.textInput.engineBuild })
    : await countLlamaChatInput(countInput);
  const count: ChatInputTokenCount = {
    contractVersion: "larm-chat-input-token-count.v1",
    model: String(request.model),
    promptTokens: measured.promptTokens,
    textTokens: measured.textTokens,
    imageTokens: measured.imageTokens,
    imageCount,
    requestedOutputTokens: requestedOutputTokens as number,
    safetyMarginTokens: input.window.safetyMarginTokens,
    inputBudgetTokens: input.window.maxTokens - (requestedOutputTokens as number) - input.window.safetyMarginTokens,
    maxContextTokens: input.window.maxTokens,
    fits: measured.promptTokens + (requestedOutputTokens as number) + input.window.safetyMarginTokens <= input.window.maxTokens,
    requestDigest: createHash("sha256").update(body).digest("hex"),
    runtime: input.runtime,
    ...(input.runtimeRelease ? { runtimeRelease: input.runtimeRelease } : {}),
    configRevision: input.configRevision,
    bootEpoch: input.bootEpoch,
    engineBuild: measured.engineBuild,
  };
  return { body, count };
}
