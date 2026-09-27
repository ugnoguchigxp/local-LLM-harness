import { inspectOpenAiChatCompletionJson } from "../../../packages/core/src/index";
import { LarmClient, type SystemOneAgentProvider } from "../../../packages/client/src/index";

const baseUrl = process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810";
const apiToken = process.env.LARM_API_TOKEN;
const expectedReleaseCommit = process.env.LARM_EXPECTED_RELEASE_COMMIT;
if (!apiToken) throw new Error("LARM_API_TOKEN is required");
if (!expectedReleaseCommit || !/^[a-f0-9]{40}$/.test(expectedReleaseCommit)) {
  throw new Error("LARM_EXPECTED_RELEASE_COMMIT must be a full lowercase Git commit");
}

const client = new LarmClient({ baseUrl, apiToken, timeoutMs: 300_000 });
let connectionId: string | undefined;
try {
  const health = await client.getHealth();
  if (!health.ready || health.releaseCommit !== expectedReleaseCommit) {
    throw new Error(`release identity/readiness mismatch: ${health.releaseCommit}, ready=${health.ready}`);
  }
  const catalog = await client.listAgentProfilesV3("SAAA-gemma4-26b");
  const profile = catalog.profiles.find((candidate) => candidate.id === "saaa-conversation-gemma4-26b-voice");
  const advertised = profile?.providers.map((provider) => `${provider.name}:${provider.protocol}`).sort();
  const expected = [
    "asr:openai.audio-transcriptions.v1",
    "llm:openai.chat-completions.v1",
    "system-one:larm.system-one.v1",
    "tts:openai.audio-speech.v1",
  ];
  if (!profile || JSON.stringify(advertised) !== JSON.stringify(expected)) {
    throw new Error(`Gemma/Laya profile drift: ${JSON.stringify(advertised)}`);
  }
  const created = await client.createAgentConnection({
    profile: "SAAA-gemma4-26b",
    audience: "same-host",
    client: "gemma4-laya-live-e2e",
    ttlSeconds: 600,
    allowFallback: false,
    deploymentPolicy: "existing-only",
  }, { waitSeconds: 300 });
  connectionId = created.id;
  const ready = await client.waitForAgentConnection(created, { timeoutMs: 300_000, pollIntervalMs: 1_000 });
  const claim = await client.claimAgentConnection(ready.id);
  if (claim.providers.length !== 4) throw new Error(`claim returned ${claim.providers.length} providers`);
  const systemOne = claim.providers.find((provider): provider is SystemOneAgentProvider => provider.apiStyle === "larm-system-one");
  const llm = claim.providers.find((provider) => provider.name === "llm" && provider.apiStyle === "openai");
  if (!systemOne || !llm) throw new Error("claim omitted System One or LLM provider");

  const decision = await client.systemOne(systemOne, {
    model: systemOne.model,
    state: "返品して返金をお願いします",
    questions: {
      intent: {
        type: "choice",
        instructions: "問い合わせの意図を分類してください",
        criteria: { refund: "返品または返金", other: "その他" },
      },
    },
  });
  const chatResponse = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${llm.credential.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [{ role: "user", content: "OKとだけ返してください。" }],
      temperature: 0,
      max_tokens: 8,
      stream: false,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!chatResponse.ok || !inspectOpenAiChatCompletionJson(await chatResponse.json()).ok) {
    throw new Error(`Gemma inference failed with HTTP ${chatResponse.status}`);
  }
  await client.releaseAgentConnection(ready.id);
  connectionId = undefined;
  const revoked = await fetch(systemOne.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${systemOne.credential.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: systemOne.model, state: "x", questions: { q: { type: "noul", instructions: "test" } } }),
  });
  await revoked.body?.cancel();
  if (revoked.status !== 401) throw new Error(`released System One credential returned ${revoked.status}`);
  console.log(JSON.stringify({
    ok: true,
    releaseCommit: health.releaseCommit,
    profile: profile.id,
    providers: advertised,
    layaModel: decision.model,
    layaIntent: decision.answers.intent?.choice,
    gemmaModel: llm.model,
    released: true,
    credentialRevoked: true,
  }, null, 2));
} finally {
  if (connectionId) await client.releaseAgentConnection(connectionId).catch(() => undefined);
}
