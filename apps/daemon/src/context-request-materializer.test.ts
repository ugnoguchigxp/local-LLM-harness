import { expect, test } from "bun:test";
import type { ContextDescriptor, ContextPlanItem, ContextViewItem } from "@larm/core";
import type { ContextSourceProvider } from "@larm/backends";
import { ContextControllerError } from "./context-controller-errors";
import {
  materializeActiveContextViewRequest,
  materializeMeasurementRequest,
} from "./context-request-materializer";

const descriptor: ContextDescriptor = {
  schemaVersion: 1,
  id: "facts",
  version: "v1",
  sourceHandle: "source-facts",
  sourceDigest: "a".repeat(64),
  classification: "internal",
  byteCount: 5,
  tokenCount: 2,
  tokenizerDigest: "b".repeat(64),
  principal: "principal-a",
  state: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const item: ContextPlanItem = {
  contextId: "facts",
  version: "v1",
  required: true,
  utility: 1,
};
const viewItem: ContextViewItem = {
  ...item,
  tokenCount: 2,
  sourceDigest: descriptor.sourceDigest,
};

function input(overrides: Partial<Parameters<typeof materializeMeasurementRequest>[0]> = {}) {
  return {
    principal: "principal-a",
    original: { model: "test", messages: [{ role: "user", content: "question" }] },
    items: [item],
    getDescriptor: () => descriptor,
    sourceProvider: {
      read: async () => ({ content: "trusted fact", bytes: 11 }),
    } as unknown as ContextSourceProvider,
    sourceMaxBytes: 1024,
    materializedMaxBytes: 4096,
    now: () => Date.parse("2026-09-29T00:00:00.000Z"),
    ...overrides,
  };
}

function activeInput(overrides: Partial<Parameters<typeof materializeActiveContextViewRequest>[0]> = {}) {
  return {
    principal: "principal-a",
    original: { messages: [{ role: "user", content: "question" }] },
    baseRequestBytes: 64,
    items: [viewItem],
    getDescriptor: () => descriptor,
    sourceProvider: {
      read: async () => ({ content: "trusted fact", bytes: 11 }),
    } as unknown as ContextSourceProvider,
    sourceMaxBytes: 1024,
    materializedMaxBytes: 75,
    onOmitted: () => undefined,
    ...overrides,
  };
}

test("materializes authorized context before user content and returns source digests", async () => {
  const original = input().original;
  const result = await materializeMeasurementRequest(input({ original }));
  expect(result.request.messages).toHaveLength(2);
  expect((result.request.messages as { role: string; content: string }[])[0]).toMatchObject({
    role: "system",
  });
  expect((result.request.messages as { content: string }[])[0]?.content).toContain("trusted fact");
  expect(result.sourceDigests).toEqual([descriptor.sourceDigest]);
  expect(original.messages).toHaveLength(1);
});

test("adds context to string and structured system messages", async () => {
  const stringResult = await materializeMeasurementRequest(input({
    original: { messages: [{ role: "system", content: "system rule" }, { role: "user", content: "q" }] },
  }));
  expect((stringResult.request.messages as { content: string }[])[0]?.content)
    .toContain("system rule");

  const structuredResult = await materializeMeasurementRequest(input({
    original: { messages: [{ role: "system", content: [{ type: "text", text: "system rule" }] }] },
  }));
  expect((structuredResult.request.messages as { content: unknown[] }[])[0]?.content).toHaveLength(2);
});

test("rejects malformed requests, unavailable descriptors, and expired sources", async () => {
  await expect(materializeMeasurementRequest(input({ original: { messages: "invalid" } })))
    .rejects.toMatchObject({ status: 400, code: "context_request_invalid" });
  await expect(materializeMeasurementRequest(input({ getDescriptor: () => undefined })))
    .rejects.toMatchObject({ status: 404, code: "context_not_found" });
  await expect(materializeMeasurementRequest(input({
    getDescriptor: () => ({ ...descriptor, expiresAt: "2026-09-28T00:00:00.000Z" }),
  }))).rejects.toMatchObject({ status: 409, code: "context_source_invalid" });
  await expect(materializeMeasurementRequest(input({
    original: { messages: [{ role: "system", content: null }] },
  }))).rejects.toMatchObject({ status: 400, code: "context_request_invalid" });
});

test("maps source verification failures and enforces materialized request size", async () => {
  const failingSource = { read: async () => { throw new Error("untrusted source"); } } as unknown as ContextSourceProvider;
  await expect(materializeMeasurementRequest(input({ sourceProvider: failingSource })))
    .rejects.toMatchObject({ status: 409, code: "context_source_invalid" });
  await expect(materializeMeasurementRequest(input({ materializedMaxBytes: 1 })))
    .rejects.toMatchObject({ status: 422, code: "context_materialization_too_large" });
});

test("propagates an aborted signal and preserves the controller error type", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(materializeMeasurementRequest(input({ signal: abort.signal })))
    .rejects.toBeInstanceOf(DOMException);
  expect(new ContextControllerError(409, "context_source_invalid", "invalid").name)
    .toBe("ContextControllerError");
});

test("materializes a certified view using the original request byte count", async () => {
  const original = activeInput().original;
  const request = await materializeActiveContextViewRequest(activeInput({ original }));
  expect((request.messages as { role: string; content: string }[])[0]).toMatchObject({
    role: "system",
  });
  expect((request.messages as { content: string }[])[0]?.content).toContain("trusted fact");
  expect(original.messages).toHaveLength(2);
});

test("optional unavailable view sources are omitted while the empty context preamble remains stable", async () => {
  const omitted: unknown[] = [];
  const request = await materializeActiveContextViewRequest(activeInput({
    items: [{ ...viewItem, required: false }],
    getDescriptor: () => undefined,
    onOmitted: (entry) => omitted.push(entry),
  }));
  expect(omitted).toEqual([{ contextId: "facts", version: "v1", reason: "invalid" }]);
  expect((request.messages as { content: string }[])[0]?.content)
    .toContain("immutable context blocks");
});

test("active view system messages and required source drift fail closed", async () => {
  await expect(materializeActiveContextViewRequest(activeInput({
    original: { messages: [{ role: "system", content: null }] },
  }))).rejects.toMatchObject({ status: 400, code: "context_request_invalid" });
  await expect(materializeActiveContextViewRequest(activeInput({
    getDescriptor: () => undefined,
  }))).rejects.toMatchObject({ status: 409, code: "context_source_invalid" });
});
