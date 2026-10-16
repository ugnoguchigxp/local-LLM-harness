export type InferenceStatistics = Partial<Record<
  "input_tokens" | "output_tokens" | "cached_tokens" | "prefill_ms" | "decode_ms" | "decode_tokens_per_second", number
>>;

/** A numeric allowlist: missing engine measurements stay missing. */
export function inferenceStatistics(value: unknown): InferenceStatistics {
  const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const record = object(value);
  const usage = object(record.usage);
  const timings = object(record.timings);
  const details = object(usage.prompt_tokens_details);
  const candidates = {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    cached_tokens: details.cached_tokens ?? timings.cache_n,
    prefill_ms: timings.prompt_ms,
    decode_ms: timings.predicted_ms,
    decode_tokens_per_second: timings.predicted_per_second,
  };
  return Object.fromEntries(Object.entries(candidates).filter(([, number]) => typeof number === "number" && Number.isFinite(number) && number >= 0));
}
