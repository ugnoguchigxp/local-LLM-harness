import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { deploymentPolicySchema } from "./api-schema";
import type { Registry } from "./registry";
import { isLiteralLoopbackHost, saaaStreamAdvertisementSchema } from "./saaa-llm-stream";
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

export const agentAudienceRequestOrigin = "request-origin" as const;

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || isLiteralLoopbackHost(hostname);
}

function isUnspecifiedHostname(hostname: string): boolean {
  return hostname === "0.0.0.0" || hostname === "::";
}

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
    const hostname = normalizedHostname(url);
    const isLoopback = isLoopbackHostname(hostname);
    if (network === "loopback") return isLoopback;
    if (isLoopback || isUnspecifiedHostname(hostname)) return false;
    return network !== "tls" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const agentAudienceYamlSchema = z.object({
  network: agentAudienceNetworkSchema,
  baseUrl: z.string().min(1).max(2048),
}).strict().superRefine((value, context) => {
  if (value.baseUrl === agentAudienceRequestOrigin) {
    if (value.network !== "host-private") {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "request-origin is only valid for host-private audiences",
      });
    }
    return;
  }
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
  streamingProtocol: z.literal("saaa.llm-stream.v1").optional(),
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
  defaultAgentProfile: agentIdentifierSchema,
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

