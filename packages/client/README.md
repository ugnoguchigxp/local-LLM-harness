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
