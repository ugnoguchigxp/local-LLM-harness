import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createSaaaStreamAdvertisement,
  decodeSaaaDelta,
  emptySaaaContentSha256,
  encodeSaaaDelta,
  parseSaaaClientControl,
  parseSaaaServerControl,
  SAAA_LLM_STREAM_LIMITS,
  SaaaLlmStreamProtocolError,
  saaaStreamAdvertisementSchema,
  saaaStreamRequestMatchesAdvertisement,
  serializeSaaaServerControl,
} from "./saaa-llm-stream";

describe("saaa.llm-stream.v1 codec", () => {
  test("PWS-C01 matches the checked-in golden binary and hash vector", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("../test/fixtures/saaa-llm-stream-v1/golden.json", import.meta.url),
      "utf8",
    )) as {
      emptyContentSha256: string;
      delta: { seq: number; utf8: string; frameHex: string; contentSha256: string };
    };
    const payload = new TextEncoder().encode(fixture.delta.utf8);
    expect(Buffer.from(encodeSaaaDelta(fixture.delta.seq, payload)).toString("hex"))
      .toBe(fixture.delta.frameHex);
    expect(createHash("sha256").update(payload).digest("hex")).toBe(fixture.delta.contentSha256);
    expect(emptySaaaContentSha256()).toBe(fixture.emptyContentSha256);
  });

  test("PWS-C02 encodes the fixed 16-byte SAD1 header and a big-endian u64 sequence", () => {
    const frame = encodeSaaaDelta(0x0102_0304_0506_0708n, new TextEncoder().encode("hello"));
    expect([...frame.subarray(0, 16)]).toEqual([
      0x53, 0x41, 0x44, 0x31,
      0x01, 0x00, 0x00, 0x10,
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    ]);
    expect(new TextDecoder().decode(frame.subarray(16))).toBe("hello");
    expect(decodeSaaaDelta(frame)).toEqual({
      seq: 0x0102_0304_0506_0708n,
      payload: new TextEncoder().encode("hello"),
    });
  });

  test("PWS-C03 rejects empty, oversized, malformed, and non-UTF-8 deltas", () => {
    expect(() => encodeSaaaDelta(Number.MAX_SAFE_INTEGER + 1, new TextEncoder().encode("x")))
      .toThrow(SaaaLlmStreamProtocolError);
    expect(() => encodeSaaaDelta(1.5, new TextEncoder().encode("x")))
      .toThrow(SaaaLlmStreamProtocolError);
    expect(() => encodeSaaaDelta(1, new Uint8Array())).toThrow(SaaaLlmStreamProtocolError);
    expect(() => encodeSaaaDelta(
      1,
      new Uint8Array(SAAA_LLM_STREAM_LIMITS.maxDeltaBytes + 1),
    )).toThrow(SaaaLlmStreamProtocolError);
    expect(() => encodeSaaaDelta(1, new Uint8Array([0xff]))).toThrow(SaaaLlmStreamProtocolError);
    const malformed = encodeSaaaDelta(1, new TextEncoder().encode("x"));
    malformed[7] = 0x11;
    expect(() => decodeSaaaDelta(malformed)).toThrow(SaaaLlmStreamProtocolError);
  });

  test("PWS-C04 uses the canonical empty SHA-256 checkpoint", () => {
    expect(emptySaaaContentSha256()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("saaa.llm-stream.v1 control JSON", () => {
  const runStart = {
    type: "run.start",
    runId: "run_1",
    allocationId: "alloc_1",
    model: "coding-default",
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens: 128,
  };

  test("PWS-C05 parses strict run.start and applies the bounded tool default", () => {
    expect(parseSaaaClientControl(JSON.stringify(runStart)) as unknown).toEqual({
      ...runStart,
      maxToolCalls: 0,
    });
  });

  test("PWS-C06 rejects duplicate keys, trailing input, non-finite forms, and unknown fields", () => {
    expect(() => parseSaaaClientControl('{"type":"run.cancel","type":"run.cancel","runId":"run_1"}'))
      .toThrow(SaaaLlmStreamProtocolError);
    expect(() => parseSaaaClientControl('{"type":"run.cancel","runId":"run_1"} true'))
      .toThrow(SaaaLlmStreamProtocolError);
    expect(() => parseSaaaClientControl('{"type":"run.cancel","runId":"run_1","extra":true}'))
      .toThrow(SaaaLlmStreamProtocolError);
    expect(() => parseSaaaClientControl('{"type":"run.ack","runId":"run_1","ackSeq":NaN,"contentSha256":"' + "0".repeat(64) + '"}'))
      .toThrow(SaaaLlmStreamProtocolError);
  });

  test("PWS-C07 bounds server JSON before sending", () => {
    const text = serializeSaaaServerControl({
      type: "run.accepted",
      runId: "run_1",
      seq: 1,
    });
    expect(JSON.parse(text)).toEqual({ type: "run.accepted", runId: "run_1", seq: 1 });
    expect(() => serializeSaaaServerControl({
      type: "response.completed",
      runId: "run_1",
      seq: 2,
      contentBytes: 4,
      contentSha256: "0".repeat(64),
      finishReason: "stop",
      usage: null,
      content: "leak",
    } as never)).toThrow();
    expect(() => serializeSaaaServerControl({
      type: "response.completed",
      runId: "run_1",
      seq: 2,
      contentBytes: SAAA_LLM_STREAM_LIMITS.maxContentBytes + 1,
      contentSha256: "0".repeat(64),
      finishReason: "stop",
      usage: null,
    })).toThrow();
    expect(() => parseSaaaServerControl(
      '{"type":"run.accepted","runId":"run_1","runId":"run_2","seq":1}',
    )).toThrow(SaaaLlmStreamProtocolError);
    expect(() => parseSaaaServerControl('{"type":"run.accepted","runId":"run_1","seq":1} true'))
      .toThrow(SaaaLlmStreamProtocolError);
  });
});

describe("stream advertisement", () => {
  test("PWS-C08 derives loopback ws and remote wss without credentials", () => {
    expect(createSaaaStreamAdvertisement({
      baseUrl: "http://127.0.0.1:9810/v1",
      maxConcurrentRuns: 1,
      maxConnections: 1,
    }).url).toBe("ws://127.0.0.1:9810/v1/llm/stream");
    expect(createSaaaStreamAdvertisement({
      baseUrl: "https://larm.example/v1",
      maxConcurrentRuns: 2,
      maxConnections: 2,
    }).url).toBe("wss://larm.example/v1/llm/stream");
  });

  test("PWS-C09 rejects cleartext non-loopback, hostname aliases, and divergent capacities", () => {
    expect(() => createSaaaStreamAdvertisement({
      baseUrl: "http://192.0.2.1:9810/v1",
      maxConcurrentRuns: 1,
      maxConnections: 1,
    })).toThrow("non-loopback");
    expect(() => createSaaaStreamAdvertisement({
      baseUrl: "http://localhost:9810/v1",
      maxConcurrentRuns: 1,
      maxConnections: 1,
    })).toThrow("non-loopback");
    expect(() => createSaaaStreamAdvertisement({
      baseUrl: "http://127.example:9810/v1",
      maxConcurrentRuns: 1,
      maxConnections: 1,
    })).toThrow("non-loopback");
    expect(() => createSaaaStreamAdvertisement({
      baseUrl: "https://larm.example/v1",
      maxConcurrentRuns: 1,
      maxConnections: 2,
    })).toThrow("equal");
    expect(() => saaaStreamAdvertisementSchema.parse({
      protocol: "saaa.llm-stream.v1",
      url: "ws://192.0.2.1:9810/v1/llm/stream",
      encoding: "json-control+binary-delta-v1",
      compression: "none",
      maxConcurrentRuns: 1,
      maxConnections: 1,
      resumeWindowMs: 120_000,
      upstreamTransport: "native",
    })).toThrow("literal loopback");
    expect(saaaStreamAdvertisementSchema.safeParse({
      protocol: "saaa.llm-stream.v1",
      url: "not-a-url",
      encoding: "json-control+binary-delta-v1",
      compression: "none",
      maxConcurrentRuns: 1,
      maxConnections: 1,
      resumeWindowMs: 120_000,
      upstreamTransport: "native",
    }).success).toBeFalse();
  });

  test("binds an upgrade request to the authenticated advertisement origin", () => {
    const advertisement = createSaaaStreamAdvertisement({
      baseUrl: "https://larm.example/v1",
      maxConcurrentRuns: 1,
      maxConnections: 1,
    });
    expect(saaaStreamRequestMatchesAdvertisement(
      "https://larm.example/v1/llm/stream",
      advertisement,
    )).toBeTrue();
    expect(saaaStreamRequestMatchesAdvertisement(
      "http://127.0.0.1:9810/v1/llm/stream",
      advertisement,
    )).toBeFalse();
    expect(saaaStreamRequestMatchesAdvertisement(
      "https://other.example/v1/llm/stream",
      advertisement,
    )).toBeFalse();
  });
});
