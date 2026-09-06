export type OpenAiChatCompletionJsonFailureReason =
  | "invalid_completion"
  | "invalid_choice"
  | "invalid_message";

export type OpenAiChatCompletionJsonInspection =
  | {
    ok: true;
    id: string;
    model: string;
    choices: number;
    textChoices: number;
    completionTokens?: number;
  }
  | {
    ok: false;
    reason: OpenAiChatCompletionJsonFailureReason;
  };

const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"]);

function optionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function validFunctionCall(value: unknown, optional: boolean): boolean {
  if (value === undefined || value === null) return optional;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const call = value as Record<string, unknown>;
  return typeof call.name === "string" && typeof call.arguments === "string";
}

function validToolCalls(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const call = item as Record<string, unknown>;
    if (typeof call.id !== "string" || call.id.length === 0 || ids.has(call.id)) return false;
    ids.add(call.id);
    if (call.type === "function") return validFunctionCall(call.function, false);
    if (call.type !== "custom" || !call.custom || typeof call.custom !== "object" || Array.isArray(call.custom)) {
      return false;
    }
    const custom = call.custom as Record<string, unknown>;
    return typeof custom.name === "string" && typeof custom.input === "string";
  });
}

function validAudio(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const audio = value as Record<string, unknown>;
  return typeof audio.id === "string"
    && typeof audio.data === "string"
    && Number.isSafeInteger(audio.expires_at)
    && (audio.expires_at as number) >= 0
    && typeof audio.transcript === "string";
}

function completionTokens(value: unknown): number | undefined | false {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  if (!["completion_tokens", "prompt_tokens", "total_tokens"].every(
    (field) => Number.isSafeInteger(usage[field]) && (usage[field] as number) >= 0,
  )) return false;
  if ((usage.prompt_tokens as number) + (usage.completion_tokens as number) !== usage.total_tokens) return false;
  return usage.completion_tokens as number;
}

export function inspectOpenAiChatCompletionJson(value: unknown): OpenAiChatCompletionJsonInspection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "invalid_completion" };
  }
  const completion = value as Record<string, unknown>;
  if (
    completion.object !== "chat.completion"
    || typeof completion.id !== "string"
    || completion.id.length === 0
    || !Number.isSafeInteger(completion.created)
    || (completion.created as number) < 0
    || typeof completion.model !== "string"
    || completion.model.length === 0
    || !Array.isArray(completion.choices)
    || completion.choices.length === 0
    || completion.choices.length > 128
  ) {
    return { ok: false, reason: "invalid_completion" };
  }
  const tokens = completionTokens(completion.usage);
  if (tokens === false) return { ok: false, reason: "invalid_completion" };

  const indexes = new Set<number>();
  let textChoices = 0;
  for (const value of completion.choices) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, reason: "invalid_choice" };
    }
    const choice = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(choice.index)
      || (choice.index as number) < 0
      || indexes.has(choice.index as number)
      || typeof choice.finish_reason !== "string"
      || !FINISH_REASONS.has(choice.finish_reason)
    ) {
      return { ok: false, reason: "invalid_choice" };
    }
    indexes.add(choice.index as number);
    if (!choice.message || typeof choice.message !== "object" || Array.isArray(choice.message)) {
      return { ok: false, reason: "invalid_message" };
    }
    const message = choice.message as Record<string, unknown>;
    if (
      message.role !== "assistant"
      || !optionalNullableString(message.content)
      || !optionalNullableString(message.reasoning_content)
      || !optionalNullableString(message.refusal)
      || !validFunctionCall(message.function_call, true)
      || !validToolCalls(message.tool_calls)
      || !validAudio(message.audio)
    ) {
      return { ok: false, reason: "invalid_message" };
    }
    if ([message.content, message.reasoning_content].some(
      (part) => typeof part === "string" && part.length > 0,
    )) textChoices += 1;
  }
  const orderedIndexes = [...indexes].sort((left, right) => left - right);
  if (orderedIndexes.some((index, position) => index !== position)) {
    return { ok: false, reason: "invalid_choice" };
  }
  return {
    ok: true,
    id: completion.id as string,
    model: completion.model as string,
    choices: completion.choices.length,
    textChoices,
    ...(tokens === undefined ? {} : { completionTokens: tokens }),
  };
}
