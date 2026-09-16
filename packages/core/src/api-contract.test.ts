import { expect, test } from "bun:test";
import {
  API_OPERATIONS,
  chatCompletionRequestSchema,
  createOpenApiDocument,
  errorResponseSchema,
  httpProviderSoakEvidenceSchema,
  legacyPrepareResponseSchema,
  legacyReleaseResponseSchema,
  legacyResolveResponseSchema,
  openApiDocumentSchema,
  publicClusterStateSchema,
  publicRuntimeSchema,
} from "./api-contract";
import { saaaServiceHarnessSchema } from "./service-harness";

test("OpenAPI is generated from the public contract schemas", () => {
  const document = createOpenApiDocument("test") as {
    openapi: string;
    paths: Record<string, Record<string, { operationId: string }>>;
    components: { schemas: Record<string, unknown> };
  };
  expect(document.openapi).toBe("3.1.0");
  expect(openApiDocumentSchema.parse(document).openapi).toBe("3.1.0");
  expect(document.components.schemas.Allocation).toBeDefined();
  expect(document.components.schemas.RuntimeReleaseSelection).toBeDefined();
  expect(document.components.schemas.RuntimeReleasePlanRequest).toBeDefined();
  expect(document.components.schemas.RuntimeList).toBeDefined();
  expect(document.components.schemas.PublicClusterState).toBeDefined();
  expect(document.components.schemas.InspectionRuntimeList).toBeDefined();
  expect(document.components.schemas.AgentConnection).toBeDefined();
  expect(document.components.schemas.AgentConnectionHealth).toBeDefined();
  expect(document.components.schemas.ServiceHarness).toBeDefined();
  expect(document.components.schemas.ServiceActivity).toBeDefined();
  expect(document.components.schemas.ChatCompletionRequest).toBeDefined();
  expect(document.components.schemas.AgentProfileListV3).toBeDefined();
  expect(document.components.schemas.EmbeddingRequest).toBeDefined();
  expect(document.components.schemas.EmbeddingResponse).toBeDefined();
  expect(document.components.schemas.ServerSentEvents).toBeDefined();
  const agentRequest = document.components.schemas.AgentConnectionRequest as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  expect(agentRequest.required).not.toContain("agentProfile");
  expect(agentRequest.properties).toHaveProperty("explicitAgentProfile");
  expect(JSON.stringify(document.components.schemas.AgentProfileList)).toContain("defaultAgentProfile");
  expect(JSON.stringify(document.components.schemas.AgentProfileList)).toContain("supportedCapabilities");
  expect(JSON.stringify(document.components.schemas.AgentProfileList)).not.toContain("streamingProtocol");
  expect(JSON.stringify(document.components.schemas.AgentProfileListV1)).not.toContain("defaultAgentProfile");
  expect(JSON.stringify(document.components.schemas.AgentProfileListV1)).not.toContain("selectionPolicy");
  const operationIds = API_OPERATIONS.map(([, , operationId]) => operationId);
  expect(new Set(operationIds).size).toBe(operationIds.length);
  for (const [method, path, operationId] of API_OPERATIONS) {
    expect(document.paths[path]?.[method]?.operationId).toBe(operationId);
    const operation = document.paths[path]?.[method] as unknown as {
      responses: Record<string, { content?: Record<string, unknown> }>;
    };
    const successResponses = Object.entries(operation.responses)
      .filter(([status]) => status.startsWith("2") || status === "101");
    expect(successResponses.length).toBeGreaterThan(0);
    for (const [status, response] of successResponses) {
      if (status === "101" || status === "204") expect(response.content).toBeUndefined();
      else expect(response.content).toBeDefined();
    }
  }
  const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
  expect(paths["/v1/allocations"]?.post?.requestBody).toBeDefined();
  expect(paths["/v1/inspection/state"]?.get?.security).toEqual([{
    bearerAuth: [],
    managementToken: [],
  }]);
  expect(JSON.stringify(paths["/health"]?.get)).toContain("#/components/schemas/Health");
  expect(Object.keys((paths["/health"]?.get?.responses as Record<string, unknown>))).toEqual([
    "200",
    "4XX",
    "5XX",
  ]);
  expect(JSON.stringify(paths["/prepare"]?.post)).toContain("#/components/schemas/LegacyPrepareResponse");
  expect(JSON.stringify(paths["/v1/deployments/{runtime}/plan"]?.post))
    .toContain("#/components/schemas/RuntimeReleasePlanRequest");
  expect(JSON.stringify(paths["/v1/chat/completions"]?.post)).toContain("text/event-stream");
  expect(JSON.stringify(paths["/v1/chat/completions"]?.post?.requestBody))
    .toContain("#/components/schemas/ChatCompletionRequest");
  expect(paths["/v1/agent-connections"]?.post?.parameters).toBeDefined();
  expect(paths["/v1/agent-profiles"]?.get?.security).toEqual([{}, { bearerAuth: [] }]);
  expect(paths["/v2/agent-profiles"]?.get?.security).toEqual([{}, { bearerAuth: [] }]);
  expect(paths["/v3/agent-profiles"]?.get?.security).toEqual([{}, { bearerAuth: [] }]);
  expect(paths["/v1/embed"]?.post?.security).toEqual([{ providerBearer: [] }]);
  expect(paths["/v1/context-sources"]?.post?.security).toEqual([{ providerBearer: [] }]);
  const sourceRequestBody = paths["/v1/context-sources"]?.post?.requestBody as
    | { content?: Record<string, unknown> }
    | undefined;
  expect(sourceRequestBody?.content).toHaveProperty(
    "text/plain; charset=utf-8",
  );
  expect(paths["/v2/context-views/{id}"]?.get?.security).toEqual([{ providerBearer: [] }]);
  expect(paths["/v1/contexts"]?.post?.security).toEqual([
    { bearerAuth: [] },
    { providerBearer: [] },
  ]);
  expect(paths["/v2/context-views"]?.post?.parameters).toBeDefined();
  expect(document.components.schemas.PersonalStateCapability).toBeDefined();
  expect(document.components.schemas.ForgetOperation).toBeDefined();
  expect(JSON.stringify(paths["/v1/embed"]?.post?.requestBody))
    .toContain("#/components/schemas/EmbeddingRequest");
  expect(paths["/v1/activity"]?.get?.security).toEqual([{}, { bearerAuth: [] }]);
  expect(JSON.stringify(paths["/v1/activity"]?.get)).toContain("#/components/schemas/ServiceActivity");
  const activityResponses = paths["/v1/activity"]?.get?.responses as Record<
    string,
    { headers?: Record<string, unknown> }
  >;
  expect(activityResponses["200"]?.headers?.["Cache-Control"]).toBeDefined();
  expect(activityResponses["503"]?.headers?.["Retry-After"]).toBeDefined();
  expect(activityResponses["4XX"]?.headers?.["Cache-Control"]).toBeDefined();
  expect(activityResponses["5XX"]?.headers?.["Cache-Control"]).toBeDefined();
  expect(paths["/v1/agent-connections"]?.post?.security).toEqual([{}, { bearerAuth: [] }]);
  expect(paths["/v1/services"]?.get?.security).toEqual([{}, { bearerAuth: [] }]);
  expect(paths["/v1/services/asr/health"]?.get?.security).toEqual([{}, { bearerAuth: [] }]);
  expect(paths["/v1/audio/transcriptions"]?.post?.security).toEqual([
    {},
    { bearerAuth: [] },
    { providerBearer: [] },
  ]);
  expect(paths["/v1/audio/voices"]?.get?.parameters).toEqual([{
    name: "model",
    in: "query",
    required: true,
    schema: { type: "string", minLength: 1 },
  }]);
  expect(paths["/v1/agent-connections/{id}"]?.get?.security).toEqual([{}, { bearerAuth: [] }]);
  expect(paths["/v1/agent-connections/{id}/health"]?.get?.security).toEqual([
    {},
    { bearerAuth: [] },
  ]);
  expect(paths["/v1/agent-connections/{id}/claim"]?.post?.security).toEqual([
    {},
    { bearerAuth: [] },
  ]);
  expect(paths["/v1/agent-connections/{id}/renew"]?.post?.security).toEqual([
    {},
    { bearerAuth: [] },
  ]);
  expect(paths["/v1/agent-connections/{id}"]?.delete?.security).toEqual([
    {},
    { bearerAuth: [] },
  ]);
  expect(paths["/v1/agent-connections/{id}/providers/{name}/health"]?.get?.security).toEqual([
    { bearerAuth: [] },
    { providerBearer: [] },
  ]);
  expect((paths["/v1/agent-connections/{id}"]?.delete?.responses as Record<string, unknown>)["204"])
    .not.toHaveProperty("content");
});

