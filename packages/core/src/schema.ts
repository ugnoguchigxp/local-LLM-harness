import { z } from "zod";

const identifierSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const httpUrlSchema = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "must use http or https");

export const runtimeClassSchema = z.enum(["resident", "preferred", "elastic"]);
export const backendKindSchema = z.enum(["llama-swap", "systemd"]);
export const routeCandidatePurposeSchema = z.enum(["primary", "fallback"]);
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
  .array(z.string().min(1).max(128))
  .min(1)
  .max(64)
  .refine((items) => new Set(items).size === items.length, "items must be unique");

export const nodeResourcesSchema = z.object({
  memoryTotalGB: z.number().positive(),
  reservedMemoryGB: z.number().nonnegative(),
}).refine(
  (resources) => resources.reservedMemoryGB <= resources.memoryTotalGB,
  { message: "reservedMemoryGB must not exceed memoryTotalGB", path: ["reservedMemoryGB"] },
);

export const nodeDefinitionSchema = z.object({
  id: identifierSchema,
  displayName: z.string().max(256).optional(),
  endpoint: httpUrlSchema,
  resources: nodeResourcesSchema,
});

const runtimeShared = {
  capability: uniqueStringList,
  artifacts: uniqueStringList.optional(),
  node: identifierSchema,
  policy: z.object({
    class: runtimeClassSchema,
  }),
  resources: z.object({
    estimatedMemoryGB: z.number().positive(),
    maxConcurrentAllocations: z.number().int().positive().optional(),
  }),
};

export const llamaSwapDeploymentSchema = z.object({
  modelId: identifierSchema,
  listen: httpUrlSchema,
  endpoint: httpUrlSchema,
  backendEndpoint: httpUrlSchema.optional(),
});

export const systemdDeploymentSchema = z.object({
  service: z.string().max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/),
  healthPort: z.number().int().min(1).max(65535),
  healthPath: z.string().min(1).max(256).startsWith("/").optional(),
  endpoint: httpUrlSchema,
  backendEndpoint: httpUrlSchema.optional(),
});

export const llamaSwapRuntimeYamlSchema = z.object({
  backend: z.literal("llama-swap"),
  ...runtimeShared,
  deployment: llamaSwapDeploymentSchema,
});

export const systemdRuntimeYamlSchema = z.object({
  backend: z.literal("systemd"),
  ...runtimeShared,
  deployment: systemdDeploymentSchema,
});

export const runtimeYamlSchema = z.discriminatedUnion("backend", [
  llamaSwapRuntimeYamlSchema,
  systemdRuntimeYamlSchema,
]);

export const llamaSwapRuntimeDefinitionSchema = llamaSwapRuntimeYamlSchema.extend({
  id: identifierSchema,
});

export const systemdRuntimeDefinitionSchema = systemdRuntimeYamlSchema.extend({
  id: identifierSchema,
});

export const runtimeDefinitionSchema = z.discriminatedUnion("backend", [
  llamaSwapRuntimeDefinitionSchema,
  systemdRuntimeDefinitionSchema,
]);

export const workloadProfileSchema = z.object({
  id: identifierSchema,
  require: uniqueStringList,
});

export const runtimeSnapshotHealthSchema = z.object({
  httpStatus: z.number().optional(),
  ok: z.boolean(),
  detail: z.string().optional(),
});

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
});

export const clusterStateSchema = z.object({
  generatedAt: z.string().datetime(),
  node: z.object({
    id: identifierSchema,
    displayName: z.string().optional(),
    online: z.boolean(),
    endpoint: httpUrlSchema,
    resources: nodeResourcesSchema,
  }),
  runtimes: z.array(runtimeSnapshotSchema),
});

export const nodeYamlSchema = nodeDefinitionSchema.omit({ id: true });
export const profileYamlSchema = workloadProfileSchema.omit({ id: true });

export const routeCandidateSchema = z.object({
  runtime: identifierSchema,
  purpose: routeCandidatePurposeSchema,
});

const routeShared = {
  capabilities: uniqueStringList,
  explicitOnly: z.boolean().default(false),
  candidates: z.array(routeCandidateSchema).min(1),
};

export const routeYamlSchema = z.object(routeShared);
export const routeDefinitionSchema = z.object({
  id: identifierSchema,
  ...routeShared,
});

export const nodesFileSchema = z.object({
  nodes: z.record(identifierSchema, nodeYamlSchema),
});

export const runtimesFileSchema = z.object({
  runtimes: z.record(identifierSchema, runtimeYamlSchema),
});

export const profilesFileSchema = z.object({
  profiles: z.record(identifierSchema, profileYamlSchema),
});

export const routesFileSchema = z.object({
  routes: z.record(identifierSchema, routeYamlSchema),
});

export type RuntimeClass = z.infer<typeof runtimeClassSchema>;
export type BackendKind = z.infer<typeof backendKindSchema>;
export type RouteCandidatePurpose = z.infer<typeof routeCandidatePurposeSchema>;
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
