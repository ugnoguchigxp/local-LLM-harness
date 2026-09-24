import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { deploymentPolicySchema } from "./api-schema";
import { embeddingSpaceSchema, type EmbeddingSpace } from "./embedding";
import type { Registry } from "./registry";
import { isLiteralLoopbackHost } from "./network";
import { runtimeProtocolSchema, type RuntimeProtocol } from "./schema";

export const agentIdentifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

export const agentProviderEndpointSchema = z.enum([
  "/v1/chat/completions",
  "/v1/audio/transcriptions",
  "/v1/audio/speech",
  "/v1/embed",
]);

export const agentProfileSelectorIdSchema = z.enum([
  "contextStill",
  "SAAA",
  "SAAA-w-Image",
  "SAAA-w-music",
  "vulnWorkbench",
]);
export type AgentProfileSelectorId = z.infer<typeof agentProfileSelectorIdSchema>;

export function agentProviderEndpoint(protocol: RuntimeProtocol): z.infer<typeof agentProviderEndpointSchema> {
  switch (protocol) {
    case "openai.chat-completions.v1": return "/v1/chat/completions";
    case "openai.audio-transcriptions.v1": return "/v1/audio/transcriptions";
    case "openai.audio-speech.v1": return "/v1/audio/speech";
    case "larm.embedding.v1": return "/v1/embed";
  }
}

export const agentReadinessKindSchema = z.enum([
  "llm-inference",
  "stt-transcription",
  "tts-speech",
  "embedding",
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
  publishModel: z.boolean().default(true),
  readiness: agentReadinessKindSchema,
  contextWindow: z.object({
    maxTokens: z.number().int().min(1).max(1_000_000),
    outputReserveTokens: z.number().int().min(1).max(1_000_000),
    safetyMarginTokens: z.number().int().min(0).max(1_000_000),
  }).strict().refine(
    (value) => value.outputReserveTokens + value.safetyMarginTokens < value.maxTokens,
    "output reserve and safety margin must leave a positive input budget",
  ).optional(),
}).strict();