test("Chat Completions contract validates schema-constrained response formats", () => {
  const request = {
    model: "qwen-agent-worker",
    messages: [{ role: "user", content: "return a procedure" }],
    response_format: {
      type: "json_schema" as const,
      json_schema: {
        name: "procedure",
        strict: true,
        schema: {
          type: "object",
          required: ["steps"],
          properties: {
            steps: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };

  expect(chatCompletionRequestSchema.parse(request)).toEqual(request);
  expect(chatCompletionRequestSchema.safeParse({
    ...request,
    response_format: { type: "json_schema", json_schema: { name: "missing-schema" } },
  }).success).toBeFalse();
  expect(chatCompletionRequestSchema.safeParse({
    ...request,
    response_format: { type: "yaml" },
  }).success).toBeFalse();
});

test("SAAA Service Harness v2 schema accepts batch ASR and bounds streaming metadata", () => {
  const batch = {
    contractVersion: "saaa-service-harness.v2",
    revision: "revision-1",
    services: [{
      capability: "asr",
      protocol: "openai.audio-transcriptions.v1",
      baseUrl: "http://provider.test:9810/v1",
      model: "qwen3-asr-1.7b",
      language: "auto",
      healthUrl: "http://provider.test:9810/v1/services/asr/health",
    }],
  };
  expect(JSON.stringify(saaaServiceHarnessSchema.parse(batch))).toBe(JSON.stringify(batch));
  expect(() => saaaServiceHarnessSchema.parse({
    ...batch,
    services: [{ ...batch.services[0], streaming: { protocol: "invented" } }],
  })).toThrow();
});

test("public runtime and state schemas reject operational detail", () => {
  expect(publicRuntimeSchema.parse({
    id: "qwen-general",
    capability: ["llm.general"],
    protocol: "openai.chat-completions.v1",
    policy: { class: "resident" },
  }).id).toBe("qwen-general");
  expect(() => publicRuntimeSchema.parse({
    id: "qwen-general",
    capability: ["llm.general"],
    protocol: "openai.chat-completions.v1",
    policy: { class: "resident" },
    deployment: { endpoint: "http://127.0.0.1:8080" },
  })).toThrow();
  expect(() => publicClusterStateSchema.parse({
    generatedAt: "2026-08-29T00:00:00.000Z",
    online: true,
    node: { id: "local-node" },
    runtimes: [],
  })).toThrow();
});

test("legacy public success schemas are strict and round-trip current responses", () => {
  expect(legacyPrepareResponseSchema.parse({
    leaseId: "lease-1",
    operationId: "op-1",
    desired: ["llm.general"],
    ready: false,
    runtimes: ["qwen-general"],
  }).ready).toBeFalse();
  expect(legacyResolveResponseSchema.parse({
    runtime: "qwen-general",
    node: "local-node",
    endpoint: "http://127.0.0.1:8080",
    status: "HOT",
  }).runtime).toBe("qwen-general");
  expect(legacyReleaseResponseSchema.parse({
    released: true,
    leaseId: "lease-1",
    desired: [],
  }).released).toBeTrue();
  expect(() => legacyReleaseResponseSchema.parse({
    released: true,
    leaseId: "lease-1",
    desired: [],
    token: "must-not-pass",
  })).toThrow();
});

test("public error schema is strict while allowing bounded operational details", () => {
  expect(errorResponseSchema.parse({
    error: {
      code: "deployment_in_progress",
      message: "blocked",
      blockers: ["runtime_in_use"],
    },
  }).error.blockers).toEqual(["runtime_in_use"]);
  expect(() => errorResponseSchema.parse({
    error: { code: "bad", message: "bad", secret: "must-not-pass" },
  })).toThrow();
});

test("HTTP Provider soak evidence preserves failures for an exact generation", () => {
  const evidence = {
    schemaVersion: 1,
    kind: "http-provider-soak",
    ok: true,
    releaseCommit: "a".repeat(40),
    configRevision: "b".repeat(64),
    bootEpoch: "epoch-one",
    startedAt: "2026-09-06T00:00:00.000Z",
    lastAttemptAt: "2026-09-07T00:00:00.000Z",
    lastSuccessAt: "2026-09-07T00:00:00.000Z",
    durationSeconds: 86_400,
    sampleCount: 97,
    failureCount: 0,
    maxGapSeconds: 900,
  };
  expect(httpProviderSoakEvidenceSchema.parse(evidence).ok).toBeTrue();
  expect(() => httpProviderSoakEvidenceSchema.parse({
    ...evidence,
    failureCount: 1,
  })).toThrow();
  expect(() => httpProviderSoakEvidenceSchema.parse({
    ...evidence,
    sampleCount: 0,
  })).toThrow();
});
