import { z } from "zod";

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

export const nodeResourcesSchema = z.object({
  memoryTotalGB: z.number().positive(),
  reservedMemoryGB: z.number().nonnegative(),
});

export const nodeDefinitionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
  endpoint: z.string().min(1),
  resources: nodeResourcesSchema,
});

const runtimeShared = {
  capability: z.array(z.string().min(1)).min(1),
  node: z.string().min(1),
  policy: z.object({
    class: runtimeClassSchema,
  }),
  resources: z.object({
    estimatedMemoryGB: z.number().positive(),
  }),
};

export const llamaSwapDeploymentSchema = z.object({
  modelId: z.string().min(1),
  listen: z.string().min(1),
  endpoint: z.string().min(1),
  backendEndpoint: z.string().min(1).optional(),
});

export const systemdDeploymentSchema = z.object({
  service: z.string().min(1),
  healthPort: z.number().int().min(1).max(65535),
  healthPath: z.string().min(1).optional(),
  endpoint: z.string().min(1),
  backendEndpoint: z.string().min(1).optional(),
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
  id: z.string().min(1),
});

export const systemdRuntimeDefinitionSchema = systemdRuntimeYamlSchema.extend({
  id: z.string().min(1),
});

export const runtimeDefinitionSchema = z.discriminatedUnion("backend", [
  llamaSwapRuntimeDefinitionSchema,
  systemdRuntimeDefinitionSchema,
]);

export const workloadProfileSchema = z.object({
  id: z.string().min(1),
  require: z.array(z.string().min(1)).min(1),
});

export const runtimeSnapshotHealthSchema = z.object({
  httpStatus: z.number().optional(),
  ok: z.boolean(),
  detail: z.string().optional(),
});

export const runtimeSnapshotSchema = z.object({
  id: z.string().min(1),
  status: runtimeStatusSchema,
  class: runtimeClassSchema,
  capability: z.array(z.string()),
  node: z.string(),
  backend: z.string(),
  endpoint: z.string(),
  backendEndpoint: z.string().optional(),
  service: z.string().optional(),
  observedAt: z.string(),
  health: runtimeSnapshotHealthSchema.optional(),
});

export const clusterStateSchema = z.object({
  generatedAt: z.string(),
  node: z.object({
    id: z.string(),
    displayName: z.string().optional(),
    online: z.boolean(),
    endpoint: z.string(),
    resources: nodeResourcesSchema,
  }),
  runtimes: z.array(runtimeSnapshotSchema),
});

export const nodeYamlSchema = nodeDefinitionSchema.omit({ id: true });
export const profileYamlSchema = workloadProfileSchema.omit({ id: true });

export const routeCandidateSchema = z.object({
  runtime: z.string().min(1),
  purpose: routeCandidatePurposeSchema,
});

const routeShared = {
  capabilities: z.array(z.string().min(1)).min(1),
  explicitOnly: z.boolean().default(false),
  candidates: z.array(routeCandidateSchema).min(1),
};

export const routeYamlSchema = z.object(routeShared);
export const routeDefinitionSchema = z.object({
  id: z.string().min(1),
  ...routeShared,
});

export const nodesFileSchema = z.object({
  nodes: z.record(z.string(), nodeYamlSchema),
});

export const runtimesFileSchema = z.object({
  runtimes: z.record(z.string(), runtimeYamlSchema),
});

export const profilesFileSchema = z.object({
  profiles: z.record(z.string(), profileYamlSchema),
});

export const routesFileSchema = z.object({
  routes: z.record(z.string(), routeYamlSchema),
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
