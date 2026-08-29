import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { deploymentPolicySchema } from "./api-schema";
import type { Registry } from "./registry";
import { runtimeProtocolSchema, type RuntimeProtocol } from "./schema";

export const agentIdentifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const agentReadinessKindSchema = z.enum([
  "llm-inference",
  "stt-transcription",
  "tts-speech",
]);

export const agentAudienceNetworkSchema = z.enum([
  "loopback",
  "host-private",
  "tls",
]);

function canonicalGatewayUrl(value: string, network: z.infer<typeof agentAudienceNetworkSchema>): boolean {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
      || url.pathname !== "/v1"
      || value.endsWith("/")
    ) {
      return false;
    }
    const isLoopback = new Set(["127.0.0.1", "::1", "localhost"]).has(url.hostname);
    if (network === "loopback") return isLoopback;
    if (isLoopback) return false;
    return network !== "tls" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const agentAudienceYamlSchema = z.object({
  network: agentAudienceNetworkSchema,
  baseUrl: z.string().min(1).max(2048),
}).strict().superRefine((value, context) => {
  if (!canonicalGatewayUrl(value.baseUrl, value.network)) {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl is not canonical for network" });
  }
});

const agentProviderYamlSchema = z.object({
  name: agentIdentifierSchema,
  capability: agentIdentifierSchema,
  route: agentIdentifierSchema,
  publicModel: agentIdentifierSchema,
  readiness: agentReadinessKindSchema,
}).strict();

const agentProfileYamlSchema = z.object({
  description: z.string().min(1).max(256),
  providers: z.array(agentProviderYamlSchema).min(1).max(8),
}).strict().superRefine((value, context) => {
  for (const field of ["name", "capability", "publicModel"] as const) {
    const seen = new Set<string>();
    for (const [index, provider] of value.providers.entries()) {
      if (seen.has(provider[field])) {
        context.addIssue({
          code: "custom",
          path: ["providers", index, field],
          message: `${field} must be unique within a profile`,
        });
      }
      seen.add(provider[field]);
    }
  }
});

export const agentConnectionsFileSchema = z.object({
  version: z.literal(1),
  audiences: z.record(agentIdentifierSchema, agentAudienceYamlSchema),
  agentProfiles: z.record(agentIdentifierSchema, agentProfileYamlSchema),
}).strict();

export type AgentReadinessKind = z.infer<typeof agentReadinessKindSchema>;
export type AgentAudienceNetwork = z.infer<typeof agentAudienceNetworkSchema>;

export type AgentAudience = {
  id: string;
  network: AgentAudienceNetwork;
  baseUrl: string;
  revision: string;
};

export type AgentProviderProfile = {
  name: string;
  capability: string;
  route: string;
  publicModel: string;
  readiness: AgentReadinessKind;
  protocol: RuntimeProtocol;
};

export type AgentProfile = {
  id: string;
  description: string;
  providers: AgentProviderProfile[];
  revision: string;
};

export type AgentConnectionCatalog = {
  version: 1;
  audiences: AgentAudience[];
  profiles: AgentProfile[];
};

export class AgentConnectionCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConnectionCatalogError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function expectedReadiness(protocol: RuntimeProtocol): AgentReadinessKind {
  if (protocol === "openai.chat-completions.v1") return "llm-inference";
  if (protocol === "openai.audio-transcriptions.v1") return "stt-transcription";
  return "tts-speech";
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

export function parseAgentConnectionCatalog(input: unknown, registry: Registry): AgentConnectionCatalog {
  const parsed = agentConnectionsFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new AgentConnectionCatalogError(`agent-connections.yaml: ${formatZodError(parsed.error)}`);
  }
  if (Object.keys(parsed.data.audiences).length === 0) {
    throw new AgentConnectionCatalogError("agent-connections.yaml: at least one audience is required");
  }
  if (Object.keys(parsed.data.agentProfiles).length === 0) {
    throw new AgentConnectionCatalogError("agent-connections.yaml: at least one profile is required");
  }

