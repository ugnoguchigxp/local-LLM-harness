import { inspectOpenAiChatCompletionJson } from "@larm/core";

export type GatewayStartupVerificationOptions = {
  baseUrl: string;
  apiToken?: string;
  model: string;
  startupProbeToken: string;
  timeoutMs: number;
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

  const chatResponse = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      ...authorization,
      "content-type": "application/json",
      "x-larm-startup-probe": options.startupProbeToken,
    },
    body: JSON.stringify({
      model: options.model,
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
