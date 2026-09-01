import { expect, test } from "bun:test";
import {
  API_OPERATIONS,
  createOpenApiDocument,
  errorResponseSchema,
  legacyPrepareResponseSchema,
  legacyReleaseResponseSchema,
  legacyResolveResponseSchema,
  openApiDocumentSchema,
  publicClusterStateSchema,
  publicRuntimeSchema,
} from "./api-contract";

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
  const agentRequest = document.components.schemas.AgentConnectionRequest as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  expect(agentRequest.required).not.toContain("agentProfile");
  expect(agentRequest.properties).toHaveProperty("explicitAgentProfile");
  expect(JSON.stringify(document.components.schemas.AgentProfileList)).toContain("defaultAgentProfile");
  expect(JSON.stringify(document.components.schemas.AgentProfileList)).toContain("supportedCapabilities");
  expect(JSON.stringify(document.components.schemas.AgentProfileList)).toContain("streamingProtocol");
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
  expect(paths["/v1/catalog/reload"]?.post?.security).toEqual([{
    bearerAuth: [],
    managementToken: [],
  }]);
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
  expect(JSON.stringify(paths["/v1/chat/completions"]?.post)).not.toContain("text/event-stream");
  expect(paths["/v1/llm/stream"]?.get?.responses).toHaveProperty("101");
  expect(paths["/v1/agent-connections"]?.post?.parameters).toBeDefined();
  expect(paths["/v1/agent-profiles"]?.get?.security).toEqual([{}, { bearerAuth: [] }]);
  expect(paths["/v2/agent-profiles"]?.get?.security).toEqual([{}, { bearerAuth: [] }]);
  expect(paths["/v1/agent-connections"]?.post?.security).toEqual([{}, { bearerAuth: [] }]);
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
      code: "catalog_reload_blocked",
      message: "blocked",
      blockers: ["active_allocations"],
    },
  }).error.blockers).toEqual(["active_allocations"]);
  expect(() => errorResponseSchema.parse({
    error: { code: "bad", message: "bad", secret: "must-not-pass" },
  })).toThrow();
});
