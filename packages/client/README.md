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
提供します。claimされた短期tokenはLARM clientの長期control tokenと混ぜず、返された
`baseUrl`と`model`へそのまま設定します。

```ts
const larm = new LarmClient({
  baseUrl: "http://127.0.0.1:9810",
  apiToken: process.env.LARM_API_TOKEN,
});
const created = await larm.createAgentConnection({
  agentProfile: "deep-reasoning-35b",
  audience: "saaa-desktop",
});
const ready = await larm.waitForAgentConnection(created);

try {
  const claim = await larm.claimAgentConnection(ready.id);
  const llm = claim.providers.find((provider) => provider.name === "llm");
  // OpenAI clientへ llm.baseUrl、llm.model、llm.credential.token を設定する。
} finally {
  await larm.releaseAgentConnection(ready.id);
}
```
