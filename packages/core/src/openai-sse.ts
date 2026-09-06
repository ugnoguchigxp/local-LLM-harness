export type OpenAiChatCompletionSseFailureReason =
  | "empty_stream"
  | "invalid_utf8"
  | "invalid_sse_field"
  | "invalid_json"
  | "invalid_chunk"
  | "data_after_done"
  | "missing_delta"
  | "missing_finish"
  | "missing_done";

export type OpenAiChatCompletionSseInspection =
  | {
    ok: true;
    id: string;
    model: string;
    chunks: number;
    deltas: number;
    finishReasons: number;
  }
  | {
    ok: false;
    reason: OpenAiChatCompletionSseFailureReason;
  };

const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"]);

function decode(input: string | Uint8Array): string | undefined {
  if (typeof input === "string") return input;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return undefined;
  }
}

function inspectDelta(delta: Record<string, unknown>): { valid: boolean; meaningful: boolean } {
  if (
    delta.role !== undefined
    && (typeof delta.role !== "string"
      || !["developer", "system", "user", "assistant", "tool"].includes(delta.role))
  ) {
    return { valid: false, meaningful: false };
  }
  for (const field of ["content", "reasoning_content", "refusal"] as const) {
    const value = delta[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      return { valid: false, meaningful: false };
    }
  }
  const functionCall = inspectFunctionCall(delta.function_call);
  if (!functionCall.valid) return { valid: false, meaningful: false };
  const toolCalls = inspectToolCalls(delta.tool_calls);
  if (!toolCalls.valid) return { valid: false, meaningful: false };
  return {
    valid: true,
    meaningful: [delta.content, delta.reasoning_content, delta.refusal].some(
      (value) => typeof value === "string" && value.length > 0,
    ) || functionCall.meaningful || toolCalls.meaningful,
  };
}

function inspectFunctionCall(value: unknown): { valid: boolean; meaningful: boolean } {
  if (value === undefined || value === null) return { valid: true, meaningful: false };
  if (typeof value !== "object" || Array.isArray(value)) return { valid: false, meaningful: false };
  const call = value as Record<string, unknown>;
  for (const field of ["name", "arguments"] as const) {
    if (call[field] !== undefined && typeof call[field] !== "string") {
      return { valid: false, meaningful: false };
    }
  }
  return {
    valid: true,
    meaningful: [call.name, call.arguments].some(
      (value) => typeof value === "string" && value.length > 0,
    ),
  };
}

function inspectToolCalls(value: unknown): { valid: boolean; meaningful: boolean } {
  if (value === undefined) return { valid: true, meaningful: false };
  if (!Array.isArray(value)) return { valid: false, meaningful: false };
  let meaningful = false;
  const indexes = new Set<number>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { valid: false, meaningful: false };
    const call = item as Record<string, unknown>;
    if (!Number.isSafeInteger(call.index) || (call.index as number) < 0) {
      return { valid: false, meaningful: false };
    }
    const index = call.index as number;
    if (indexes.has(index)) return { valid: false, meaningful: false };
    indexes.add(index);
    if (call.id !== undefined && typeof call.id !== "string") return { valid: false, meaningful: false };
    if (call.type !== undefined && call.type !== "function") return { valid: false, meaningful: false };
    const inspectedFunction = inspectFunctionCall(call.function);
    if (!inspectedFunction.valid) return { valid: false, meaningful: false };
    meaningful ||= (typeof call.id === "string" && call.id.length > 0) || inspectedFunction.meaningful;
  }
  return { valid: true, meaningful };
}

function validUsage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return ["completion_tokens", "prompt_tokens", "total_tokens"].every(
    (field) => Number.isSafeInteger(usage[field]) && (usage[field] as number) >= 0,
  ) && (usage.prompt_tokens as number) + (usage.completion_tokens as number) === usage.total_tokens;
}

