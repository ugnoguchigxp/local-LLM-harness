import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  nodesFileSchema,
  profilesFileSchema,
  routesFileSchema,
  runtimesFileSchema,
  type NodeDefinition,
  type RouteDefinition,
  type RuntimeDefinition,
  type WorkloadProfile,
} from "./schema";

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export type Registry = {
  nodes: NodeDefinition[];
  runtimes: RuntimeDefinition[];
  profiles: WorkloadProfile[];
  routes: RouteDefinition[];
};

function readYamlFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RegistryError(`failed to read ${path}: ${detail}`);
  }
  try {
    return parseYaml(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new RegistryError(`invalid YAML in ${path}: ${detail}`);
  }
}

function formatZodError(file: string, err: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const parts = err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  return `${file}: ${parts.join("; ")}`;
}

export function parseRegistryDocuments(input: {
  nodesYaml: unknown;
  runtimesYaml: unknown;
  profilesYaml: unknown;
  routesYaml: unknown;
}): Registry {
  const nodesParsed = nodesFileSchema.safeParse(input.nodesYaml);
  if (!nodesParsed.success) {
    throw new RegistryError(formatZodError("nodes.yaml", nodesParsed.error));
  }
  const runtimesParsed = runtimesFileSchema.safeParse(input.runtimesYaml);
  if (!runtimesParsed.success) {
    throw new RegistryError(formatZodError("runtimes.yaml", runtimesParsed.error));
  }
  const profilesParsed = profilesFileSchema.safeParse(input.profilesYaml);
  if (!profilesParsed.success) {
    throw new RegistryError(formatZodError("profiles.yaml", profilesParsed.error));
  }
  const routesParsed = routesFileSchema.safeParse(input.routesYaml);
  if (!routesParsed.success) {
    throw new RegistryError(formatZodError("routes.yaml", routesParsed.error));
  }

  const nodes: NodeDefinition[] = Object.entries(nodesParsed.data.nodes)
    .map(([id, node]) => ({ id, ...node }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (nodes.length === 0) {
    throw new RegistryError("nodes.yaml: at least one node is required");
  }

  const nodeIds = new Set(nodes.map((n) => n.id));

  const runtimes: RuntimeDefinition[] = Object.entries(runtimesParsed.data.runtimes)
    .map(([id, runtime]) => ({ id, ...runtime }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (runtimes.length === 0) {
    throw new RegistryError("runtimes.yaml: at least one runtime is required");
  }

  for (const runtime of runtimes) {
    if (!nodeIds.has(runtime.node)) {
      throw new RegistryError(
        `runtimes.yaml: runtime ${runtime.id} references unknown node ${runtime.node}`,
      );
    }
    const compatible = runtime.capability.every((capability) => {
      if (runtime.protocol === "openai.chat-completions.v1") {
        return capability.startsWith("llm.");
      }
      if (runtime.protocol === "openai.audio-transcriptions.v1") {
        return capability === "speech.stt";
      }
      return capability.startsWith("speech.tts");
    });
    if (!compatible) {
      throw new RegistryError(
        `runtimes.yaml: runtime ${runtime.id} has capabilities incompatible with ${runtime.protocol}`,
      );
    }
  }

  for (const node of nodes) {
    const residentMemoryGB = runtimes
      .filter((runtime) => runtime.node === node.id && runtime.policy.class === "resident")
      .reduce((total, runtime) => total + runtime.resources.estimatedMemoryGB, 0);
    const usableMemoryGB =
      node.resources.memoryTotalGB - node.resources.reservedMemoryGB;
    if (residentMemoryGB > usableMemoryGB) {
      throw new RegistryError(
        `runtimes.yaml: resident runtimes on node ${node.id} require ${residentMemoryGB}GB but only ${usableMemoryGB}GB is usable`,
      );
    }
  }

  const profiles: WorkloadProfile[] = Object.entries(profilesParsed.data.profiles)
    .map(([id, profile]) => ({ id, ...profile }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  const defaultRouteByCapability = new Map<string, string>();
  const routes: RouteDefinition[] = Object.entries(routesParsed.data.routes)
    .map(([id, route]) => ({ id, ...route }))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const route of routes) {
    const capabilities = new Set(route.capabilities);
    if (capabilities.size !== route.capabilities.length) {
      throw new RegistryError(`routes.yaml: route ${route.id} contains duplicate capabilities`);
    }

    const candidateIds = new Set<string>();
    let sawFallback = false;
    for (const [index, candidate] of route.candidates.entries()) {
      if (candidateIds.has(candidate.runtime)) {
        throw new RegistryError(
          `routes.yaml: route ${route.id} contains duplicate runtime ${candidate.runtime}`,
        );
      }
      candidateIds.add(candidate.runtime);

      if (candidate.purpose === "fallback") {
        sawFallback = true;
      } else if (sawFallback) {
        throw new RegistryError(
          `routes.yaml: route ${route.id} has a primary candidate after a fallback`,
        );
      }
      if (index === 0 && candidate.purpose !== "primary") {
        throw new RegistryError(
          `routes.yaml: route ${route.id} must start with a primary candidate`,
        );
      }

      const runtime = runtimeById.get(candidate.runtime);
      if (!runtime) {
        throw new RegistryError(
          `routes.yaml: route ${route.id} references unknown runtime ${candidate.runtime}`,
        );
      }
      const unsupported = route.capabilities.filter(
        (capability) => !runtime.capability.includes(capability),
      );
      if (unsupported.length > 0) {
        throw new RegistryError(
          `routes.yaml: runtime ${candidate.runtime} does not provide ${unsupported.join(", ")} for route ${route.id}`,
        );
      }
    }

    if (!route.explicitOnly) {
      for (const capability of route.capabilities) {
        const existing = defaultRouteByCapability.get(capability);
        if (existing) {
          throw new RegistryError(
            `routes.yaml: capability ${capability} has multiple default routes: ${existing}, ${route.id}`,
          );
        }
        defaultRouteByCapability.set(capability, route.id);
      }
    }
  }

  return { nodes, runtimes, profiles, routes };
}

export function loadRegistry(configDir: string): Registry {
  return parseRegistryDocuments({
    nodesYaml: readYamlFile(join(configDir, "nodes.yaml")),
    runtimesYaml: readYamlFile(join(configDir, "runtimes.yaml")),
    profilesYaml: readYamlFile(join(configDir, "profiles.yaml")),
    routesYaml: readYamlFile(join(configDir, "routes.yaml")),
  });
}

export function getRuntime(registry: Registry, id: string): RuntimeDefinition | undefined {
  return registry.runtimes.find((runtime) => runtime.id === id);
}

export function getNode(registry: Registry, id: string): NodeDefinition | undefined {
  return registry.nodes.find((node) => node.id === id);
}
