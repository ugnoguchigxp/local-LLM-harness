import { expect, test } from "bun:test";
import type { Allocation } from "./allocation";
import { selectProtocolBinding } from "./protocol";
import type { Registry } from "./registry";

const runtime = (id: string, protocol: Registry["runtimes"][number]["protocol"]) => ({
  id,
  capability: protocol === "openai.audio-speech.v1" ? ["speech.tts"] : ["llm.general"],
  protocol,
  backend: "systemd" as const,
  node: "local-node",
  policy: { class: "resident" as const },
  resources: {
    estimatedMemoryGB: 1,
    maxConcurrentRequests: 1,
    maxQueuedRequests: 0,
    queueTimeoutMs: 100,
  },
  deployment: { service: `${id}.service`, healthPort: 1, endpoint: "http://127.0.0.1:1" },
});

const registry: Registry = {
  nodes: [{
    id: "local-node",
    endpoint: "http://127.0.0.1",
    resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
  }],
  runtimes: [
    runtime("llm", "openai.chat-completions.v1"),
    runtime("tts", "openai.audio-speech.v1"),
  ],
  profiles: [],
  routes: [],
};

const allocation: Allocation = {
  id: "alloc_epoch-test_1",
  bootEpoch: "epoch-test",
  status: "ready",
  requirements: [
    { capability: "llm.general", route: "llm-default" },
    { capability: "speech.tts", route: "tts-default" },
  ],
  bindings: [
    {
      capability: "llm.general",
      route: "llm-default",
      runtime: "llm",
      node: "local-node",
      endpoint: "http://127.0.0.1:1",
      status: "HOT",
      candidateRank: 1,
      fallback: false,
      selectionReason: "primary-live",
    },
    {
      capability: "speech.tts",
      route: "tts-default",
      runtime: "tts",
      node: "local-node",
      endpoint: "http://127.0.0.1:2",
      status: "HOT",
      candidateRank: 1,
      fallback: false,
      selectionReason: "primary-live",
    },
  ],
  allowFallback: false,
  deploymentPolicy: "existing-only",
  createdAt: "2026-08-28T00:00:00.000Z",
  expiresAt: "2026-08-28T00:05:00.000Z",
};

test("selects the protocol-compatible binding without consulting request model fields", () => {
  expect(selectProtocolBinding({
    registry,
    allocation,
    protocol: "openai.audio-speech.v1",
  })).toEqual({ ok: true, binding: allocation.bindings[1] });
});

test("distinguishes capability absence and protocol mismatch", () => {
  expect(selectProtocolBinding({
    registry,
    allocation,
    protocol: "openai.audio-speech.v1",
    capability: "speech.tts.expressive",
  })).toEqual({ ok: false, reason: "capability_not_allocated" });
  expect(selectProtocolBinding({
    registry,
    allocation,
    protocol: "openai.audio-speech.v1",
    capability: "llm.general",
  })).toEqual({ ok: false, reason: "protocol_mismatch" });
});
