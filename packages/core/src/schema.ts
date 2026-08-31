import { z } from "zod";
import { isLiteralLoopbackHost } from "./saaa-llm-stream";

const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const httpUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}, "must use http or https without credentials, query, or fragment");

export const runtimeClassSchema = z.enum(["resident", "preferred", "elastic"]);
export const backendKindSchema = z.enum(["llama-swap", "systemd"]);
export const routeCandidatePurposeSchema = z.enum(["primary", "fallback"]);
export const runtimeProtocolSchema = z.enum([
  "openai.chat-completions.v1",
  "openai.audio-transcriptions.v1",
  "openai.audio-speech.v1",
]);

const nativeWebSocketUrlSchema = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = isLiteralLoopbackHost(hostname);
    return (url.protocol === "wss:" || (url.protocol === "ws:" && loopback))
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}, "must use wss, or ws on literal loopback, without credentials, query, or fragment");

export const runtimeStreamingSchema = z.object({
  protocol: z.literal("saaa.llm-stream.v1"),
  upstreamUrl: nativeWebSocketUrlSchema,
  upstreamProtocol: z.literal("larm.native-llm-stream.v1"),
  upstreamTransport: z.literal("native"),
  maxConcurrentRuns: z.number().int().min(1).max(8),
  maxConnections: z.number().int().min(1).max(8),
  resumeWindowMs: z.number().int().min(120_000).max(3_600_000),
}).strict().refine(
  (value) => value.maxConnections === value.maxConcurrentRuns,
  { message: "maxConnections must equal maxConcurrentRuns", path: ["maxConnections"] },
);
export const runtimeStatusSchema = z.enum([
  "COLD",
  "STARTING",
  "HOT",
  "BUSY",
  "STOPPING",
  "FAILED",
]);

export const serviceStateSchema = z.enum([
  "Running",
  "Stopped",
  "NotFound",
  "Unknown",
]);

const uniqueStringList = z
  .array(identifierSchema)
  .min(1)
  .max(64)
  .refine((items) => new Set(items).size === items.length, "items must be unique");

export const nodeResourcesSchema = z.object({
  memoryTotalGB: z.number().positive(),
  reservedMemoryGB: z.number().nonnegative(),
}).strict().refine(
  (resources) => resources.reservedMemoryGB <= resources.memoryTotalGB,
  { message: "reservedMemoryGB must not exceed memoryTotalGB", path: ["reservedMemoryGB"] },
);

export const nodeDefinitionSchema = z.object({
  id: identifierSchema,
  displayName: z.string().max(256).optional(),
  endpoint: httpUrlSchema,
  resources: nodeResourcesSchema,
}).strict();

const runtimeShared = {
  capability: uniqueStringList,
  protocol: runtimeProtocolSchema,
  artifacts: uniqueStringList.optional(),
  node: identifierSchema,
  policy: z.object({
    class: runtimeClassSchema,
    swapGroup: identifierSchema.optional(),
  }).strict(),
  resources: z.object({
    estimatedMemoryGB: z.number().positive(),
    maxConcurrentAllocations: z.number().int().positive().optional(),
    maxConcurrentRequests: z.number().int().min(1).max(256),
    maxQueuedRequests: z.number().int().min(0).max(10_000),
    queueTimeoutMs: z.number().int().min(1).max(3_600_000),
  }).strict(),
  streaming: runtimeStreamingSchema.optional(),
};

export const llamaSwapDeploymentSchema = z.object({
  modelId: identifierSchema,
  listen: httpUrlSchema,
  endpoint: httpUrlSchema,
  backendEndpoint: httpUrlSchema.optional(),
}).strict();

export const systemdDeploymentSchema = z.object({
  service: z.string().max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/),
  healthPort: z.number().int().min(1).max(65535),
  healthPath: z.string().min(1).max(256).startsWith("/").optional(),
  endpoint: httpUrlSchema,
  backendEndpoint: httpUrlSchema.optional(),
}).strict();

export const llamaSwapRuntimeYamlSchema = z.object({
  backend: z.literal("llama-swap"),
  ...runtimeShared,
  deployment: llamaSwapDeploymentSchema,
}).strict();

export const systemdRuntimeYamlSchema = z.object({
  backend: z.literal("systemd"),
  ...runtimeShared,
  deployment: systemdDeploymentSchema,
}).strict();

function requireLlmStreamingProtocol(
  value: { protocol: z.infer<typeof runtimeProtocolSchema>; streaming?: z.infer<typeof runtimeStreamingSchema> },
  context: z.RefinementCtx,
): void {
  if (value.streaming && value.protocol !== "openai.chat-completions.v1") {
    context.addIssue({
      code: "custom",
      path: ["streaming"],
      message: "native LLM streaming requires openai.chat-completions.v1",
    });
  }
}

export const runtimeYamlSchema = z.discriminatedUnion("backend", [
  llamaSwapRuntimeYamlSchema,
  systemdRuntimeYamlSchema,
]).superRefine(requireLlmStreamingProtocol);

export const llamaSwapRuntimeDefinitionSchema = llamaSwapRuntimeYamlSchema.extend({
  id: identifierSchema,
});

