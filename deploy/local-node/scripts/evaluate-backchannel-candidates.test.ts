import { expect, test } from "bun:test";
import {
  BACKCHANNEL_CASES,
  parseBackchannelCompletion,
  parseBackchannelDecision,
  readBackchannelJson,
  summarizeBackchannelCases,
} from "./evaluate-backchannel-candidates";

test("backchannel corpus is balanced and has stable unique ids", () => {
  expect(BACKCHANNEL_CASES).toHaveLength(12);
  expect(new Set(BACKCHANNEL_CASES.map((item) => item.id)).size).toBe(BACKCHANNEL_CASES.length);
  expect(BACKCHANNEL_CASES.filter((item) => item.expected === "ack")).toHaveLength(6);
  expect(BACKCHANNEL_CASES.filter((item) => item.expected === "defer")).toHaveLength(6);
});

test("strict decision parsing rejects prose and extra authority", () => {
  expect(parseBackchannelDecision('{"kind":"ack"}')).toBe("ack");
  expect(parseBackchannelDecision('{"kind":"defer"}')).toBe("defer");
  expect(() => parseBackchannelDecision("承知しました")).toThrow(/not JSON/);
  expect(() => parseBackchannelDecision('{"kind":"ack","utterance":"変更しました"}'))
    .toThrow(/strict schema/);
  expect(() => parseBackchannelDecision('{"kind":"clarify"}')).toThrow(/strict schema/);
});

test("summary requires valid JSON and reports a deterministic median", () => {
  expect(summarizeBackchannelCases([
    { expected: "ack", actual: "ack", validJson: true, latencyMs: 100 },
    { expected: "defer", actual: "ack", validJson: true, latencyMs: 300 },
    { expected: "defer", validJson: false, latencyMs: 200 },
    { expected: "defer", actual: "defer", validJson: true, latencyMs: 400 },
  ])).toEqual({
    total: 4,
    schemaValid: 3,
    correct: 2,
    accuracy: 0.5,
    medianLatencyMs: 250,
  });
});

test("backchannel response parsing is bounded and validates the completion envelope", async () => {
  const completion = parseBackchannelCompletion(await readBackchannelJson(Response.json({
    choices: [{ message: { content: "{\"kind\":\"ack\"}" } }],
    usage: { prompt_tokens: 4, completion_tokens: 3 },
  })));
  expect(completion.choices[0]!.message.content).toBe('{"kind":"ack"}');

  const oversized = new Response(new Uint8Array(64 * 1024 + 1), {
    headers: { "content-type": "application/json" },
  });
  expect(readBackchannelJson(oversized)).rejects.toThrow(/too large/);
  expect(() => parseBackchannelCompletion({ choices: [] })).toThrow();
});
