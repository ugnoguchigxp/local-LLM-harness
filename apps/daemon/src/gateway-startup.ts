import { inspectOpenAiChatCompletionJson, selectRoute, type AgentConnectionCatalog, type ClusterState, type Registry } from "@larm/core";

export function retainedGatewayStartupModel(catalog: AgentConnectionCatalog, registry: Registry, runtimeIds: string[], state: ClusterState): string | undefined {
  const retained = new Set(runtimeIds);
  return catalog.profiles.flatMap(profile => profile.providers).find(provider => {
    if (provider.protocol !== "openai.chat-completions.v1" || provider.publishModel === false) return false;
    const selected = selectRoute({ registry, state, routeId: provider.route, capability: provider.capability, mode: "explicit", allowFallback: false });
    return selected.ok && retained.has(selected.runtime);
  })?.publicModel;
}

export function defaultGatewayStartupModel(catalog: AgentConnectionCatalog): string {
  const profile = catalog.profiles.find((profile) => profile.id === catalog.defaultAgentProfile);
  const provider = profile?.providers.find((provider) =>
    provider.protocol === "openai.chat-completions.v1"
    && provider.publishModel !== false
  );
  if (!provider) throw new Error("default Agent Profile has no published chat provider");
  return provider.publicModel;
}

export function gatewayStartupVerificationIntent(input: {
  catalog: AgentConnectionCatalog; registry: Registry; state: ClusterState;
  retainedRuntimeIds: string[]; probeModel?: string; retentionUncertain?: boolean;
}) {
  const retainedModel = retainedGatewayStartupModel(input.catalog, input.registry, input.retainedRuntimeIds, input.state);
  const model = retainedModel ?? defaultGatewayStartupModel(input.catalog);
  const probeModel = input.probeModel ?? model;
  // Startup verification must not replace restored profile intent. When an
  // inference probe cannot preserve it, verify only the published catalog.
  const catalogOnly = input.retentionUncertain === true || (input.retainedRuntimeIds.length > 0
    && (retainedModel === undefined || probeModel !== retainedModel));
  return { model, probeModel, catalogOnly };
}

export type GatewayStartupVerificationOptions = {
  baseUrl: string;
  apiToken?: string;
  model: string;
  probeModel?: string;
  startupProbeToken: string;
  timeoutMs: number;
  catalogOnly?: boolean;
  fetchImpl?: typeof fetch;
};

export async function verifyGatewayStartup(
  options: GatewayStartupVerificationOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const authorization: Record<string, string> = {};
  if (options.apiToken) authorization.authorization = `Bearer ${options.apiToken}`;
  const modelsResponse = await fetchImpl(`${baseUrl}/v1/models`, {
    headers: authorization,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!modelsResponse.ok) {
    await modelsResponse.body?.cancel().catch(() => undefined);
    throw new Error(`model catalog returned HTTP ${modelsResponse.status}`);
  }
  const models = await modelsResponse.json() as { data?: Array<{ id?: string }> };
  if (!models.data?.some((model) => model.id === options.model)) {
    throw new Error(`required chat model ${options.model} is not routed`);
  }
  if (options.catalogOnly) return;
  const probeModel = options.probeModel ?? options.model;
  if (!models.data?.some((model) => model.id === probeModel)) {
    throw new Error(`startup probe model ${probeModel} is not routed`);
  }

  const chatResponse = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      ...authorization,
      "content-type": "application/json",
      "x-larm-startup-probe": options.startupProbeToken,
    },
    body: JSON.stringify({
      model: probeModel,
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 8,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (!chatResponse.ok) {
    await chatResponse.body?.cancel().catch(() => undefined);
    throw new Error(`chat handler verification returned HTTP ${chatResponse.status}`);
  }
  let payload: unknown;
  try {
    payload = await chatResponse.json();
  } catch {
    throw new Error("chat handler verification returned invalid JSON");
  }
  const inspected = inspectOpenAiChatCompletionJson(payload);
  if (!inspected.ok) {
    throw new Error(`chat handler verification returned an invalid completion: ${inspected.reason}`);
  }
}