const agentProfileYamlSchema = z.object({
  description: z.string().min(1).max(256),
  schedulingPriority: z.number().int().min(-1_000_000).max(1_000_000).default(0),
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

const agentCompatibilityAliasYamlSchema = z.object({
  canonicalProfile: agentIdentifierSchema,
  description: z.string().min(1).max(256),
  providerCapabilities: z.record(agentIdentifierSchema, agentIdentifierSchema).default({}),
}).strict();

export const agentProfileServiceSchema = z.object({
  name: agentIdentifierSchema,
  capability: agentIdentifierSchema,
  protocol: z.enum(["larm.image-generation.v1", "larm.music-generation.v1"]),
  endpoint: z.enum(["/v1/images/generations", "/v1/music/generations"]),
  model: agentIdentifierSchema,
}).strict().superRefine((service, context) => {
  const expected = service.protocol === "larm.image-generation.v1"
    ? "/v1/images/generations"
    : "/v1/music/generations";
  if (service.endpoint !== expected) {
    context.addIssue({ code: "custom", path: ["endpoint"], message: "endpoint must match protocol" });
  }
});

const agentProfileSelectorYamlSchema = z.object({
  agentProfile: agentIdentifierSchema,
  services: z.array(agentProfileServiceSchema).max(8).default([]),
}).strict().superRefine((selector, context) => {
  if (new Set(selector.services.map((service) => service.name)).size !== selector.services.length) {
    context.addIssue({ code: "custom", path: ["services"], message: "service names must be unique" });
  }
});

export const agentConnectionsFileSchema = z.object({
  version: z.literal(1),
  defaultAgentProfile: agentIdentifierSchema,
  audiences: z.record(agentIdentifierSchema, agentAudienceYamlSchema),
  agentProfiles: z.record(agentIdentifierSchema, agentProfileYamlSchema),
  profileSelectors: z.partialRecord(agentProfileSelectorIdSchema, agentProfileSelectorYamlSchema).default({}),
  compatibilityAliases: z.record(agentIdentifierSchema, agentCompatibilityAliasYamlSchema).default({}),
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
  publishModel?: boolean;
  readiness: AgentReadinessKind;
  protocol: RuntimeProtocol;
  embeddingSpace?: EmbeddingSpace;
  contextWindow?: AgentProviderContextWindow;
};

export type AgentProviderContextWindow = {
  maxTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
};

export type ContextWindowProfileMatch = {
  profile: AgentProfile;
  provider: AgentProviderProfile;
  requiredTokens: number;
  inputBudgetTokens: number;
};

/**
 * Selects the smallest explicitly advertised context tier that can hold the
 * complete request budget. Token counting remains the consumer's responsibility
 * because it owns the final system prompt, tool schemas, history, and retrieval.
 */
export function matchAgentProfileContextWindow(input: {
  catalog: AgentConnectionCatalog;
  profileIds: string[];
  promptTokens: number;
  requestedOutputTokens: number;
}): ContextWindowProfileMatch | undefined {
  if (!Number.isInteger(input.promptTokens) || input.promptTokens < 0) {
    throw new RangeError("promptTokens must be a non-negative integer");
  }
  if (!Number.isInteger(input.requestedOutputTokens) || input.requestedOutputTokens < 1) {
    throw new RangeError("requestedOutputTokens must be a positive integer");
  }
  const allowed = new Set(input.profileIds);
  const candidates = input.catalog.profiles.flatMap((profile) =>
    allowed.has(profile.id)
      ? profile.providers.flatMap((provider) => {
        const window = provider.contextWindow;
        if (!window || input.requestedOutputTokens > window.outputReserveTokens) return [];
        const requiredTokens = input.promptTokens
          + input.requestedOutputTokens
          + window.safetyMarginTokens;
        if (requiredTokens > window.maxTokens) return [];
        return [{
          profile,
          provider,
          requiredTokens,
          inputBudgetTokens: window.maxTokens
            - window.outputReserveTokens
            - window.safetyMarginTokens,
        }];
      })
      : []
  );
  return candidates.sort((left, right) =>
    left.provider.contextWindow!.maxTokens - right.provider.contextWindow!.maxTokens
      || left.profile.id.localeCompare(right.profile.id)
      || left.provider.name.localeCompare(right.provider.name)
  )[0];
}

export type AgentProfile = {
  id: string;
  canonicalProfile: string;
  description: string;
  selectionPolicy: "default" | "compatibility" | "explicit-only";
  deprecated: boolean;
  schedulingPriority?: number;
  providers: AgentProviderProfile[];
  revision: string;
};

export type AgentConnectionCatalog = {
  version: 1;
  defaultAgentProfile: string;
  audiences: AgentAudience[];
  profiles: AgentProfile[];
  profileSelectors: Array<{
    id: string;
    agentProfile: string;
    services: Array<z.infer<typeof agentProfileServiceSchema>>;
  }>;
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
  if (protocol === "larm.embedding.v1") return "embedding";
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
  const canonicalProfiles = Object.entries(parsed.data.agentProfiles).map(([id, profile]) => {
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
      const embeddingSpaces: EmbeddingSpace[] = [];
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
        if (runtime.embedding) embeddingSpaces.push(runtime.embedding);
      }
      if (protocols.size !== 1) {
        throw new AgentConnectionCatalogError(
          `agent profile ${id} route ${provider.route} candidates do not share one protocol`,
        );
      }
      const protocol = [...protocols][0]!;
      if (provider.contextWindow && protocol !== "openai.chat-completions.v1") {
        throw new AgentConnectionCatalogError(
          `agent profile ${id} provider ${provider.name} contextWindow requires Chat Completions`,
        );
      }
      let embeddingSpace: EmbeddingSpace | undefined;
      if (protocol === "larm.embedding.v1") {
        if (embeddingSpaces.length !== route.candidates.length) {
          throw new AgentConnectionCatalogError(
            `agent profile ${id} route ${provider.route} has an embedding candidate without an embedding space`,
          );
        }
        const canonicalSpace = JSON.stringify(embeddingSpaces[0]);
        if (embeddingSpaces.some((space) => JSON.stringify(space) !== canonicalSpace)) {
          throw new AgentConnectionCatalogError(
            `agent profile ${id} route ${provider.route} candidates do not share one embedding space`,
          );
        }
        embeddingSpace = structuredClone(embeddingSpaces[0]);
      }
      if (provider.readiness !== expectedReadiness(protocol)) {
        throw new AgentConnectionCatalogError(
          `agent profile ${id} provider ${provider.name} readiness does not match ${protocol}`,
        );
      }
      return {
        ...provider,
        supportedCapabilities: [...route.capabilities].sort(),
        protocol,
        ...(embeddingSpace ? { embeddingSpace } : {}),
        ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const normalized = {
      canonicalProfile: id,
      description: profile.description,
      selectionPolicy,
      deprecated: false,
      schedulingPriority: profile.schedulingPriority,
      providers,
    };
    return { id, ...normalized, revision: digest(normalized) };
  });

  const profileById = new Map(canonicalProfiles.map((profile) => [profile.id, profile]));
  const compatibilityProfiles = Object.entries(parsed.data.compatibilityAliases).map(([id, alias]) => {
    if (profileById.has(id)) {
      throw new AgentConnectionCatalogError(`compatibility alias ${id} conflicts with an agent profile`);
    }
    const canonical = profileById.get(alias.canonicalProfile);
    if (!canonical) {
      throw new AgentConnectionCatalogError(
        `compatibility alias ${id} references unknown canonical profile ${alias.canonicalProfile}`,
      );
    }
    if (canonical.selectionPolicy !== "default") {
      throw new AgentConnectionCatalogError(
        `compatibility alias ${id} must target the default agent profile`,
      );
    }
    const providers = canonical.providers.map((provider) => {
      const capability = alias.providerCapabilities[provider.name] ?? provider.capability;
      if (!provider.supportedCapabilities.includes(capability)) {
        throw new AgentConnectionCatalogError(
          `compatibility alias ${id} provider ${provider.name} route ${provider.route} does not advertise ${capability}`,
        );
      }
      return { ...provider, capability };
    });
    for (const providerName of Object.keys(alias.providerCapabilities)) {
      if (!providers.some((provider) => provider.name === providerName)) {
        throw new AgentConnectionCatalogError(
          `compatibility alias ${id} overrides unknown provider ${providerName}`,
        );
      }
    }
    const normalized = {
      canonicalProfile: canonical.id,
      description: alias.description,
      selectionPolicy: "compatibility" as const,
      deprecated: true,
      schedulingPriority: canonical.schedulingPriority,
      providers,
    };
    return { id, ...normalized, revision: digest(normalized) };
  });
  const profiles = [...canonicalProfiles, ...compatibilityProfiles]
    .sort((left, right) => left.id.localeCompare(right.id));

  const profileSelectors = Object.entries(parsed.data.profileSelectors).map(([id, selector]) => {
    if (!profiles.some((profile) => profile.id === selector.agentProfile)) {
      throw new AgentConnectionCatalogError(
        `profile selector ${id} references unknown agent profile ${selector.agentProfile}`,
      );
    }
    return { id, ...selector, services: structuredClone(selector.services) };
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
    profileSelectors,
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
  format: z.enum(["openai-provider-v1", "larm-embedding-provider-v1"]),
}).strict();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const publicAgentProfileListV1Schema = z.object({
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

export const publicAgentProfileListSchema = z.object({
  contractVersion: z.literal("agent-connection.v2"),
  catalogRevision: z.string().min(1).max(128),
  defaultAgentProfile: agentIdentifierSchema,
  profiles: z.array(z.object({
    id: agentIdentifierSchema,
    canonicalProfile: agentIdentifierSchema,
    description: z.string().min(1).max(256),
    selectionPolicy: z.enum(["default", "compatibility", "explicit-only"]),
    deprecated: z.boolean(),
    schedulingPriority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    providers: z.array(z.object({
      name: agentIdentifierSchema,
      capability: agentIdentifierSchema,
      supportedCapabilities: z.array(agentIdentifierSchema).min(1).max(32),
      protocol: runtimeProtocolSchema,
      model: agentIdentifierSchema,
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
  if (value.profiles.some((profile) => {
    if (profile.id === value.defaultAgentProfile) {
      return profile.canonicalProfile !== profile.id || profile.deprecated;
    }
    if (profile.selectionPolicy === "compatibility") {
      return profile.canonicalProfile !== value.defaultAgentProfile || !profile.deprecated;
    }
    return profile.selectionPolicy !== "explicit-only"
      || profile.canonicalProfile !== profile.id
      || profile.deprecated;
  })) {
    context.addIssue({
      code: "custom",
      path: ["profiles"],
      message: "profile selection, canonical identity, or deprecation metadata is inconsistent",
    });
  }
});

export const publicAgentProfileListV3Schema = z.object({
  contractVersion: z.literal("agent-connection.v3"),
  catalogRevision: z.string().min(1).max(128),
  defaultAgentProfile: agentIdentifierSchema,
  requestedProfile: agentIdentifierSchema.optional(),
  profiles: z.array(z.object({
    id: agentIdentifierSchema,
    canonicalProfile: agentIdentifierSchema,
    description: z.string().min(1).max(256),
    selectionPolicy: z.enum(["default", "compatibility", "explicit-only"]),
    deprecated: z.boolean(),
    schedulingPriority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    providers: z.array(z.object({
      name: agentIdentifierSchema,
      capability: agentIdentifierSchema,
      supportedCapabilities: z.array(agentIdentifierSchema).min(1).max(32),
      protocol: runtimeProtocolSchema,
      endpoint: agentProviderEndpointSchema,
      model: agentIdentifierSchema,
      embeddingSpace: embeddingSpaceSchema.optional(),
      contextWindow: z.object({
        maxTokens: z.number().int().min(1).max(1_000_000),
        outputReserveTokens: z.number().int().min(1).max(1_000_000),
        safetyMarginTokens: z.number().int().min(0).max(1_000_000),
      }).strict().refine(
        (value) => value.outputReserveTokens + value.safetyMarginTokens < value.maxTokens,
        "output reserve and safety margin must leave a positive input budget",
      ).optional(),
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
      if ((provider.protocol === "larm.embedding.v1") !== (provider.embeddingSpace !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["embeddingSpace"],
          message: "embeddingSpace must be present exactly for embedding providers",
        });
      }
      if (provider.contextWindow && provider.protocol !== "openai.chat-completions.v1") {
        context.addIssue({
          code: "custom",
          path: ["contextWindow"],
          message: "contextWindow is only valid for Chat Completions providers",
        });
      }
      if (provider.endpoint !== agentProviderEndpoint(provider.protocol)) {
        context.addIssue({
          code: "custom",
          path: ["endpoint"],
          message: "endpoint must match protocol",
        });
      }
    })).min(1).max(8),
    services: z.array(agentProfileServiceSchema).max(8),
  }).strict()),
  audiences: z.array(agentIdentifierSchema),
}).strict().superRefine((value, context) => {
  const selected = value.profiles.filter((profile) => profile.id === value.defaultAgentProfile);
  if (!value.requestedProfile && (selected.length !== 1 || selected[0]?.selectionPolicy !== "default")) {
    context.addIssue({
      code: "custom",
      path: ["defaultAgentProfile"],
      message: "defaultAgentProfile must name exactly one default profile",
    });
  }
  if (value.requestedProfile && value.profiles.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["profiles"],
      message: "a requested profile must resolve to exactly one agent profile",
    });
  }
  if (value.profiles.some((profile) => {
    if (profile.id === value.defaultAgentProfile) {
      return profile.canonicalProfile !== profile.id || profile.deprecated;
    }
    if (profile.selectionPolicy === "compatibility") {
      return profile.canonicalProfile !== value.defaultAgentProfile || !profile.deprecated;
    }
    return profile.selectionPolicy !== "explicit-only"
      || profile.canonicalProfile !== profile.id
      || profile.deprecated;
  })) {
    context.addIssue({
      code: "custom",
      path: ["profiles"],
      message: "profile selection, canonical identity, or deprecation metadata is inconsistent",
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
  "provider_contract_mismatch",
  "invalid_response",
]);

export const agentProviderHealthSchema = z.object({
  name: agentIdentifierSchema,
  capability: agentIdentifierSchema,
  ready: z.boolean(),
  acceptingRequests: z.boolean(),
  reason: agentProviderHealthReasonSchema.optional(),
  capacity: z.object({
    ready: z.boolean(),
    activeRequests: z.number().int().nonnegative(),
    maxConcurrentRequests: z.number().int().positive(),
    queueDepth: z.number().int().nonnegative(),
    maxQueuedRequests: z.number().int().nonnegative(),
    queueTimeoutMs: z.number().int().nonnegative(),
    retryAfterMs: z.number().int().nonnegative(),
    completionGuaranteed: z.literal(false),
  }).strict().optional(),
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
  protocol: z.enum([
    "openai.chat-completions.v1",
    "openai.audio-transcriptions.v1",
    "openai.audio-speech.v1",
  ]),
  scheme: z.enum(["http", "https"]),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  baseUrl: z.string().url(),
  model: agentIdentifierSchema,
  contextWindow: z.object({
    maxTokens: z.number().int().min(1).max(1_000_000),
    outputReserveTokens: z.number().int().min(1).max(1_000_000),
    safetyMarginTokens: z.number().int().min(0).max(1_000_000),
  }).strict().refine(
    (value) => value.outputReserveTokens + value.safetyMarginTokens < value.maxTokens,
    "output reserve and safety margin must leave a positive input budget",
  ).optional(),
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
  if (provider.contextWindow && provider.protocol !== "openai.chat-completions.v1") {
    context.addIssue({
      code: "custom",
      path: ["contextWindow"],
      message: "contextWindow is only valid for Chat Completions providers",
    });
  }
});

export const embeddingAgentProviderDescriptorSchema = z.object({
  name: agentIdentifierSchema,
  capability: agentIdentifierSchema,
  apiStyle: z.literal("larm-embedding"),
  protocol: z.literal("larm.embedding.v1"),
  scheme: z.enum(["http", "https"]),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  baseUrl: z.string().url(),
  endpoint: z.string().url(),
  model: agentIdentifierSchema,
  embeddingSpace: embeddingSpaceSchema,
  capacity: z.object({
    ready: z.literal(true),
    activeRequests: z.number().int().nonnegative(),
    maxConcurrentRequests: z.number().int().positive(),
    queueDepth: z.number().int().nonnegative(),
    maxQueuedRequests: z.number().int().nonnegative(),
    queueTimeoutMs: z.number().int().nonnegative(),
    retryAfterMs: z.number().int().nonnegative(),
    completionGuaranteed: z.literal(false),
  }).strict(),
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
    kind: z.literal("larm-embedding-provider-v1"),
    fields: z.object({
      daemonURL: z.string().url(),
      model: agentIdentifierSchema,
      dimension: z.number().int().positive(),
    }).strict(),
    secretFields: z.object({ accessToken: z.literal("credential.token") }).strict(),
  }).strict(),
}).strict().superRefine((provider, context) => {
  let baseUrl: URL;
  let endpoint: URL;
  try {
    baseUrl = new URL(provider.baseUrl);
    endpoint = new URL(provider.endpoint);
  } catch {
    return;
  }
  const expectedScheme = baseUrl.protocol.slice(0, -1);
  const expectedPort = baseUrl.port ? Number(baseUrl.port) : baseUrl.protocol === "https:" ? 443 : 80;
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== "/v1") {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl must be a canonical /v1 URL" });
  }
  if (
    endpoint.origin !== baseUrl.origin
    || endpoint.pathname !== "/v1/embed"
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
  ) {
    context.addIssue({ code: "custom", path: ["endpoint"], message: "endpoint must be the base origin /v1/embed" });
  }
  if (provider.scheme !== expectedScheme || provider.host !== baseUrl.hostname || provider.port !== expectedPort) {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "scheme, host, and port must match baseUrl" });
  }
  if (
    provider.configuration.fields.daemonURL !== provider.baseUrl
    || provider.configuration.fields.model !== provider.model
    || provider.configuration.fields.dimension !== provider.embeddingSpace.dimension
  ) {
    context.addIssue({ code: "custom", path: ["configuration", "fields"], message: "configuration must match the claimed provider" });
  }
});

export const agentConnectionClaimSchema = z.object({
  id: z.string().min(1).max(192),
  allocationId: z.string().min(1).max(192),
  status: z.literal("ready"),
  audience: agentIdentifierSchema,
  providers: z.array(z.union([
    agentProviderDescriptorSchema,
    embeddingAgentProviderDescriptorSchema,
  ])).min(1).max(8),
  contextControl: z.object({
    contractVersion: z.literal("larm-personal-state.v1"),
    subjectDigest: sha256Schema,
    scopes: z.array(z.enum([
      "context.source.provision",
      "context.measure",
      "context.view.create",
      "context.generate",
      "context.attempt.cancel",
      "context.forget",
      "context.operation.read",
    ])).length(7)
      .refine((items) => new Set(items).size === items.length, "Personal State scopes must be unique"),
  }).strict().optional(),
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
export type AgentConnectionClaimRequest = z.infer<typeof agentConnectionClaimRequestSchema>;
