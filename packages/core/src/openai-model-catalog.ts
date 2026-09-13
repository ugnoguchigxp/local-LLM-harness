import { z } from "zod";
import type {
  AgentConnectionCatalog,
  AgentProviderProfile,
} from "./agent-connection";
import type { RuntimeProtocol } from "./schema";

export const openAiModelSchema = z.object({
  id: z.string().min(1).max(128),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.literal("larm"),
}).strict();

export const openAiModelListSchema = z.object({
  object: z.literal("list"),
  data: z.array(openAiModelSchema),
}).strict();

export type OpenAiModel = z.infer<typeof openAiModelSchema>;
export type OpenAiModelList = z.infer<typeof openAiModelListSchema>;

export type OpenAiModelBinding = {
  id: string;
  capability: string;
  route: string;
  protocol: RuntimeProtocol;
  schedulingPriority: number;
  profileIds: string[];
};

export type OpenAiModelCatalog = {
  models: OpenAiModelBinding[];
};

export class OpenAiModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenAiModelCatalogError";
  }
}

function sameBinding(
  left: Pick<AgentProviderProfile, "capability" | "route" | "protocol">,
  right: Pick<AgentProviderProfile, "capability" | "route" | "protocol">,
): boolean {
  return left.capability === right.capability
    && left.route === right.route
    && left.protocol === right.protocol;
}

export function createOpenAiModelCatalog(
  catalog: AgentConnectionCatalog,
): OpenAiModelCatalog {
  const bindings = new Map<string, OpenAiModelBinding>();
  for (const profile of catalog.profiles) {
    if (profile.deprecated) continue;
    for (const provider of profile.providers) {
      if (provider.publishModel === false) continue;
      if (!provider.protocol.startsWith("openai.")) continue;
      const existing = bindings.get(provider.publicModel);
      if (existing) {
        if (!sameBinding(existing, provider)) {
          throw new OpenAiModelCatalogError(
            `public model ${provider.publicModel} resolves to conflicting Provider bindings`,
          );
        }
        if (existing.schedulingPriority !== (profile.schedulingPriority ?? 0)) {
          throw new OpenAiModelCatalogError(
            `public model ${provider.publicModel} resolves to conflicting scheduling priorities`,
          );
        }
        if (!existing.profileIds.includes(profile.id)) {
          existing.profileIds.push(profile.id);
          existing.profileIds.sort();
        }
        continue;
      }
      bindings.set(provider.publicModel, {
        id: provider.publicModel,
        capability: provider.capability,
        route: provider.route,
        protocol: provider.protocol,
        schedulingPriority: profile.schedulingPriority ?? 0,
        profileIds: [profile.id],
      });
    }
  }
  return { models: [...bindings.values()].sort((left, right) => left.id.localeCompare(right.id)) };
}

export function listOpenAiModels(catalog: OpenAiModelCatalog): OpenAiModelList {
  return {
    object: "list",
    data: catalog.models.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "larm",
    })),
  };
}

export function getOpenAiModel(
  catalog: OpenAiModelCatalog,
  id: string,
  protocol?: RuntimeProtocol,
): OpenAiModelBinding | undefined {
  return catalog.models.find((model) => model.id === id && (protocol === undefined || model.protocol === protocol));
}