export function resolveAgentAudienceBaseUrl(
  audience: AgentAudience,
  requestUrl: string,
): string | undefined {
  if (audience.baseUrl !== agentAudienceRequestOrigin) return audience.baseUrl;
  try {
    const url = new URL(requestUrl);
    if (url.username || url.password) return undefined;
    url.pathname = "/v1";
    url.search = "";
    url.hash = "";
    const resolved = url.toString().replace(/\/$/, "");
    return canonicalGatewayUrl(resolved, audience.network) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export type AgentProviderProfile = {
  name: string;
  capability: string;
  supportedCapabilities: string[];
  route: string;
  publicModel: string;
  readiness: AgentReadinessKind;
  protocol: RuntimeProtocol;
  streamingProtocol?: "saaa.llm-stream.v1";
};

export type AgentProfile = {
  id: string;
  description: string;
  selectionPolicy: "default" | "explicit-only";
  providers: AgentProviderProfile[];
  revision: string;
};

export type AgentConnectionCatalog = {
  version: 1;
  defaultAgentProfile: string;
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
  if (!(parsed.data.defaultAgentProfile in parsed.data.agentProfiles)) {
    throw new AgentConnectionCatalogError(
      `agent-connections.yaml: default profile ${parsed.data.defaultAgentProfile} does not exist`,
    );
  }

  const runtimes = new Map(registry.runtimes.map((runtime) => [runtime.id, runtime]));
  const routes = new Map(registry.routes.map((route) => [route.id, route]));
  const profiles = Object.entries(parsed.data.agentProfiles).map(([id, profile]) => {
    const selectionPolicy: AgentProfile["selectionPolicy"] = id === parsed.data.defaultAgentProfile
      ? "default"
      : "explicit-only";
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
      if (selectionPolicy === "default" && route.explicitOnly) {
        throw new AgentConnectionCatalogError(
          `default agent profile ${id} cannot use explicit-only route ${provider.route}`,
        );
      }
      if (selectionPolicy === "explicit-only" && !route.explicitOnly) {
        throw new AgentConnectionCatalogError(
          `non-default agent profile ${id} must use explicit-only route ${provider.route}`,
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
      if (provider.streamingProtocol) {
        const primaryRuntimes = route.candidates
          .filter((candidate) => candidate.purpose === "primary")
          .map((candidate) => runtimes.get(candidate.runtime)!);
        if (
          primaryRuntimes.length === 0
          || primaryRuntimes.some((runtime) => runtime.streaming?.protocol !== provider.streamingProtocol)
        ) {
          throw new AgentConnectionCatalogError(
            `agent profile ${id} provider ${provider.name} streaming protocol is not supported by every primary runtime`,
          );
        }
      }
      return {
        ...provider,
        supportedCapabilities: [...route.capabilities].sort(),
        protocol,
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const normalized = { description: profile.description, selectionPolicy, providers };
    return { id, ...normalized, revision: digest(normalized) };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const audiences = Object.entries(parsed.data.audiences).map(([id, audience]) => ({
    id,
    ...audience,
    revision: digest(audience),
  })).sort((left, right) => left.id.localeCompare(right.id));

  return {
    version: 1,
    defaultAgentProfile: parsed.data.defaultAgentProfile,
    audiences,
    profiles,
  };
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
  agentProfile: agentIdentifierSchema.optional(),
  explicitAgentProfile: z.boolean().default(false),
  audience: agentIdentifierSchema,
  client: agentIdentifierSchema.optional(),
  ttlSeconds: z.number().int().min(1).max(86_400).default(300),
  allowFallback: z.boolean().default(false),
  deploymentPolicy: deploymentPolicySchema.default("existing-only"),
}).strict().superRefine((value, context) => {
  if (value.explicitAgentProfile && !value.agentProfile) {
    context.addIssue({
      code: "custom",
      path: ["agentProfile"],
      message: "agentProfile is required when explicitAgentProfile is true",
    });
  }
});

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
  defaultAgentProfile: agentIdentifierSchema,
  profiles: z.array(z.object({
    id: agentIdentifierSchema,
    description: z.string().min(1).max(256),
    selectionPolicy: z.enum(["default", "explicit-only"]),
    providers: z.array(z.object({
      name: agentIdentifierSchema,
      capability: agentIdentifierSchema,
      supportedCapabilities: z.array(agentIdentifierSchema).min(1).max(32),
      protocol: runtimeProtocolSchema,
      model: agentIdentifierSchema,
      streamingProtocol: z.literal("saaa.llm-stream.v1").optional(),
    }).strict().superRefine((provider, context) => {
      const canonical = [...new Set(provider.supportedCapabilities)].sort();
      if (
        !provider.supportedCapabilities.includes(provider.capability)
        || JSON.stringify(canonical) !== JSON.stringify(provider.supportedCapabilities)
      ) {
        context.addIssue({
          code: "custom",
          path: ["supportedCapabilities"],
          message: "supportedCapabilities must be sorted, unique, and include capability",
        });
      }
    })).min(1).max(8),
  }).strict()),
  audiences: z.array(agentIdentifierSchema),
}).strict().superRefine((value, context) => {
  const selected = value.profiles.filter((profile) => profile.id === value.defaultAgentProfile);
  if (selected.length !== 1 || selected[0]?.selectionPolicy !== "default") {
    context.addIssue({
      code: "custom",
      path: ["defaultAgentProfile"],
      message: "defaultAgentProfile must name exactly one default profile",
    });
  }
  if (value.profiles.some((profile) => (
    profile.id !== value.defaultAgentProfile && profile.selectionPolicy !== "explicit-only"
  ))) {
    context.addIssue({
      code: "custom",
      path: ["profiles"],
      message: "every non-default profile must be explicit-only",
    });
  }
});

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
  streaming: saaaStreamAdvertisementSchema.optional(),
}).strict().superRefine((provider, context) => {
  let baseUrl: URL;
  try {
    baseUrl = new URL(provider.baseUrl);
  } catch {
    return;
  }
  const expectedScheme = baseUrl.protocol.slice(0, -1);
  const expectedPort = baseUrl.port
    ? Number(baseUrl.port)
    : baseUrl.protocol === "https:"
      ? 443
      : 80;
  if (
    baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash
    || baseUrl.pathname !== "/v1"
  ) {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl must be a canonical /v1 URL" });
  }
  if (provider.scheme !== expectedScheme) {
    context.addIssue({ code: "custom", path: ["scheme"], message: "scheme must match baseUrl" });
  }
  if (provider.host !== baseUrl.hostname) {
    context.addIssue({ code: "custom", path: ["host"], message: "host must match baseUrl" });
  }
  if (provider.port !== expectedPort) {
    context.addIssue({ code: "custom", path: ["port"], message: "port must match baseUrl" });
  }
  if (provider.configuration.fields.baseURL !== provider.baseUrl) {
    context.addIssue({
      code: "custom",
      path: ["configuration", "fields", "baseURL"],
      message: "configuration baseURL must match baseUrl",
    });
  }
  if (provider.configuration.fields.model !== provider.model) {
    context.addIssue({
      code: "custom",
      path: ["configuration", "fields", "model"],
      message: "configuration model must match model",
    });
  }
  if (provider.streaming) {
    if (provider.protocol !== "openai.chat-completions.v1") {
      context.addIssue({
        code: "custom",
        path: ["streaming"],
        message: "native SAAA streaming requires openai.chat-completions.v1",
      });
    }
    let streamUrl: URL;
    try {
      streamUrl = new URL(provider.streaming.url);
    } catch {
      return;
    }
    if (streamUrl.origin.replace(/^ws/, "http") !== baseUrl.origin) {
      context.addIssue({
        code: "custom",
        path: ["streaming", "url"],
        message: "streaming URL origin must match baseUrl",
      });
    }
    if (
      streamUrl.pathname !== "/v1/llm/stream"
      || streamUrl.username
      || streamUrl.password
      || streamUrl.search
      || streamUrl.hash
      || (streamUrl.protocol !== "ws:" && streamUrl.protocol !== "wss:")
    ) {
      context.addIssue({
        code: "custom",
        path: ["streaming", "url"],
        message: "streaming URL must be canonical WS or WSS",
      });
    }
  }
});

export const agentConnectionClaimSchema = z.object({
  id: z.string().min(1).max(192),
  allocationId: z.string().min(1).max(192),
  status: z.literal("ready"),
  audience: agentIdentifierSchema,
  providers: z.array(agentProviderDescriptorSchema).min(1).max(8),
  expiresAt: z.string().datetime(),
}).strict().superRefine((claim, context) => {
  const names = new Set<string>();
  for (const [index, provider] of claim.providers.entries()) {
    if (names.has(provider.name)) {
      context.addIssue({ code: "custom", path: ["providers", index, "name"], message: "provider names must be unique" });
    }
    names.add(provider.name);
    if (provider.credential.expiresAt !== claim.expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "credential", "expiresAt"],
        message: "provider credential expiry must match Connection expiry",
      });
    }
    let baseUrl: URL;
    let healthUrl: URL;
    try {
      baseUrl = new URL(provider.baseUrl);
      healthUrl = new URL(provider.health.url);
    } catch {
      continue;
    }
    const expectedPath = `${baseUrl.pathname}/agent-connections/${claim.id}/providers/${provider.name}/health`;
    if (
      healthUrl.origin !== baseUrl.origin
      || healthUrl.pathname !== expectedPath
      || healthUrl.username
      || healthUrl.password
      || healthUrl.search
      || healthUrl.hash
    ) {
      context.addIssue({
        code: "custom",
        path: ["providers", index, "health", "url"],
        message: "provider health URL must match the claimed Connection and Provider",
      });
    }
  }
});

export type AgentConnectionRequest = z.infer<typeof agentConnectionRequestSchema>;
export type AgentConnectionRequestInput = z.input<typeof agentConnectionRequestSchema>;
export type AgentConnectionStatus = z.infer<typeof agentConnectionStatusSchema>;
export type PublicAgentConnection = z.infer<typeof publicAgentConnectionSchema>;
export type AgentConnectionHealth = z.infer<typeof agentConnectionHealthSchema>;
export type AgentProviderHealth = z.infer<typeof agentProviderHealthSchema>;
export type AgentConnectionClaim = z.infer<typeof agentConnectionClaimSchema>;