function inspectChunk(value: unknown): {
  id: string;
  model: string;
  created: number;
  choices: Array<{ index: number; meaningful: boolean; finished: boolean }>;
} | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const chunk = value as Record<string, unknown>;
  if (chunk.object !== "chat.completion.chunk") return undefined;
  if (typeof chunk.id !== "string" || chunk.id.length === 0) return undefined;
  if (!Number.isSafeInteger(chunk.created) || (chunk.created as number) < 0) return undefined;
  if (typeof chunk.model !== "string" || chunk.model.length === 0) return undefined;
  if (!Array.isArray(chunk.choices)) return undefined;
  if (chunk.usage !== undefined && chunk.usage !== null && !validUsage(chunk.usage)) return undefined;
  if (chunk.choices.length === 0) {
    return validUsage(chunk.usage)
      ? {
        id: chunk.id,
        model: chunk.model,
        created: chunk.created as number,
        choices: [],
      }
      : undefined;
  }
  if (chunk.choices.length > 128) return undefined;
  const choices: Array<{ index: number; meaningful: boolean; finished: boolean }> = [];
  const indexes = new Set<number>();
  for (const value of chunk.choices) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const choice = value as Record<string, unknown>;
    if (!Number.isSafeInteger(choice.index) || (choice.index as number) < 0) return undefined;
    const index = choice.index as number;
    if (indexes.has(index)) return undefined;
    indexes.add(index);
    if (!choice.delta || typeof choice.delta !== "object" || Array.isArray(choice.delta)) return undefined;
    const delta = choice.delta as Record<string, unknown>;
    const inspectedDelta = inspectDelta(delta);
    if (!inspectedDelta.valid) return undefined;
    if (!("finish_reason" in choice)) return undefined;
    if (
      choice.finish_reason !== null
      && (typeof choice.finish_reason !== "string" || !FINISH_REASONS.has(choice.finish_reason))
    ) return undefined;
    choices.push({
      index,
      meaningful: inspectedDelta.meaningful,
      finished: typeof choice.finish_reason === "string",
    });
  }
  return {
    id: chunk.id,
    model: chunk.model,
    created: chunk.created as number,
    choices,
  };
}

export function inspectOpenAiChatCompletionSse(
  input: string | Uint8Array,
): OpenAiChatCompletionSseInspection {
  const decoded = decode(input);
  if (decoded === undefined) return { ok: false, reason: "invalid_utf8" };
  if (decoded.length === 0) return { ok: false, reason: "empty_stream" };
  const blocks = decoded.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n\n");
  let chunks = 0;
  let deltas = 0;
  let finishReasons = 0;
  let id: string | undefined;
  let model: string | undefined;
  let created: number | undefined;
  const seenIndexes = new Set<number>();
  const finishedIndexes = new Set<number>();
  let done = false;
  for (const block of blocks) {
    if (block.length === 0) continue;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.length === 0 || line.startsWith(":")) continue;
      if (line === "data") {
        data.push("");
        continue;
      }
      if (line.startsWith("data:")) {
        const value = line.slice(5);
        data.push(value.startsWith(" ") ? value.slice(1) : value);
        continue;
      }
      if (/^(event|id|retry):/.test(line)) continue;
      return { ok: false, reason: "invalid_sse_field" };
    }
    if (data.length === 0) continue;
    if (done) return { ok: false, reason: "data_after_done" };
    const payload = data.join("\n");
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(payload) as unknown;
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
    const inspected = inspectChunk(value);
    if (!inspected) return { ok: false, reason: "invalid_chunk" };
    if (
      (id !== undefined && inspected.id !== id)
      || (model !== undefined && inspected.model !== model)
      || (created !== undefined && inspected.created !== created)
    ) return { ok: false, reason: "invalid_chunk" };
    id ??= inspected.id;
    model ??= inspected.model;
    created ??= inspected.created;
    chunks += 1;
    for (const choice of inspected.choices) {
      if (finishedIndexes.has(choice.index)) return { ok: false, reason: "invalid_chunk" };
      seenIndexes.add(choice.index);
      if (choice.meaningful) deltas += 1;
      if (choice.finished) {
        finishReasons += 1;
        finishedIndexes.add(choice.index);
      }
    }
  }
  if (deltas === 0) return { ok: false, reason: "missing_delta" };
  if (!done) return { ok: false, reason: "missing_done" };
  if (finishReasons === 0 || [...seenIndexes].some((index) => !finishedIndexes.has(index))) {
    return { ok: false, reason: "missing_finish" };
  }
  const orderedIndexes = [...seenIndexes].sort((left, right) => left - right);
  if (orderedIndexes.some((index, position) => index !== position) || id === undefined || model === undefined) {
    return { ok: false, reason: "invalid_chunk" };
  }
  return { ok: true, id, model, chunks, deltas, finishReasons };
}
