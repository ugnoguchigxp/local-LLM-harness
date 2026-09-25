import { inspectOpenAiChatCompletionJson } from "../../../packages/core/src/index";
import { LarmClient } from "../../../packages/client/src/index";

const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
const apiToken = process.env.LARM_API_TOKEN;
const expectedReleaseCommit = process.env.LARM_EXPECTED_RELEASE_COMMIT;
const timeoutMs = 300_000;

if (!apiToken) throw new Error("LARM_API_TOKEN is required");
if (!expectedReleaseCommit || !/^[a-f0-9]{40}$/.test(expectedReleaseCommit)) {
  throw new Error("LARM_EXPECTED_RELEASE_COMMIT must be a full lowercase Git commit");
}

const larm = new LarmClient({ baseUrl, apiToken, timeoutMs });
const liveConnections = new Set<string>();

type ClaimedLlm = {
  connectionId: string;
  healthUrl: string;
  completionUrl: string;
  token: string;
  model: string;
};

async function createAndClaim(profile: "SAAA" | "contextStill", client: string): Promise<ClaimedLlm> {
  const created = await larm.createAgentConnection({
    profile,
    audience: "same-host",
    client,
    ttlSeconds: 600,
    allowFallback: false,
    deploymentPolicy: "existing-only",
  }, { waitSeconds: 300 });
  liveConnections.add(created.id);
  const ready = await larm.waitForAgentConnection(created, { timeoutMs, pollIntervalMs: 500 });
  const claim = await larm.claimAgentConnection(ready.id);
  const provider = claim.providers.find((candidate) => candidate.name === "llm");
  if (!provider) throw new Error(`${profile} claim did not contain the llm provider`);
  return {
    connectionId: ready.id,
    healthUrl: provider.health.url,
    completionUrl: `${provider.baseUrl}/chat/completions`,
    token: provider.credential.token,
    model: provider.model,
  };
}

async function infer(provider: ClaimedLlm, expectedWord: string): Promise<void> {
  const response = await fetch(provider.completionUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: `Reply with the single word ${expectedWord}.` }],
      temperature: 0,
      max_tokens: 16,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${provider.model} inference returned HTTP ${response.status}`);
  const inspected = inspectOpenAiChatCompletionJson(await response.json());
  if (!inspected.ok || inspected.textChoices === 0) {
    throw new Error(`${provider.model} inference returned an invalid completion`);
  }
}

async function release(provider: ClaimedLlm): Promise<void> {
  await larm.releaseAgentConnection(provider.connectionId);
  liveConnections.delete(provider.connectionId);
  const released = await larm.getAgentConnection(provider.connectionId);
  if (released.status !== "released" || !released.releasedAt) {
    throw new Error(`${provider.connectionId} was not observably released`);
  }
}

async function expectRevoked(provider: ClaimedLlm): Promise<void> {
  const response = await fetch(provider.healthUrl, {
    headers: { authorization: `Bearer ${provider.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.status !== 401) {
    throw new Error(`${provider.connectionId} credential returned HTTP ${response.status}, expected 401`);
  }
}

async function waitForRuntimeCold(runtimeId: string, waitMs = 90_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/state`, {
      headers: { authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`runtime state returned HTTP ${response.status}`);
    const body = await response.json() as { runtimes?: Array<{ id?: string; status?: string }> };
    const runtime = body.runtimes?.find((candidate) => candidate.id === runtimeId);
    if (runtime?.status === "COLD") return;
    await Bun.sleep(1_000);
  }
  throw new Error(`${runtimeId} did not unload after ContextStill preemption`);
}

try {
  const health = await larm.getHealth();
  if (!health.ready || health.releaseCommit !== expectedReleaseCommit) {
    throw new Error(`release identity/readiness mismatch: ${health.releaseCommit}, ready=${health.ready}`);
  }
  const initialActivity = await larm.getServiceActivity();
  if (initialActivity.state === "draining") {
    throw new Error("LARM is draining before the switch canary");
  }

  const initialSaaa = await createAndClaim("SAAA", "saaa-switch-canary-initial");
  await infer(initialSaaa, "SAAA");
  await release(initialSaaa);
  await expectRevoked(initialSaaa);

  const context = await createAndClaim("contextStill", "contextstill-switch-canary");
  await infer(context, "CONTEXT");

  const replacementSaaa = await createAndClaim("SAAA", "saaa-switch-canary-replacement");
  const preempted = await larm.getAgentConnection(context.connectionId);
  liveConnections.delete(context.connectionId);
  if (
    preempted.status !== "failed"
    || preempted.error?.code !== "foreground_preempted"
    || !preempted.releasedAt
  ) {
    throw new Error(`ContextStill was not preempted: ${JSON.stringify(preempted.error ?? preempted.status)}`);
  }
  await expectRevoked(context);
  await infer(replacementSaaa, "SAAA");
  await release(replacementSaaa);
  await expectRevoked(replacementSaaa);
  await waitForRuntimeCold("qwen-worker-fast");

  const finalActivity = await larm.getServiceActivity();
  if (finalActivity.state === "draining") {
    throw new Error("LARM entered draining state during the switch canary");
  }
  console.log(JSON.stringify({
    ok: true,
    releaseCommit: health.releaseCommit,
    configRevision: health.configRevision,
    bootEpoch: health.bootEpoch,
    initialActivity: initialActivity.state,
    sequence: [
      { profile: "SAAA", model: initialSaaa.model, inferred: true, released: true, credentialRevoked: true },
      { profile: "contextStill", model: context.model, inferred: true, preempted: true, credentialRevoked: true },
      { profile: "SAAA", model: replacementSaaa.model, inferred: true, released: true, credentialRevoked: true },
    ],
    contextRuntimeUnloaded: true,
    finalActivity: finalActivity.state,
  }));
} catch (error) {
  for (const id of liveConnections) {
    await larm.releaseAgentConnection(id).catch(() => undefined);
  }
  throw error;
}
