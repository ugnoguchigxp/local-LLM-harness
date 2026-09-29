import { expect, test } from "bun:test";
import type { ContextSourceProvider } from "@larm/backends";
import type { ContextDescriptor, ContextRegistrationRequest, Registry } from "@larm/core";
import { registerContextSource } from "./context-source-registration";

const request: ContextRegistrationRequest = {
  id: "source",
  version: "v1",
  sourceHandle: "handle",
  sourceDigest: "a".repeat(64),
  classification: "internal",
  byteCount: 5,
  tokenCount: 2,
  tokenizerDigest: "b".repeat(64),
};
const sourceProvider: ContextSourceProvider = {
  read: async () => ({
    content: "facts",
    bytes: 5,
    digest: request.sourceDigest,
    tokenizations: [{ tokenizerDigest: request.tokenizerDigest, tokenCount: request.tokenCount }],
  }),
};
const registry = {
  runtimes: [{ context: { class: "managed-context", sourceTokenLimit: 10 } }],
} as unknown as Registry;

type RegistrationInput = Parameters<typeof registerContextSource>[0];

function fixture(overrides: Partial<RegistrationInput> = {}) {
  const descriptors = new Map<string, ContextDescriptor>();
  const events: string[] = [];
  const remembered: unknown[] = [];
  let persisted = 0;
  const input: RegistrationInput = {
    request,
    principal: "principal",
    idempotencyKey: "key",
    registry,
    sourceProvider,
    sourceMaxBytes: 100,
    sourceMaxTotalBytes: 100,
    descriptors,
    descriptorKey: (principal, id, version) => `${principal}\0${id}\0${version}`,
    hash: () => "request-hash",
    replay: <T>() => undefined as T | undefined,
    remember: (...args) => remembered.push(args),
    assertIdempotencyCapacity: () => {},
    persist: async () => { persisted += 1; },
    now: () => "2026-09-29T00:00:00.000Z",
    emitRegistered: (classification) => events.push(classification),
    ...overrides,
  };
  return { input, descriptors, events, remembered, get persisted() { return persisted; } };
}

test("registration verifies canonical source evidence before durable commit and event", async () => {
  const value = fixture();
  const result = await registerContextSource(value.input);
  expect(result).toMatchObject({
    replay: false,
    descriptor: { id: "source", version: "v1", classification: "internal", state: "active" },
  });
  expect(value.descriptors.size).toBe(1);
  expect(value.persisted).toBe(1);
  expect(value.remembered).toHaveLength(1);
  expect(value.events).toEqual(["internal"]);
});

test("persistence failure rolls back the new descriptor and does not publish success", async () => {
  const value = fixture({ persist: async () => { throw new Error("disk unavailable"); } });
  await expect(registerContextSource(value.input)).rejects.toMatchObject({
    status: 503,
    code: "context_subsystem_degraded",
  });
  expect(value.descriptors.size).toBe(0);
  expect(value.remembered).toHaveLength(0);
  expect(value.events).toEqual([]);
});

test("matching idempotency replay bypasses source reads and writes", async () => {
  const value = fixture({
    replay: <T>() => ({ descriptor: { id: "source", version: "v1" } } as T),
    sourceProvider: { read: async () => { throw new Error("must not read on replay"); } },
  });
  const result = await registerContextSource(value.input);
  expect(result).toMatchObject({ descriptor: { id: "source", version: "v1" }, replay: true });
  expect(value.persisted).toBe(0);
  expect(value.descriptors.size).toBe(0);
});
