# @larm/client

OpenAI互換HTTP APIと、管理・高度用途向けAllocation lifecycleを扱う参照TypeScript clientです。Route判断、暗黙fallback、
release選択、Cloud fallbackは行いません。Idempotency-Key、poll、renew、boot epoch変更、timeout、
AbortSignal、確実なreleaseを一か所で扱います。pollの全体期限は進行中のHTTPにも適用し、処理と
releaseが両方失敗した場合は双方を含む`AggregateError`を返します。

音楽・画像・LLM・TTS・ASRの対象APIでは、4 KiB以上の文字列本文とASRのWAV・PCM multipartを、
元より小さくなる場合にgzipで送信します。旧LARMへ接続するときは`requestCompression: false`を指定してください。
応答のgzip交渉・逐次展開は標準fetchが担当します。独自fetchにも同じ動作が必要です。
SSEとWAV・PCM応答は途中から展開できます。PNG・JPEG・Opusなどの圧縮済みメディアと判断APIは再圧縮しません。
詳しくは[双方向HTTP圧縮の契約](../../specs/http-media-compression-2026-10-17.html)を参照してください。

音楽・画像などを直接fetchする場合も、公開helperで同じ送信圧縮を利用できます。

```ts
import { compressLarmMediaRequest } from "@larm/client";

const path = "/v1/images/generations";
const init = await compressLarmMediaRequest(path, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify(imageRequest),
  signal,
});
const response = await fetch(`${baseUrl}${path}`, init);
```

```ts
import { LarmClient } from "@larm/client";

const larm = new LarmClient({
  baseUrl: "http://127.0.0.1:9810",
  apiToken: process.env.LARM_API_TOKEN,
});
for await (const event of larm.streamChatCompletion({
  model: "ornith-1.5-strix-lean",
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

Agent Connection作成時の`providers`は任意です。省略時はProfile全体を準備し、指定時はそのProviderだけを
allocate、semantic probe、claimします。たとえばSAAAの単発LLM実行は`providers: ["llm"]`、短い応答だけなら
`providers: ["backchannel"]`を指定すると、無関係なProviderのbusy状態にreadyが阻害されません。

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
if (!models.data.some(({ id }) => id === "ornith-1.5-strix-lean")) {
  throw new Error("Requested public model is not available");
}
for await (const event of larm.streamChatCompletion({
  model: "ornith-1.5-strix-lean",
  messages: [{ role: "user", content: "hello" }],
})) {
  // iteratorはUTF-8境界、chunk schema、finish、data: [DONE]をfail closedで検証する。
}

```

ContextStillの標準接続は公開selector `contextStill` を指定し、claim応答の接続情報を使います。
`contextstill-background` は Ornith 1.5 ROCmFP4の `llm`、Layaの `system-one`、E5の `embedding` を提供します。
LLMは1プロセスに64K相当のKV枠を4セッション分確保し、LARMも4並列を許可します。
各要求は入力＋生成で32,768 token以内です。送信前に実tokenizerで全入力を数え、
4,096 tokenの出力を予約する場合は入力を28,672 token以内にしてください。

以下の固定モデル指定とQwen tier選択は旧consumerの互換経路についての説明です。

ContextStillの背景jobは固定LARM URL、Bearer、`qwen-agent-worker` modelで通常のChat Completionsを使います。
旧static portやclaim済みURLを永続化しません。Provider取得・loading・busyはjob failure attemptへ加算せず、
LARMのrelease/config/boot identityが変わった後のcanary成功時だけinfra起因paused jobを一件から再開します。
NightWorkerは`qwen-nightworker`を使います。daemon側のProfile優先度はSAAA 3000、NightWorker 2000、
ContextStill 1000で、実行中jobの完了後に高い値から次のProviderまたは実行枠へ進みます。

新規ContextStill統合では、最終的に送るsystem prompt、tool schema、履歴、検索結果、現在入力を実modelの
tokenizerで数え、`promptTokens + max_tokens + safetyMarginTokens`で最小tierを選びます。`max_tokens`の
既定上限は4,096、safety marginは1,976 tokenです。59,464 input token以下は
`qwen-contextstill-64k`、59,465〜125,000 input tokenは`qwen-contextstill-128k`を指定します。
両tierは同じQwen3.8-27B Q4_0 main weightとMTPを使い、windowだけが異なります。
125,000 input tokenを超える要求は、履歴を暗黙に削らずfail closedにします。現行hostには受入済み256K
Providerがないため、`qwen-contextstill-256k`は公開しません。既存`qwen-agent-worker`は互換modelとして
維持されますが、Context Windowによる選択contractを表さないため新規consumerでは使用しません。

```ts
function contextStillModel(promptTokens: number, maxOutputTokens: number): string {
  if (!Number.isInteger(promptTokens) || promptTokens < 0) throw new Error("invalid prompt token count");
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 4096) {
    throw new Error("unsupported ContextStill output budget");
  }
  const required = promptTokens + maxOutputTokens + 1976;
  if (required <= 65536) return "qwen-contextstill-64k";
  if (required <= 131072) return "qwen-contextstill-128k";
  throw new Error(`ContextStill request needs ${required} tokens; largest accepted window is 131072`);
}
```

## SAAA Provider選択

SAAAは対象Agent Profileを作成し、必要なProvider subsetを指定します。特定のモデル、内部runtime、portを
clientへ固定せず、claimで返された`model`、`baseUrl`、短期credential、context windowを使用します。
次は、claimで`qwen3.8`が返された場合の通常Chat例です。

```ts
for await (const event of larm.streamChatCompletion({
  model: "qwen3.8",
  messages: [{ role: "user", content: "hello" }],
})) {
  // 実体のruntimeはLARMが要求とpolicyから解決する。
}
```

snapshotを実際に利用する場合は、事前に明示Allocationを取得し、`createContext()`と
`createContextView()`で同じAllocationへsourceとViewをbindしてから、
`chatWithContext(allocation.id, view.id, body, "llm.coding")`を使用します。Viewは一回だけconsumeされます。
ContextStillではこの経路を選ばず、従来どおり`qwen-agent-worker`を使用します。

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

### Claimed LLM image input

Read the LLM Provider's `chatInput` in v3 discovery and claim. It advertises JPEG,
PNG and uncompressed BMP data URLs, raw-image dimensions and bytes, request and
history image counts, token counting, and the configured inference-audit payload
retention. The current retained Ornith profile is `ornith1.5Strix`; do not request
the retired `ornith1.5Strix-64k` selector.

A backend can call `client.countChatInputTokens(chatRequest, provider.credential.token)`
before inference. It uses the same complete `messages`, tools and `max_tokens` as
Chat Completions. `promptTokens` includes image embeddings; `textTokens` includes
role/template/tool tokens. Check `fits` and `inputBudgetTokens`, then submit the
same request to the claimed Provider. Generation counts again and rejects an
excess with `context_budget_exceeded`; the preflight is not a capacity reservation.
The count-only operation does not retain the request payload and never generates
an answer. No automatic retry is made for this POST or for inference.

Send images as ordered `content` parts with `type: "image_url"` and
`image_url.url: "data:image/png;base64,..."` in user messages. Text parts are optional.
Read saved bytes in your backend; authenticated consumer image URLs and upload IDs
are not accepted by this contract. Resend necessary history image parts on each
request. Do EXIF orientation correction, color management and alpha compositing
in the consumer when those are needed: the Provider reads encoded pixels and
converts to RGB, discarding alpha. Credentials stay in the consumer backend.
