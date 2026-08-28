import type {
  ClusterState,
  NodeDefinition,
  RuntimeDefinition,
  RuntimeSnapshot,
  RuntimeStatus,
} from "./schema";

export type SnapshotHealth = NonNullable<RuntimeSnapshot["health"]>;

export function buildRuntimeSnapshot(input: {
  runtime: RuntimeDefinition;
  status: RuntimeStatus;
  observedAt: string;
  health?: SnapshotHealth;
}): RuntimeSnapshot {
  return {
    id: input.runtime.id,
    status: input.status,
    class: input.runtime.policy.class,
    capability: input.runtime.capability,
    node: input.runtime.node,
    backend: input.runtime.backend,
    endpoint: input.runtime.deployment.endpoint,
    backendEndpoint: input.runtime.deployment.backendEndpoint,
    service:
      input.runtime.backend === "llama-swap"
        ? input.runtime.deployment.modelId
        : input.runtime.deployment.service,
    observedAt: input.observedAt,
    health: input.health,
  };
}

export function buildClusterState(input: {
  node: NodeDefinition;
  snapshots: RuntimeSnapshot[];
  generatedAt: string;
}): ClusterState {
  return {
    generatedAt: input.generatedAt,
    node: {
      id: input.node.id,
      displayName: input.node.displayName,
      online: true,
      endpoint: input.node.endpoint,
      resources: input.node.resources,
    },
    runtimes: input.snapshots,
  };
}

export function primaryNode(nodes: NodeDefinition[], runtimes: RuntimeDefinition[]): NodeDefinition {
  const preferredId = runtimes[0]?.node;
  const match = preferredId ? nodes.find((node) => node.id === preferredId) : undefined;
  const node = match ?? nodes[0];
  if (!node) {
    throw new Error("registry has no nodes");
  }
  return node;
}
