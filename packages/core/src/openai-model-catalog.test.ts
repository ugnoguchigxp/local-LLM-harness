import { expect, test } from "bun:test";
import type { AgentConnectionCatalog } from "./agent-connection";
import {
  createOpenAiModelCatalog,
  getOpenAiModel,
  listOpenAiModels,
  OpenAiModelCatalogError,
} from "./openai-model-catalog";

function catalog(
  bindings: Array<{
    profile: string;
    model: string;
    capability?: string;
    route?: string;
    deprecated?: boolean;
    schedulingPriority?: number;
    protocol?: "openai.chat-completions.v1" | "openai.audio-transcriptions.v1" | "openai.audio-speech.v1";
  }>,
): AgentConnectionCatalog {
  return {
    version: 1,
    defaultAgentProfile: bindings[0]?.profile ?? "default",
    audiences: [],
    profiles: bindings.map((binding, index) => ({
      id: binding.profile,
      canonicalProfile: binding.profile,
      description: binding.profile,
      selectionPolicy: index === 0 ? "default" : "explicit-only",
      deprecated: binding.deprecated ?? false,
      schedulingPriority: binding.schedulingPriority,
      revision: `revision-${index}`,
      providers: [{
        name: "llm",
        capability: binding.capability ?? "llm.coding",
        supportedCapabilities: [binding.capability ?? "llm.coding"],
        route: binding.route ?? "llm-default",
        publicModel: binding.model,
        readiness: binding.protocol === "openai.audio-transcriptions.v1"
          ? "stt-transcription"
          : binding.protocol === "openai.audio-speech.v1"
          ? "tts-speech"
          : "llm-inference",
        protocol: binding.protocol ?? "openai.chat-completions.v1",
      }],
    })),
  };
}

test("OpenAI model catalog lists stable public models without internal bindings", () => {
  const models = createOpenAiModelCatalog(catalog([
    { profile: "coding", model: "coding-default" },
    { profile: "agent", model: "qwen-agent-worker", route: "llm-agent-worker" },
  ]));

  expect(listOpenAiModels(models)).toEqual({
    object: "list",
    data: [
      { id: "coding-default", object: "model", created: 0, owned_by: "larm" },
      { id: "qwen-agent-worker", object: "model", created: 0, owned_by: "larm" },
    ],
  });
  expect(getOpenAiModel(models, "qwen-agent-worker")).toEqual({
    id: "qwen-agent-worker",
    capability: "llm.coding",
    route: "llm-agent-worker",
    protocol: "openai.chat-completions.v1",
    schedulingPriority: 0,
    profileIds: ["agent"],
  });
});

test("OpenAI model catalog omits deprecated compatibility profiles", () => {
  const models = createOpenAiModelCatalog(catalog([
    { profile: "coding", model: "coding-default" },
    { profile: "legacy", model: "coding-default", deprecated: true },
  ]));
  expect(models.models).toEqual([expect.objectContaining({
    id: "coding-default",
    profileIds: ["coding"],
  })]);
});

test("OpenAI model catalog resolves chat, transcription, and speech models by protocol", () => {
  const models = createOpenAiModelCatalog(catalog([
    { profile: "coding", model: "coding-default" },
    {
      profile: "asr",
      model: "qwen3-asr-1.7b",
      capability: "speech.stt",
      route: "stt-qwen",
      protocol: "openai.audio-transcriptions.v1",
    },
    {
      profile: "tts",
      model: "voicevox-core",
      capability: "speech.tts",
      route: "tts-voicevox",
      protocol: "openai.audio-speech.v1",
    },
  ]));
  expect(listOpenAiModels(models).data.map(({ id }) => id)).toEqual([
    "coding-default",
    "qwen3-asr-1.7b",
    "voicevox-core",
  ]);
  expect(getOpenAiModel(models, "qwen3-asr-1.7b", "openai.audio-transcriptions.v1"))
    .toMatchObject({ capability: "speech.stt", route: "stt-qwen" });
  expect(getOpenAiModel(models, "qwen3-asr-1.7b", "openai.chat-completions.v1"))
    .toBeUndefined();
});

test("OpenAI model catalog rejects one public model mapped to different routes", () => {
  expect(() => createOpenAiModelCatalog(catalog([
    { profile: "coding", model: "coding-default", route: "llm-default" },
    { profile: "speed", model: "coding-default", route: "llm-speed" },
  ]))).toThrow(OpenAiModelCatalogError);
});

test("OpenAI model catalog carries server-owned priority and rejects ambiguous duplicates", () => {
  const models = createOpenAiModelCatalog(catalog([
    { profile: "saaa", model: "coding-default", schedulingPriority: 3_000 },
  ]));
  expect(models.models[0]?.schedulingPriority).toBe(3_000);
  expect(() => createOpenAiModelCatalog(catalog([
    { profile: "first", model: "shared", schedulingPriority: 1_000 },
    { profile: "second", model: "shared", schedulingPriority: 2_000 },
  ]))).toThrow(/conflicting scheduling priorities/);
});
