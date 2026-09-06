# @larm/client

OpenAI互換HTTP APIと、管理・高度用途向けAllocation lifecycleを扱う参照TypeScript clientです。Route判断、暗黙fallback、
release選択、Cloud fallbackは行いません。Idempotency-Key、poll、renew、boot epoch変更、timeout、
AbortSignal、確実なreleaseを一か所で扱います。pollの全体期限は進行中のHTTPにも適用し、処理と
releaseが両方失敗した場合は双方を含む`AggregateError`を返します。

```ts
import { LarmClient } from "@larm/client";

const larm = new LarmClient({
  baseUrl: "http://127.0.0.1:9810",
  apiToken: process.env.LARM_API_TOKEN,
});
for await (const event of larm.streamChatCompletion({
  model: "coding-default",
  messages: [{ role: "user", content: "hello" }],
})) {
  // 検証済みdeltaをUIや句単位TTSへ即時に渡す。
}
```

音声を含む完全な例は[`../../examples/voice-client.ts`](../../examples/voice-client.ts)を参照してください。
API tokenとmanagement tokenは別設定で、通常requestへmanagement tokenを送信しません。daemonのboot
epochが変わった場合は自動retryせず`LarmEpochChangedError`を返します。標準HTTP consumerは重複副作用を
確認してから次requestを新規送信し、legacy Allocation利用者だけが再Allocationします。

移行期間の管理・rollback用途として、Profile一覧、Connection作成・poll、semantic health、claim、renew、releaseも型付きで
提供します。claimされた短期tokenはLARM clientの任意な長期control tokenと混ぜず、返された
`baseUrl`と`model`へそのまま設定します。Agent Connection lifecycleは`apiToken`を省略でき、Clientは
その場合Authorization headerを送りません。新しいSAAA／ContextStill consumerはこのlifecycleを使わず、通常の
Allocation、Gateway、管理APIは引き続き認証必須です。`getHealth()`と`getReadiness()`もAuthorization
headerを送らず、host到達不能とhost非readyを分離します。最後に観測したresponse headerは
`observedConfigRevision`と`observedBootEpoch`で確認できます。

```ts
const gatewayUrl = process.env.LARM_BASE_URL;
if (!gatewayUrl) throw new Error("LARM_BASE_URL must come from host discovery or operator configuration");
const larm = new LarmClient({
  baseUrl: gatewayUrl,
  apiToken: process.env.LARM_API_TOKEN,
});

const health = await larm.getHealth();
const readiness = await larm.getReadiness();
if (health.status !== "ok" || readiness.status !== "ready") {
  throw new Error("LARM is not ready");
}

const models = await larm.listOpenAiModels();
if (!models.data.some(({ id }) => id === "coding-default")) {
  throw new Error("Resident Qwen model is not available");
}
for await (const event of larm.streamChatCompletion({
  model: "coding-default",
  messages: [{ role: "user", content: "hello" }],
})) {
  // iteratorはUTF-8境界、chunk schema、finish、data: [DONE]をfail closedで検証する。
}

```

ContextStillの背景jobは固定LARM URL、Bearer、`qwen-agent-worker` modelで通常のChat Completionsを使います。
旧static portやclaim済みURLを永続化しません。Provider取得・loading・busyはjob failure attemptへ加算せず、
LARMのrelease/config/boot identityが変わった後のcanary成功時だけinfra起因paused jobを一件から再開します。
NightWorkerは`qwen-nightworker`を使います。daemon側のProfile優先度はSAAA 3000、NightWorker 2000、
ContextStill 1000で、実行中jobの完了後に高い値から次のProviderまたは実行枠へ進みます。

```ts
async function runContextStillJob(): Promise<void> {
  const activity = await larm.getServiceActivity().catch(() => undefined);
  if (!activity || activity.state !== "idle" || activity.activeWorkloads !== 0) {
    return; // fail closed。retryAfterMs以降にqueueを再確認する。
  }

  const response = await larm.createChatCompletion({
    model: "qwen-agent-worker",
    messages: [{ role: "user", content: "background job" }],
    stream: false,
  });
  await response.json();
}
```

`openai.chat-completions.v1` Providerは要求形式を維持します。`stream: false`または省略時はJSON、
`stream: true`時は`text/event-stream`です。SSEを選んだ場合は`[DONE]`まで読み、response bodyを
閉じてください。claimの`streaming` fieldやAgent ConnectionはHTTP SSEを使用するためには必要ありません。
