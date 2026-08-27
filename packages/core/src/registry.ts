import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  nodesFileSchema,
  profilesFileSchema,
  runtimesFileSchema,
  type NodeDefinition,
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
  }

  const profiles: WorkloadProfile[] = Object.entries(profilesParsed.data.profiles)
    .map(([id, profile]) => ({ id, ...profile }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { nodes, runtimes, profiles };
}

export function loadRegistry(configDir: string): Registry {
  return parseRegistryDocuments({
    nodesYaml: readYamlFile(join(configDir, "nodes.yaml")),
    runtimesYaml: readYamlFile(join(configDir, "runtimes.yaml")),
    profilesYaml: readYamlFile(join(configDir, "profiles.yaml")),
  });
}

export function getRuntime(registry: Registry, id: string): RuntimeDefinition | undefined {
  return registry.runtimes.find((runtime) => runtime.id === id);
}

export function getNode(registry: Registry, id: string): NodeDefinition | undefined {
  return registry.nodes.find((node) => node.id === id);
}
