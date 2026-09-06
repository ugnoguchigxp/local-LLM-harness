# @larm/client

LARM v1のAllocation lifecycleと共通Gatewayを扱う参照TypeScript clientです。Route判断、暗黙fallback、
release選択、Cloud fallbackは行いません。Idempotency-Key、poll、renew、boot epoch変更、timeout、
AbortSignal、確実なreleaseを一か所で扱います。pollの全体期限は進行中のHTTPにも適用し、処理と
releaseが両方失敗した場合は双方を含む`AggregateError`を返します。

```ts
import { LarmClient } from "@larm/client";

const larm = new LarmClient({ baseUrl: "http://127.0.0.1:9810" });
await larm.withAllocation({
  requirements: [{ capability: "llm.general", route: "llm-default" }],
  deploymentPolicy: "existing-only",
  allowFallback: false,
  ttlSeconds: 120,
}, async (allocation, client) => {
  return await client.chat(allocation.id, {
    model: "larm",
    messages: [{ role: "user", content: "hello" }],
  });
});
```

音声を含む完全な例は[`../../examples/voice-client.ts`](../../examples/voice-client.ts)を参照してください。
API tokenとmanagement tokenは別設定で、通常requestへmanagement tokenを送信しません。daemonのboot
epochが変わった場合は自動retryせず`LarmEpochChangedError`を返し、呼出側へ再Allocationを要求します。

Agent向けにはProfile一覧、Connection作成・poll、semantic health、claim、renew、releaseを型付きで
提供します。claimされた短期tokenはLARM clientの任意な長期control tokenと混ぜず、返された
`baseUrl`と`model`へそのまま設定します。Agent Connection lifecycleは`apiToken`を省略でき、Clientは
その場合Authorization headerを送りません。local-nodeはこの匿名lifecycleを有効にしますが、通常の
Allocation、Gateway、管理APIは引き続き認証必須です。`getHealth()`と`getReadiness()`もAuthorization
headerを送らず、host到達不能とhost非readyを分離します。最後に観測したresponse headerは
`observedConfigRevision`と`observedBootEpoch`で確認できます。

```ts
const gatewayUrl = process.env.LARM_BASE_URL;
if (!gatewayUrl) throw new Error("LARM_BASE_URL must come from host discovery or operator configuration");
const larm = new LarmClient({
  baseUrl: gatewayUrl,
  // 任意。local-nodeのAgent Connection lifecycleは省略可能。
  apiToken: process.env.LARM_API_TOKEN,
});

const health = await larm.getHealth();
const readiness = await larm.getReadiness();
if (health.status !== "ok" || readiness.status !== "ready") {
  throw new Error("LARM is not ready");
}
const profiles = await larm.listAgentProfiles();
if (profiles.defaultAgentProfile !== "coding-default") {
  throw new Error("LARM did not advertise the Resident Qwen profile as default");
}
const primary = profiles.profiles.find(({ id }) => id === profiles.defaultAgentProfile);
if (primary?.selectionPolicy !== "default"
  || primary.providers[0]?.streamingProtocol !== "saaa.llm-stream.v1"
  || !primary.providers[0]?.supportedCapabilities.includes("llm.reasoning")) {
  throw new Error("default Agent Profile does not advertise Native WebSocket streaming");
}

await larm.withAgentConnection({
  audience: "saaa-desktop",
  client: "saaa-desktop",
  ttlSeconds: 300,
  allowFallback: false,
  deploymentPolicy: "existing-only",
}, async (_ready, claim) => {
  const llm = claim.providers.find((provider) => provider.name === "llm");
  if (!llm) throw new Error("LLM provider is missing");
  // OpenAI clientへ llm.baseUrl、llm.model、llm.credential.token を設定する。
  // callbackの成功・失敗・cancel後にConnectionは独立したbounded requestでreleaseされる。
});
```

ContextStillの背景jobは、queueが空でないときだけService Activityを確認し、`idle`の場合に限って明示
ProfileからProviderを取得します。Activityはsnapshotであり予約ではないため、Connection作成時のadmission
failureも通常の待機条件として扱います。実行中jobは中断せず、response bodyを閉じてから次jobの前に再確認
してください。`getServiceActivity()`はcontract TTLを超えた応答と許容範囲を超える未来時刻を
`activity_stale`としてfail closedにします。

```ts
async function runContextStillJob(): Promise<void> {
  const activity = await larm.getServiceActivity().catch(() => undefined);
  if (!activity || activity.state !== "idle" || activity.activeWorkloads !== 0) {
    return; // fail closed。retryAfterMs以降にqueueを再確認する。
  }

  await larm.withAgentConnection({
    agentProfile: "contextstill-background",
    explicitAgentProfile: true,
    audience: "saaa-desktop", // same hostなら same-host
    client: "contextstill",
    ttlSeconds: 300,
    allowFallback: false,
    deploymentPolicy: "existing-only",
  }, async (_connection, claim) => {
    const provider = claim.providers.find(({ name }) => name === "llm");
    if (!provider || provider.protocol !== "openai.chat-completions.v1") {
      throw new Error("ContextStill LLM provider is unavailable");
    }
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.credential.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: "background job" }],
        stream: false, // trueなら同じendpointからOpenAI互換SSEを受信できる。
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ContextStill Provider returned ${response.status}`);
    }
    await response.json(); // bodyを閉じてからConnectionを解放する。
  });
}
```

`openai.chat-completions.v1` Providerは要求形式を維持します。`stream: false`または省略時はJSON、
`stream: true`時は`text/event-stream`です。SSEを選んだ場合は`[DONE]`まで読み、response bodyを
閉じてからConnectionをrenewまたはreleaseしてください。claimの`streaming` fieldはSAAA Native
WebSocketの広告専用であり、HTTP SSEを使用するためには必要ありません。
