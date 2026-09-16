import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Allocation,
  type ClusterState,
  type Registry,
  type RuntimeReleaseDefinition,
} from "@larm/core";
import { LocalContextMetadataStore, LocalContextSourceStore } from "@larm/backends";
import { createAppComponents } from "./app";
import { ContextController } from "./context-controller";
import { agentPrincipal } from "./agent-connection-controller";
import type { ControlPlane } from "./controller";

test("context API creates a view and materializes it only on the bound Chat request", async () => {
  const now = Date.parse("2026-09-09T00:00:00.000Z");
  const apiToken = "context-api-token";
  const runtime: Registry["runtimes"][number] = {
    id: "qwen-general",
    artifacts: ["model"],
    capability: ["llm.general", "llm.reasoning"],
    protocol: "openai.chat-completions.v1",
    backend: "systemd",
    node: "node",
    policy: { class: "resident" },
    context: {
      class: "managed-context",
      activation: "when-hosted",
      sourceTokenLimit: 20_000_000,
      outputReserveTokens: 100,
      safetyMarginTokens: 20,
      filesystemFreeFloorBytes: 256 * 1024 ** 3,
      operationTimeoutMs: 600_000,
      allowedModes: ["source-rebuild"],
    },
    resources: {
      estimatedMemoryGB: 40,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
      queueTimeoutMs: 1000,
    },
    deployment: {
      service: "llama-server.service",
      healthPort: 8080,
      endpoint: "http://127.0.0.1:8080",
    },
  };
  const registry: Registry = {
    nodes: [{ id: "node", endpoint: "http://127.0.0.1", resources: { memoryTotalGB: 128, reservedMemoryGB: 16 } }],
    runtimes: [runtime],
    profiles: [],
    routes: [],
  };
  const state: ClusterState = {
    generatedAt: new Date(now).toISOString(),
    node: {
      id: "node",
      online: true,
      endpoint: "http://127.0.0.1",
      resources: { memoryTotalGB: 128, reservedMemoryGB: 16 },
    },
    runtimes: [{
      id: runtime.id,
      status: "HOT",
      class: "resident",
      capability: runtime.capability,
      node: "node",
      backend: "systemd",
      endpoint: runtime.deployment.endpoint,
      service: "llama-server.service",
      observedAt: new Date(now).toISOString(),
      health: { ok: true },
    }],
  };
  const release: RuntimeReleaseDefinition = {
    id: "qwen-general-current",
    runtime: runtime.id,
    artifacts: ["model"],
    providerConfigRevision: "provider-v1",
    estimatedMemoryGB: 40,
    healthPath: "/health",
    default: true,
    digest: "e".repeat(64),
    contextCertification: {
      profile: "qwen-context-v1",
      modelArtifactDigest: "a".repeat(64),
      tokenizerDigest: "b".repeat(64),
      chatTemplateDigest: "c".repeat(64),
      engineBuild: "engine-v1",
      providerConfigRevision: "provider-v1",
      contextLimitTokens: 1000,
      verifiedModes: ["source-rebuild"],
      evidenceDigest: "d".repeat(64),
    },
  };
  const allocation: Allocation = {
    id: "alloc_context_test",
    bootEpoch: "boot",
    status: "ready",
    requirements: [{ capability: "llm.reasoning", route: "route" }],
    bindings: [{
      capability: "llm.reasoning",
      route: "route",
      runtime: runtime.id,
      node: "node",
      endpoint: runtime.deployment.endpoint,
      status: "HOT",
      candidateRank: 1,
      fallback: false,
      selectionReason: "test",
      release: release.id,
    }],
    allowFallback: false,
    deploymentPolicy: "existing-only",
    priority: 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  };
  const root = await mkdtemp(join(tmpdir(), "larm-context-api-"));
  const source = new LocalContextSourceStore(join(root, "sources"));
  const provisioned = await source.provision(
    agentPrincipal(apiToken),
    "source-a",
    "The deployment window is Tuesday.",
    1024,
    [{ tokenizerDigest: release.contextCertification!.tokenizerDigest, tokenCount: 20 }],
  );
  const controller = new ContextController({
    enabled: true,
    registry,
    releases: [release],
    metadataStore: new LocalContextMetadataStore(join(root, "metadata")),
    sourceProvider: source,
    tokenizer: {
      identity: async () => ({
        engineBuild: "engine-v1",
        contextLimitTokens: 1000,
        chatTemplateDigest: release.contextCertification!.chatTemplateDigest,
        tokenizerDigest: release.contextCertification!.tokenizerDigest,
      }),
      countChatTokens: async () => 100,
    },
    getState: () => state,
    getAllocation: (id) => id === allocation.id ? allocation : undefined,
    getActiveRelease: () => release.id,
    isDraining: () => false,
    stateMaxAgeMs: 10_000,
    sourceMaxBytes: 1024,
    sourceMaxTotalBytes: 1024 * 1024,
    materializedMaxBytes: 4096,
    idempotencyTtlMs: 300_000,
    idempotencyLimit: 100,
    now: () => now,
    random: () => "context-test",
  });
  await controller.initialize();
  await controller.refreshRuntimeProbes();
  let upstreamBody = "";
  const control = {
    getBootEpoch: () => "boot",
    isDraining: () => false,
    getAllocation: (id: string) => id === allocation.id ? allocation : undefined,
    allocationLookupError: () => ({ status: 404, body: { error: { code: "not_found", message: "not found" } } }),
    resolveAllocation: () => ({
      status: 200,
      body: {
        allocationId: allocation.id,
        capability: "llm.reasoning",
        route: "route",
        runtime: runtime.id,
        node: "node",
        endpoint: runtime.deployment.endpoint,
        status: "HOT",
        expiresAt: allocation.expiresAt,
      },
    }),
    getAllocationSignal: () => undefined,
  } as unknown as ControlPlane;
  const app = createAppComponents({
    registry,
    getState: () => state,
    control,
    apiToken,
    contextController: controller,
    now: () => now,
    gatewayFetch: async (_input, init) => {
      upstreamBody = init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : String(init?.body ?? "");
      return new Response(JSON.stringify({
        id: "chatcmpl-context",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { "content-type": "application/json" } });
    },
  }).app;
  const headers = {
    authorization: `Bearer ${apiToken}`,
    "content-type": "application/json",
  };
  const registered = await app.request("/v1/contexts", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "register-1" },
    body: JSON.stringify({
      id: "ctx-a",
      version: "v1",
      sourceHandle: "source-a",
      sourceDigest: provisioned.digest,
      classification: "internal",
      byteCount: provisioned.bytes,
      tokenCount: 20,
      tokenizerDigest: release.contextCertification!.tokenizerDigest,
    }),
  });
  expect(registered.status).toBe(201);
  const created = await app.request("/v1/context-views", {
    method: "POST",
    headers: { ...headers, "idempotency-key": "view-1" },
    body: JSON.stringify({
      allocationId: allocation.id,
      runtime: runtime.id,
      baseInputTokens: 10,
      maxInputTokens: 800,
      deadline: "2026-09-09T00:05:00.000Z",
      canonicalizationVersion: "context-view-v1",
      items: [{ contextId: "ctx-a", version: "v1", required: true, utility: 1 }],
    }),
  });
  expect(created.status).toBe(201);
  const view = await created.json() as { id: string; operationId: string };
  const pendingOperation = await app.request(`/v1/context-operations/${view.operationId}`, { headers });
  expect(pendingOperation.status).toBe(200);
  expect(await pendingOperation.json()).toMatchObject({ state: "pending", viewId: view.id });
  const completion = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      ...headers,
      "x-larm-allocation-id": allocation.id,
      "x-larm-capability": "llm.reasoning",
      "x-larm-context-view-id": view.id,
    },
    body: JSON.stringify({
      model: "test-model",
      messages: [
        { role: "system", content: "Answer briefly." },
        { role: "user", content: "When is deployment?" },
      ],
    }),
  });
  expect(completion.status).toBe(200);
  await completion.json();
  expect(upstreamBody).toContain("The deployment window is Tuesday.");
  expect(await (await app.request(`/v1/context-operations/${view.operationId}`, { headers })).json())
    .toMatchObject({ state: "succeeded", outcome: "source_rebuild_materialized" });
  expect((JSON.parse(upstreamBody) as { messages: Array<{ role: string; content: string }> }).messages)
    .toMatchObject([
      { role: "system", content: expect.stringContaining("Answer briefly.") },
      { role: "user", content: "When is deployment?" },
    ]);
  const replay = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      ...headers,
      "x-larm-allocation-id": allocation.id,
      "x-larm-capability": "llm.reasoning",
      "x-larm-context-view-id": view.id,
    },
    body: JSON.stringify({ model: "test-model", messages: [] }),
  });
  expect(replay.status).toBe(409);
  expect((await app.request("/v1/contexts/ctx-a", { method: "DELETE", headers })).status).toBe(400);
  expect((await app.request("/v1/contexts/ctx-a", {
    method: "DELETE",
    headers: { ...headers, "idempotency-key": "delete-1" },
  })).status).toBe(204);
  expect(await replay.json()).toMatchObject({ error: { code: "context_view_consumed" } });
});
