import { createHash } from "node:crypto";
import { z } from "zod";
import type { RuntimeReleaseDefinition } from "./releases";
import {
  backendKindSchema,
  runtimeDefinitionSchema,
  runtimeProtocolSchema,
  runtimeStatusSchema,
  type RuntimeDefinition,
} from "./schema";

const identifierSchema = z.string().min(1).max(192).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const providerRevisionSchema = z.object({
  runtimeId: identifierSchema,
  runtimeRelease: identifierSchema,
  revision: digestSchema,
  backend: backendKindSchema,
  protocol: runtimeProtocolSchema,
  artifacts: z.array(identifierSchema).max(64),
  launchSpecDigest: digestSchema,
  resourceSpecDigest: digestSchema,
}).strict();

export const providerInstanceSchema = z.object({
  id: identifierSchema,
  runtimeId: identifierSchema,
  revision: digestSchema,
  generation: z.number().int().positive(),
  node: identifierSchema,
  endpoint: z.string().url(),
  backendEndpoint: z.string().url(),
  status: runtimeStatusSchema,
  createdAt: z.string().datetime(),
}).strict();

export type ProviderRevision = z.infer<typeof providerRevisionSchema>;
export type ProviderInstance = z.infer<typeof providerInstanceSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`larm-provider-${domain}-v1\0`)
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function compileProviderRevision(input: {
  runtime: RuntimeDefinition;
  release?: RuntimeReleaseDefinition;
  runtimeRelease?: string;
}): ProviderRevision {
  if (input.release !== undefined && input.runtimeRelease !== undefined) {
    throw new Error("release and runtimeRelease are mutually exclusive");
  }
  const runtime = runtimeDefinitionSchema.parse(input.runtime);
  if (input.release !== undefined && input.release.runtime !== runtime.id) {
    throw new Error(
      `runtime release ${input.release.id} belongs to ${input.release.runtime}, not ${runtime.id}`,
    );
  }
  const runtimeRelease = input.release?.id ?? input.runtimeRelease ?? "unmanaged";
  const artifacts = [...(input.release?.artifacts ?? runtime.artifacts ?? [])].sort();
  const launchSpec = {
    runtimeId: runtime.id,
    backend: runtime.backend,
    capability: [...runtime.capability].sort(),
    protocol: runtime.protocol,
    node: runtime.node,
    deployment: runtime.deployment,
    artifacts,
    providerConfigRevision: input.release?.providerConfigRevision ?? null,
    releaseDigest: input.release?.digest ?? null,
  };
  const resourceSpec = {
    resources: runtime.resources,
    context: runtime.context ?? null,
    embedding: runtime.embedding ?? null,
    policy: runtime.policy,
  };
  const launchSpecDigest = digest("launch-spec", launchSpec);
  const resourceSpecDigest = digest("resource-spec", resourceSpec);
  const revision = digest("revision", {
    runtimeRelease,
    launchSpecDigest,
    resourceSpecDigest,
  });
  return providerRevisionSchema.parse({
    runtimeId: runtime.id,
    runtimeRelease,
    revision,
    backend: runtime.backend,
    protocol: runtime.protocol,
    artifacts,
    launchSpecDigest,
    resourceSpecDigest,
  });
}

export function providerInstanceId(revision: ProviderRevision, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("provider instance generation must be a positive safe integer");
  }
  return `pinst-${revision.runtimeId}-${revision.revision.slice(0, 12)}-${generation}`;
}

export function managedWarmPolicy(runtime: RuntimeDefinition): {
  lifecycle: "managed";
  minInstances: number;
  idleTtlSeconds: number;
} {
  return {
    lifecycle: "managed",
    minInstances: runtime.policy.warm?.minInstances
      ?? (runtime.policy.class === "resident" ? 1 : 0),
    idleTtlSeconds: runtime.policy.warm?.idleTtlSeconds ?? 60,
  };
}
