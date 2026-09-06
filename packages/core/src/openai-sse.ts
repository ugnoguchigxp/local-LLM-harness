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

export type OpenAiChatCompletionSseProgress =
  | {
    ok: true;
    chunks: number;
    deltas: number;
    finishReasons: number;
    done: boolean;
  }
  | {
    ok: false;
    reason: OpenAiChatCompletionSseFailureReason;
  };

export type OpenAiChatCompletionSseChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
    [key: string]: unknown;
  }>;
  usage?: {
    completion_tokens: number;
    prompt_tokens: number;
    total_tokens: number;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

const FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"]);

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
  completionTokens?: number;
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
        completionTokens: (chunk.usage as Record<string, unknown>).completion_tokens as number,
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

export class OpenAiChatCompletionSseInspector {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private pendingCr = false;
  private failed?: OpenAiChatCompletionSseFailureReason;
  private finalized = false;
  private receivedCharacters = 0;
  private chunks = 0;
  private deltas = 0;
  private finishReasons = 0;
  private id?: string;
  private model?: string;
  private created?: number;
  private readonly seenIndexes = new Set<number>();
  private readonly finishedIndexes = new Set<number>();
  private done = false;
  private completionTokens?: number;

  constructor(private readonly onChunk?: (chunk: OpenAiChatCompletionSseChunk) => void) {}

  getCompletionTokens(): number | undefined {
    return this.completionTokens;
  }

  push(input: string | Uint8Array): OpenAiChatCompletionSseProgress {
    if (this.failed) return { ok: false, reason: this.failed };
    if (this.finalized) return this.fail("data_after_done");
    let decoded: string | undefined;
    if (typeof input === "string") {
      decoded = input;
    } else {
      try {
        decoded = this.decoder.decode(input, { stream: true });
      } catch {
        return this.fail("invalid_utf8");
      }
    }
    this.receivedCharacters += decoded.length;
    this.appendNormalized(decoded, false);
    this.processCompleteBlocks();
    return this.progress();
  }

  finish(): OpenAiChatCompletionSseInspection {
    if (this.failed) return { ok: false, reason: this.failed };
    if (this.finalized) return this.finalInspection();
    this.finalized = true;
    try {
      const decoded = this.decoder.decode();
      this.receivedCharacters += decoded.length;
      this.appendNormalized(decoded, true);
    } catch {
      return this.fail("invalid_utf8");
    }
    this.processCompleteBlocks();
    if (!this.failed && this.buffer.length > 0) {
      const block = this.buffer;
      this.buffer = "";
      this.consumeBlock(block);
    }
    return this.finalInspection();
  }

  private appendNormalized(decoded: string, final: boolean): void {
    let index = 0;
    if (this.pendingCr) {
      this.buffer += "\n";
      this.pendingCr = false;
      if (decoded.startsWith("\n")) index = 1;
    }
    for (; index < decoded.length; index += 1) {
      const character = decoded[index]!;
      if (character !== "\r") {
        this.buffer += character;
        continue;
      }
      if (index + 1 < decoded.length) {
        if (decoded[index + 1] === "\n") index += 1;
        this.buffer += "\n";
      } else if (final) {
        this.buffer += "\n";
      } else {
        this.pendingCr = true;
      }
    }
    if (final && this.pendingCr) {
      this.buffer += "\n";
      this.pendingCr = false;
    }
  }

  private processCompleteBlocks(): void {
    while (!this.failed) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator < 0) return;
      const block = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 2);
      this.consumeBlock(block);
    }
  }

  private consumeBlock(block: string): void {
    if (block.length === 0 || this.failed) return;
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
      this.fail("invalid_sse_field");
      return;
    }
    if (data.length === 0) return;
    if (this.done) {
      this.fail("data_after_done");
      return;
    }
    const payload = data.join("\n");
    if (payload === "[DONE]") {
      this.done = true;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(payload) as unknown;
    } catch {
      this.fail("invalid_json");
      return;
    }
    const inspected = inspectChunk(value);
    if (!inspected) {
      this.fail("invalid_chunk");
      return;
    }
    if (
      (this.id !== undefined && inspected.id !== this.id)
      || (this.model !== undefined && inspected.model !== this.model)
      || (this.created !== undefined && inspected.created !== this.created)
    ) {
      this.fail("invalid_chunk");
      return;
    }
    this.id ??= inspected.id;
    this.model ??= inspected.model;
    this.created ??= inspected.created;
    if (inspected.completionTokens !== undefined) {
      if (this.completionTokens !== undefined && this.completionTokens !== inspected.completionTokens) {
        this.fail("invalid_chunk");
        return;
      }
      this.completionTokens = inspected.completionTokens;
    }
    this.chunks += 1;
    for (const choice of inspected.choices) {
      if (this.finishedIndexes.has(choice.index)) {
        this.fail("invalid_chunk");
        return;
      }
      this.seenIndexes.add(choice.index);
      if (choice.meaningful) this.deltas += 1;
      if (choice.finished) {
        this.finishReasons += 1;
        this.finishedIndexes.add(choice.index);
      }
    }
    this.onChunk?.(value as OpenAiChatCompletionSseChunk);
  }

  private progress(): OpenAiChatCompletionSseProgress {
    return this.failed
      ? { ok: false, reason: this.failed }
      : {
        ok: true,
        chunks: this.chunks,
        deltas: this.deltas,
        finishReasons: this.finishReasons,
        done: this.done,
      };
  }

  private fail(reason: OpenAiChatCompletionSseFailureReason): { ok: false; reason: OpenAiChatCompletionSseFailureReason } {
    this.failed ??= reason;
    return { ok: false, reason: this.failed };
  }

  private finalInspection(): OpenAiChatCompletionSseInspection {
    if (this.failed) return { ok: false, reason: this.failed };
    if (this.receivedCharacters === 0) return this.fail("empty_stream");
    if (this.deltas === 0) return this.fail("missing_delta");
    if (!this.done) return this.fail("missing_done");
    if (
      this.finishReasons === 0
      || [...this.seenIndexes].some((index) => !this.finishedIndexes.has(index))
    ) {
      return this.fail("missing_finish");
    }
    const orderedIndexes = [...this.seenIndexes].sort((left, right) => left - right);
    if (
      orderedIndexes.some((index, position) => index !== position)
      || this.id === undefined
      || this.model === undefined
    ) {
      return this.fail("invalid_chunk");
    }
    return {
      ok: true,
      id: this.id,
      model: this.model,
      chunks: this.chunks,
      deltas: this.deltas,
      finishReasons: this.finishReasons,
    };
  }
}

export function inspectOpenAiChatCompletionSse(
  input: string | Uint8Array,
): OpenAiChatCompletionSseInspection {
  const inspector = new OpenAiChatCompletionSseInspector();
  const progress = inspector.push(input);
  return progress.ok ? inspector.finish() : progress;
}
