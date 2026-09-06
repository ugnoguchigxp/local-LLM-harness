export type OpenAiChatCompletionSseFailureReason =
  | "empty_stream"
  | "invalid_utf8"
  | "invalid_sse_field"
  | "invalid_json"
  | "invalid_chunk"
  | "data_after_done"
  | "missing_delta"
  | "missing_done";

export type OpenAiChatCompletionSseInspection =
  | {
    ok: true;
    chunks: number;
    deltas: number;
    finishReasons: number;
  }
  | {
    ok: false;
    reason: OpenAiChatCompletionSseFailureReason;
  };

function decode(input: string | Uint8Array): string | undefined {
  if (typeof input === "string") return input;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return undefined;
  }
}

function inspectChunk(value: unknown): { deltas: number; finishReasons: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const chunk = value as Record<string, unknown>;
  if (chunk.object !== undefined && chunk.object !== "chat.completion.chunk") return undefined;
  if (!Array.isArray(chunk.choices)) return undefined;
  if (chunk.choices.length === 0) {
    return chunk.usage && typeof chunk.usage === "object" && !Array.isArray(chunk.usage)
      ? { deltas: 0, finishReasons: 0 }
      : undefined;
  }
  if (chunk.choices.length > 16) return undefined;
  let deltas = 0;
  let finishReasons = 0;
  for (const value of chunk.choices) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const choice = value as Record<string, unknown>;
    if (!Number.isInteger(choice.index)) return undefined;
    if (!choice.delta || typeof choice.delta !== "object" || Array.isArray(choice.delta)) return undefined;
    const delta = choice.delta as Record<string, unknown>;
    if (Object.entries(delta).some(([key, item]) => {
      if (key === "role" || item === null || item === undefined) return false;
      if (typeof item === "string" || Array.isArray(item)) return item.length > 0;
      return typeof item === "object" || typeof item === "number" || typeof item === "boolean";
    })) deltas += 1;
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== "string" || choice.finish_reason.length === 0) return undefined;
      finishReasons += 1;
    }
  }
  return { deltas, finishReasons };
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
    chunks += 1;
    deltas += inspected.deltas;
    finishReasons += inspected.finishReasons;
  }
  if (deltas === 0) return { ok: false, reason: "missing_delta" };
  if (!done) return { ok: false, reason: "missing_done" };
  return { ok: true, chunks, deltas, finishReasons };
}
