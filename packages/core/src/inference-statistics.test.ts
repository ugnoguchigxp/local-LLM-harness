import { expect, test } from "bun:test";
import { inferenceStatistics } from "./inference-statistics";

test("statistics retain explicit numeric engine measurements and exclude request content", () => {
  expect(inferenceStatistics({ usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 12 } }, timings: { cache_n: 7, prompt_ms: 3, predicted_ms: 5, predicted_per_second: 8 }, prompt: "secret" })).toEqual({
    input_tokens: 20, output_tokens: 4, cached_tokens: 12, prefill_ms: 3, decode_ms: 5, decode_tokens_per_second: 8,
  });
  expect(inferenceStatistics({ timings: { prompt_ms: -1, predicted_ms: NaN, predicted_per_second: "20" } })).toEqual({});
  expect(inferenceStatistics({ choices: [{ text: "not tokens" }] })).toEqual({});
  expect(inferenceStatistics(null)).toEqual({});
});