export const systemdRuntimeDefinitionSchema = systemdRuntimeYamlSchema.extend({
  id: identifierSchema,
});

export const runtimeDefinitionSchema = z.discriminatedUnion("backend", [
  llamaSwapRuntimeDefinitionSchema,
  systemdRuntimeDefinitionSchema,
]).superRefine(requireLlmStreamingProtocol);

export const workloadProfileSchema = z.object({
  id: identifierSchema,
  require: uniqueStringList,
}).strict();

export const runtimeSnapshotHealthSchema = z.object({
  httpStatus: z.number().optional(),
  ok: z.boolean(),
  detail: z.string().optional(),
}).strict();

export const runtimeSnapshotSchema = z.object({
  id: identifierSchema,
  status: runtimeStatusSchema,
  class: runtimeClassSchema,
  capability: uniqueStringList,
  node: identifierSchema,
  backend: backendKindSchema,
  endpoint: httpUrlSchema,
  backendEndpoint: httpUrlSchema.optional(),
  service: z.string().min(1).max(256).optional(),
  observedAt: z.string().datetime(),
  health: runtimeSnapshotHealthSchema.optional(),
}).strict();

export const nodeTelemetrySchema = z.object({
  status: z.enum(["available", "unavailable"]),
  observedAt: z.string().datetime(),
  systemMemoryTotalBytes: z.number().int().nonnegative().optional(),
  systemMemoryAvailableBytes: z.number().int().nonnegative().optional(),
  acceleratorMemoryTotalBytes: z.number().int().nonnegative().optional(),
  acceleratorMemoryAvailableBytes: z.number().int().nonnegative().optional(),
  source: z.string().min(1).max(64),
  detail: z.string().min(1).max(512).optional(),
}).strict().superRefine((value, context) => {
  if (
    value.status === "available"
    && (value.systemMemoryTotalBytes === undefined || value.systemMemoryAvailableBytes === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "available telemetry requires system memory totals",
    });
  }
});

export const clusterStateSchema = z.object({
  generatedAt: z.string().datetime(),
  node: z.object({
    id: identifierSchema,
    displayName: z.string().optional(),
    online: z.boolean(),
    endpoint: httpUrlSchema,
    resources: nodeResourcesSchema,
    telemetry: nodeTelemetrySchema.optional(),
  }).strict(),
  runtimes: z.array(runtimeSnapshotSchema),
}).strict();

export const nodeYamlSchema = nodeDefinitionSchema.omit({ id: true });
export const profileYamlSchema = workloadProfileSchema.omit({ id: true });

export const routeCandidateSchema = z.object({
  runtime: identifierSchema,
  purpose: routeCandidatePurposeSchema,
}).strict();

const routeShared = {
  capabilities: uniqueStringList,
  explicitOnly: z.boolean().default(false),
  candidates: z.array(routeCandidateSchema).min(1).max(64),
};

export const routeYamlSchema = z.object(routeShared).strict();
export const routeDefinitionSchema = z.object({
  id: identifierSchema,
  ...routeShared,
}).strict();

export const nodesFileSchema = z.object({
  nodes: z.record(identifierSchema, nodeYamlSchema),
}).strict();

export const runtimesFileSchema = z.object({
  runtimes: z.record(identifierSchema, runtimeYamlSchema),
}).strict();

export const profilesFileSchema = z.object({
  profiles: z.record(identifierSchema, profileYamlSchema),
}).strict();

export const routesFileSchema = z.object({
  routes: z.record(identifierSchema, routeYamlSchema),
}).strict();

export type RuntimeClass = z.infer<typeof runtimeClassSchema>;
export type BackendKind = z.infer<typeof backendKindSchema>;
export type RouteCandidatePurpose = z.infer<typeof routeCandidatePurposeSchema>;
export type RuntimeProtocol = z.infer<typeof runtimeProtocolSchema>;
export type RuntimeStreaming = z.infer<typeof runtimeStreamingSchema>;
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export type ServiceState = z.infer<typeof serviceStateSchema>;
export type NodeDefinition = z.infer<typeof nodeDefinitionSchema>;
export type LlamaSwapRuntimeDefinition = z.infer<typeof llamaSwapRuntimeDefinitionSchema>;
export type SystemdRuntimeDefinition = z.infer<typeof systemdRuntimeDefinitionSchema>;
export type RuntimeDefinition = z.infer<typeof runtimeDefinitionSchema>;
export type WorkloadProfile = z.infer<typeof workloadProfileSchema>;
export type RouteCandidate = z.infer<typeof routeCandidateSchema>;
export type RouteDefinition = z.infer<typeof routeDefinitionSchema>;
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
export type NodeTelemetry = z.infer<typeof nodeTelemetrySchema>;
export type ClusterState = z.infer<typeof clusterStateSchema>;

export function isLlamaSwapRuntime(
  runtime: RuntimeDefinition,
): runtime is LlamaSwapRuntimeDefinition {
  return runtime.backend === "llama-swap";
}

export function isSystemdRuntime(
  runtime: RuntimeDefinition,
): runtime is SystemdRuntimeDefinition {
  return runtime.backend === "systemd";
}