  const runtimes = new Map(registry.runtimes.map((runtime) => [runtime.id, runtime]));
  const routes = new Map(registry.routes.map((route) => [route.id, route]));
  const profiles = Object.entries(parsed.data.agentProfiles).map(([id, profile]) => {
    const providers = profile.providers.map((provider) => {
      const route = routes.get(provider.route);
      if (!route) {
        throw new AgentConnectionCatalogError(`agent profile ${id} references unknown route ${provider.route}`);
      }
      if (!route.capabilities.includes(provider.capability)) {
        throw new AgentConnectionCatalogError(
          `agent profile ${id} route ${provider.route} does not advertise ${provider.capability}`,
        );
      }
      const protocols = new Set<RuntimeProtocol>();
      for (const candidate of route.candidates) {
        const runtime = runtimes.get(candidate.runtime);
        if (!runtime) {
          throw new AgentConnectionCatalogError(
            `agent profile ${id} route ${provider.route} has unknown runtime ${candidate.runtime}`,
          );
        }
        if (!runtime.capability.includes(provider.capability)) {
          throw new AgentConnectionCatalogError(
            `agent profile ${id} runtime ${runtime.id} does not advertise ${provider.capability}`,
          );
        }
        protocols.add(runtime.protocol);
      }
      if (protocols.size !== 1) {
        throw new AgentConnectionCatalogError(
          `agent profile ${id} route ${provider.route} candidates do not share one protocol`,
        );
      }
      const protocol = [...protocols][0]!;
      if (provider.readiness !== expectedReadiness(protocol)) {
        throw new AgentConnectionCatalogError(
          `agent profile ${id} provider ${provider.name} readiness does not match ${protocol}`,
        );
      }
      return { ...provider, protocol };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const normalized = { description: profile.description, providers };
    return { id, ...normalized, revision: digest(normalized) };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const audiences = Object.entries(parsed.data.audiences).map(([id, audience]) => ({
    id,
    ...audience,
    revision: digest(audience),
  })).sort((left, right) => left.id.localeCompare(right.id));

  return { version: 1, audiences, profiles };
}

export function loadAgentConnectionCatalogForRegistry(
  configDir: string,
  registry: Registry,
): AgentConnectionCatalog {
  const path = join(configDir, "agent-connections.yaml");
  try {
    return parseAgentConnectionCatalog(parseYaml(readFileSync(path, "utf8")), registry);
  } catch (error) {
    if (error instanceof AgentConnectionCatalogError) throw error;
    throw new AgentConnectionCatalogError(
      `failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const agentConnectionStatusSchema = z.enum([
  "pending",
  "probing",
  "ready",
  "failed",
  "released",
  "expired",
]);

export const agentProviderReadinessStatusSchema = agentConnectionStatusSchema;

export const agentConnectionRequestSchema = z.object({
  agentProfile: agentIdentifierSchema,
  audience: agentIdentifierSchema,
  client: agentIdentifierSchema.optional(),
  ttlSeconds: z.number().int().min(1).max(86_400).default(300),
  allowFallback: z.boolean().default(false),
  deploymentPolicy: deploymentPolicySchema.default("existing-only"),
}).strict();

export const agentConnectionRenewRequestSchema = z.object({
  ttlSeconds: z.number().int().min(1).max(86_400).default(300),
}).strict();

export const agentConnectionClaimRequestSchema = z.object({
  format: z.literal("openai-provider-v1"),
}).strict();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const publicAgentProfileListSchema = z.object({
  contractVersion: z.literal("agent-connection.v1"),
  catalogRevision: z.string().min(1).max(128),
  profiles: z.array(z.object({
    id: agentIdentifierSchema,
    description: z.string().min(1).max(256),
    providers: z.array(z.object({
      name: agentIdentifierSchema,
      capability: agentIdentifierSchema,
      protocol: runtimeProtocolSchema,
      model: agentIdentifierSchema,
    }).strict()).min(1).max(8),
  }).strict()),
  audiences: z.array(agentIdentifierSchema),
}).strict();

export const publicAgentConnectionProviderSchema = z.object({
  name: agentIdentifierSchema,
  capability: agentIdentifierSchema,
  route: agentIdentifierSchema,
  protocol: runtimeProtocolSchema,
  publicModel: agentIdentifierSchema,
  readiness: agentProviderReadinessStatusSchema,
  claimable: z.boolean(),
}).strict();

export const publicAgentConnectionSchema = z.object({
  id: z.string().min(1).max(192),
  allocationId: z.string().min(1).max(192),
  bootEpoch: z.string().min(1).max(128),
  catalogRevision: z.string().min(1).max(128),
  agentProfile: agentIdentifierSchema,
  profileRevision: sha256Schema,
  audience: agentIdentifierSchema,
  audienceRevision: sha256Schema,
  status: agentConnectionStatusSchema,
  providers: z.array(publicAgentConnectionProviderSchema).min(1).max(8),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  releasedAt: z.string().datetime().optional(),
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(512),
  }).strict().optional(),
}).strict();

export const agentProviderHealthReasonSchema = z.enum([
  "connection_not_ready",
  "allocation_inactive",
  "stale_state",
  "binding_changed",
  "provider_busy",
  "probe_timeout",
  "upstream_status",
  "invalid_response",
]);

export const agentProviderHealthSchema = z.object({
  name: agentIdentifierSchema,
  capability: agentIdentifierSchema,
  ready: z.boolean(),
  acceptingRequests: z.boolean(),
  reason: agentProviderHealthReasonSchema.optional(),
  probe: z.object({
    kind: z.literal("semantic-inference"),
    protocol: runtimeProtocolSchema,
    release: agentIdentifierSchema.optional(),
    latencyMs: z.number().int().nonnegative(),
    validated: z.literal(true),
    cached: z.boolean(),
    observedAt: z.string().datetime(),
  }).strict().optional(),
}).strict();

export const agentConnectionHealthSchema = z.object({
  id: z.string().min(1).max(192),
  status: agentConnectionStatusSchema,
  ready: z.boolean(),
  acceptingRequests: z.boolean(),
  checkedAt: z.string().datetime(),
  providers: z.array(agentProviderHealthSchema).min(1).max(8),
}).strict();

export const agentProviderDescriptorSchema = z.object({
  name: agentIdentifierSchema,
  capability: agentIdentifierSchema,
  apiStyle: z.literal("openai"),
  protocol: runtimeProtocolSchema,
  scheme: z.enum(["http", "https"]),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  baseUrl: z.string().url(),
  model: agentIdentifierSchema,
  health: z.object({
    url: z.string().url(),
    kind: z.literal("semantic-inference"),
    maxAgeMs: z.literal(10_000),
  }).strict(),
  credential: z.object({
    type: z.literal("bearer"),
    token: z.string().min(1).max(4096),
    expiresAt: z.string().datetime(),
  }).strict(),
  configuration: z.object({
    kind: z.literal("openai-provider-v1"),
    fields: z.object({
      baseURL: z.string().url(),
      model: agentIdentifierSchema,
    }).strict(),
    secretFields: z.object({ apiKey: z.literal("credential.token") }).strict(),
  }).strict(),
}).strict();

export const agentConnectionClaimSchema = z.object({
  id: z.string().min(1).max(192),
  allocationId: z.string().min(1).max(192),
  status: z.literal("ready"),
  audience: agentIdentifierSchema,
  providers: z.array(agentProviderDescriptorSchema).min(1).max(8),
  expiresAt: z.string().datetime(),
}).strict();

export type AgentConnectionRequest = z.infer<typeof agentConnectionRequestSchema>;
export type AgentConnectionRequestInput = z.input<typeof agentConnectionRequestSchema>;
export type AgentConnectionStatus = z.infer<typeof agentConnectionStatusSchema>;
export type PublicAgentConnection = z.infer<typeof publicAgentConnectionSchema>;
export type AgentConnectionHealth = z.infer<typeof agentConnectionHealthSchema>;
export type AgentProviderHealth = z.infer<typeof agentProviderHealthSchema>;
export type AgentConnectionClaim = z.infer<typeof agentConnectionClaimSchema>;
