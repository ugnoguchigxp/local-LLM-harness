import { z } from "zod";

export const runtimeClassSchema = z.enum(["resident", "preferred", "elastic"]);
export const backendKindSchema = z.enum(["nssm", "llama-swap"]);
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

export const nssmDeploymentSchema = z.object({
  service: z.string().min(1),
  proxyService: z.string().min(1).optional(),
  healthPort: z.number().int().min(1).max(65535),
  endpoint: z.string().min(1),
  backendEndpoint: z.string().min(1).optional(),
});

export const llamaSwapDeploymentSchema = z.object({
  modelId: z.string().min(1),
  listen: z.string().min(1),
  endpoint: z.string().min(1),
  backendEndpoint: z.string().min(1).optional(),
});

export const nssmRuntimeYamlSchema = z.object({
  backend: z.literal("nssm"),
  ...runtimeShared,
  deployment: nssmDeploymentSchema,
});

export const llamaSwapRuntimeYamlSchema = z.object({
  backend: z.literal("llama-swap"),
  ...runtimeShared,
  deployment: llamaSwapDeploymentSchema,
});

export const runtimeYamlSchema = z.discriminatedUnion("backend", [
  nssmRuntimeYamlSchema,
  llamaSwapRuntimeYamlSchema,
]);

export const nssmRuntimeDefinitionSchema = nssmRuntimeYamlSchema.extend({
  id: z.string().min(1),
});

export const llamaSwapRuntimeDefinitionSchema = llamaSwapRuntimeYamlSchema.extend({
  id: z.string().min(1),
});

export const runtimeDefinitionSchema = z.discriminatedUnion("backend", [
  nssmRuntimeDefinitionSchema,
  llamaSwapRuntimeDefinitionSchema,
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

export const nodesFileSchema = z.object({
  nodes: z.record(z.string(), nodeYamlSchema),
});

export const runtimesFileSchema = z.object({
  runtimes: z.record(z.string(), runtimeYamlSchema),
});

export const profilesFileSchema = z.object({
  profiles: z.record(z.string(), profileYamlSchema),
});

export type RuntimeClass = z.infer<typeof runtimeClassSchema>;
export type BackendKind = z.infer<typeof backendKindSchema>;
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export type ServiceState = z.infer<typeof serviceStateSchema>;
export type NodeDefinition = z.infer<typeof nodeDefinitionSchema>;
export type NssmRuntimeDefinition = z.infer<typeof nssmRuntimeDefinitionSchema>;
export type LlamaSwapRuntimeDefinition = z.infer<typeof llamaSwapRuntimeDefinitionSchema>;
export type RuntimeDefinition = z.infer<typeof runtimeDefinitionSchema>;
export type WorkloadProfile = z.infer<typeof workloadProfileSchema>;
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
export type ClusterState = z.infer<typeof clusterStateSchema>;

export function isNssmRuntime(runtime: RuntimeDefinition): runtime is NssmRuntimeDefinition {
  return runtime.backend === "nssm";
}

export function isLlamaSwapRuntime(
  runtime: RuntimeDefinition,
): runtime is LlamaSwapRuntimeDefinition {
  return runtime.backend === "llama-swap";
}
