# local-LLM-harness

local-LLM-harness（LARM）は、Linux 上で動かす複数のローカル AI ランタイムを、ひとつの API から扱うためのコントロールプレーンです。LLM、Embedding、音声認識、音声合成などのランタイムを登録し、要求に合うものを選び、起動から解放までを管理します。

モデルや推論エンジンそのものは同梱しません。このリポジトリが管理するのは、ランタイムを安全に使い分けるためのソースコード、設定スキーマ、API、運用ロジックです。

## 何を解決するのか

複数のローカル AI ランタイムを直接使う構成では、利用側がモデルごとのポート、起動方法、空きメモリ、切り替え手順を把握しなくてはなりません。LARM はそれらを設定とバックエンドの内側に閉じ込め、通常の利用側にはOpenAI互換Gatewayを、管理・高度用途には明示的なAllocationを提供します。

```text
Client / Agent
  └─ Bearer、公開model、通常のOpenAI互換requestで推論を要求
                    │
                    ▼
                LARM daemon
  ├─ 公開modelから内部Allocationを取得するModel Broker
  ├─ registry / routing / admission / lifecycle
  └─ OpenAI-compatible Gateway
                    │
                    ▼
              systemd / llama-swap
                    │
                    ▼
              LLM / STT / TTS runtime
```

公開APIではリクエスト本文の `model` を、事前登録された一つの capability と routeへ解決します。Model Brokerが内部Allocationを取得し、一度選んだランタイムをリクエスト完了まで固定します。未登録modelや許可されていないfallbackは推論開始前に拒否します。

## 主な概念

| 用語 | 意味 |
| --- | --- |
| capability | `llm.general` や `speech.stt` など、利用側が必要とする機能 |
| runtime | 推論エンジン、プロトコル、エンドポイント、必要資源をまとめた実行単位 |
| route | capability をどの runtime 候補へ割り当てるかを定めた規則 |
| Allocation | 選択した runtime を一定時間固定する、期限付きの利用枠 |
| Gateway | Allocation に従ってリクエストを転送する共通 API |
| resident | 常駐を前提とし、LARM からの起動・停止対象にしない runtime |
| preferred | 必要に応じて起動し、未使用時に停止できる runtime |

## できること

- capability と route に基づく、決定的なランタイム選択
- 常駐ランタイムとオンデマンドランタイムの一元管理
- メモリ、同時実行数、キュー、swap group を考慮した admission control
- Allocation の作成、ready 待機、更新、解放、期限切れ回収
- OpenAI 互換の Chat Completions、音声認識、音声合成 Gateway
- `GET /v1/models`と、Bearer＋公開modelだけで利用できるChat Completions JSON／HTTP SSE
- systemd と llama-swap を介した状態監視とライフサイクル制御
- 許可リストに登録した成果物の検証、staging、切り替え、ロールバック
- Agent 向けの短期接続情報と、用途別 provider profile の発行
- query / passageを明示する、固定semantic spaceの動的Embedding Provider
- 独自transportを持たないOpenAI互換HTTP JSON／SSE経路
- ヘルスチェック、readiness、Prometheus メトリクス、OpenAPI 3.1 定義
- LLM・ASR・TTSの単体性能と3系統同時利用時の劣化を比較する診断ベンチマーク
- Allocation の後始末まで扱う TypeScript クライアント

## 対象外

LARM は、GPU ドライバ、推論エンジン、モデルのインストーラではありません。モデルの自動選定やクラウドへの暗黙 fallback も行いません。利用するランタイム、fallback 候補、配備可能な成果物は、運用者があらかじめ設定します。

また、モデルの重み、外部バイナリ、ビルド結果、キャッシュ、ログ、生成した音声は Git で管理しません。これらはリポジトリの外に配置してください。

## API

| 種類 | 主なエンドポイント |
| --- | --- |
| 稼働確認 | `GET /health`、`GET /ready` |
| 観測 | `GET /state`、`GET /metrics` |
| Allocation | `POST /v1/allocations`、`POST /v1/allocations/:id/renew`、`DELETE /v1/allocations/:id` |
| モデル一覧 | `GET /v1/models` |
| LLM | JSON／HTTP SSE: `POST /v1/chat/completions` |
| 音声 | `POST /v1/audio/transcriptions`、`POST /v1/audio/speech`、`GET /v1/audio/voices` |
| Embedding | `GET /v3/agent-profiles`で契約を発見し、Agent Connection claim後に`POST /v1/embed` |
| Agent 接続 | `/v1/agent-profiles`、`/v2/agent-profiles`、`/v3/agent-profiles`、`/v1/agent-connections` |
| 成果物とリリース | `/v1/artifacts`、`/v1/runtime-releases`、`/v1/deployments` |
| API 定義 | `GET /openapi.json` |

完全なリクエスト・レスポンス定義は、起動中の daemon が返す `/openapi.json` を正本として確認できます。

## 必要なもの

- Linux
- [Bun](https://bun.sh/) 1.4.0
- 別途用意した推論エンジンとモデル
- ノード、ランタイム、プロファイル、ルートを定義した YAML 設定
- 使用するバックエンドに応じて systemd または llama-swap

## セットアップ

依存関係をインストールし、リポジトリが正常な状態か確認します。

```bash
bun install --frozen-lockfile
bun run check
```

### 設定を用意する

`LARM_CONFIG_DIR` には次のファイルが必要です。ID、サービス名、ポート、モデル名、資源量は環境に合わせて定義します。

| ファイル | 内容 |
| --- | --- |
| `nodes.yaml` | ノードの API endpoint と利用可能なメモリ |
| `runtimes.yaml` | capability、プロトコル、backend、endpoint、資源制限 |
| `profiles.yaml` | 一緒に準備する capability の組み合わせ |
| `routes.yaml` | capability ごとの primary・fallback runtime |
| `agent-connections.yaml` | Agent に公開する provider profile と接続範囲 |

成果物の自動配備を使う場合は、取得元、サイズ、checksum、配置先を artifact manifest に、runtime と成果物の組み合わせを release catalog に記述します。daemon は起動時にすべての設定を検証し、未知の項目や矛盾した参照があれば起動しません。

設定の厳密なスキーマは、[`packages/core/src/schema.ts`](packages/core/src/schema.ts)、[`artifacts.ts`](packages/core/src/artifacts.ts)、[`releases.ts`](packages/core/src/releases.ts)、[`agent-connection.ts`](packages/core/src/agent-connection.ts) で確認できます。

### daemon を起動する

```bash
export LARM_CONFIG_DIR=/path/to/larm-config
export LARM_ARTIFACT_MANIFEST=/path/to/models.yaml
export LARM_RELEASE_CATALOG=/path/to/releases.yaml

bun run dev
```

既定では `127.0.0.1:9810` で待ち受けます。

```bash
curl http://127.0.0.1:9810/health
curl http://127.0.0.1:9810/ready
curl http://127.0.0.1:9810/openapi.json
```

`/health` はプロセスが応答できること、`/ready` は新しい要求を受け付けられることを表します。

## 最初のリクエスト

通常の利用側はAllocationを扱いません。固定base URL、Bearer、公開modelだけでHTTP SSEを逐次処理します。

```ts
import { LarmClient } from "./packages/client/src/index";

const client = new LarmClient({
  baseUrl: process.env.LARM_BASE_URL ?? "http://127.0.0.1:9810",
  apiToken: process.env.LARM_API_TOKEN,
});

for await (const event of client.streamChatCompletion({
  model: process.env.LARM_MODEL ?? "coding-default",
  messages: [{ role: "user", content: "Hello" }],
})) {
  for (const choice of event.choices) {
    if (typeof choice.delta.content === "string") process.stdout.write(choice.delta.content);
  }
}
```

コードをリポジトリ直下の `quickstart.ts` として保存した場合は、次のように実行できます。

```bash
LARM_MODEL=coding-default bun quickstart.ts
```

Model Brokerが内部Allocationの取得・固定・解放を行います。明示Allocationは管理・高度用途にだけ残します。LLM全文を待たず句単位でTTSを開始する音声例は [`examples/voice-client.ts`](examples/voice-client.ts) にあります。

Embeddingは短期Agent Connection専用です。`contextstill-embedding`を明示選択し、
`larm-embedding-provider-v1`形式でclaimしてください。claimにはendpoint、短期Bearer、
`intfloat/multilingual-e5-small`の固定revision、artifact digest、384次元、prefix、L2正規化、
tokenization / truncation契約、capacityが含まれます。TypeScript clientの`embed`はclaimのendpointだけを使い、
応答の件数・次元・有限値・L2 normを再検証します。

## 主な環境変数

| 環境変数 | 既定値 | 用途 |
| --- | --- | --- |
| `LARM_CONFIG_DIR` | リポジトリ内の既定設定 | runtime registry を置いたディレクトリ |
| `LARM_HOST` | `127.0.0.1` | daemon の待受アドレス |
| `LARM_PORT` | `9810` | daemon の待受ポート |
| `LARM_API_TOKEN` | 未設定 | 通常の API を保護するトークン |
| `LARM_SERVICE_HARNESS_AUTH_ENABLED` | `false` | SAAA Service Harness discovery・ASR health・batchにBearerを必須化 |
| `LARM_MANAGEMENT_TOKEN` | 未設定 | 成果物やリリースの管理 API を保護するトークン |
| `LARM_CONNECTION_SIGNING_KEY` | 未設定 | Agent 向け短期トークンの署名鍵 |
| `LARM_ARTIFACT_MANIFEST` | リポジトリ内の既定 manifest | 配備可能な成果物の許可リスト |
| `LARM_RELEASE_CATALOG` | リポジトリ内の既定 catalog | runtime のリリースカタログ |

タイムアウト、body サイズ、履歴件数にも個別の環境変数があります。すべて起動時に範囲検証され、不正な値では daemon を起動しません。

## セキュリティ

- 既定では loopback だけで待ち受けます。
- loopback 以外で待ち受ける場合は、`LARM_API_TOKEN` と `LARM_MANAGEMENT_TOKEN` の両方が必要です。
- `LARM_API_TOKEN` を設定すると通常APIでBearer認証が必要です。local-nodeで明示的に有効化したAgent Profile・Connection lifecycleだけは長期Bearerを省略できます。
- Service Harness認証は設定単位で切り替えます。`LARM_SERVICE_HARNESS_AUTH_ENABLED=false`ではBearer不要、`true`では`LARM_API_TOKEN`のBearerが必須です。
- 成果物、リリース、catalog の管理操作には、通常の API token とは別に management token が必要です。
- 管理 API は、リクエストから任意の URL、ファイルパス、サービス名、コマンドを受け取りません。事前に許可リストへ登録した対象だけを操作します。
- token、署名鍵、内部 endpoint をリポジトリへコミットしないでください。

## トラブルシューティング

- 起動直後に終了する場合は、標準エラーに表示された YAML ファイル名と項目を確認してください。設定は fail-closed で検証されます。
- `/health` が成功して `/ready` が `503` の場合は、observer の状態が古い、catalog の再読み込み中、または daemon が drain 中です。
- Allocation が失敗した場合は、そのレスポンスに加えて `/state` と `/metrics` を確認してください。runtime の状態、資源不足、同時実行数、許可されていない fallback などを切り分けられます。
- `401` または `403` の場合は API token と management token を取り違えていないか確認してください。

### 推論性能を測る

常駐Providerの性能診断には次を実行します。LLMのHTTP JSON、HTTP SSE、ASR、TTSを
個別に測った後、各HTTP応答形式と音声2系統を一つずつ同時に実行し、p50・p95、LLMの
TTFTと出力tokens/sec、ASR・TTSのRTF、単体比の劣化率をJSONで返します。
ASR用音声を指定しない場合は、計測開始前に通常TTSで非機密の固定音声を生成し、メモリ上だけで使用します。

```bash
set -a
source /etc/larm/larm.env
set +a
bun run perf:diagnostic
```

再現用の音声fixtureを固定し、結果をリポジトリ外へ保存する場合は次のように実行します。既存ファイルは
上書きしません。

```bash
LARM_PERF_AUDIO_FILE=/absolute/path/to/non-sensitive.wav \
LARM_PERF_OUTPUT=/srv/ai/logs/larm-performance/report.json \
LARM_PERF_ITERATIONS=10 \
bun run perf:diagnostic
```

`LARM_PERF_SCENARIOS=llm,llm-sse,asr,tts,mixed,mixed-sse`で対象を絞れます。`mixed-sse`はHTTP SSEを
音声2系統と同時に開始する実利用干渉テストです。JSON/SSE比較だけを行う場合は
`bun run benchmark:http-provider`を使います。同一Providerの飽和限界を探すstress testではありません。
詳しい測定契約は
[`specs/performance-benchmark.html`](specs/performance-benchmark.html)にあります。
評価専用CPU ASRをproduction routeへ組み込まず比較するときは、loopbackのOpenAI互換endpointを
`LARM_PERF_ASR_URL`へ指定できます。

## リポジトリ構成

| パス | 内容 |
| --- | --- |
| `apps/daemon` | Allocation、Gateway、監視、リリース管理を提供する daemon |
| `apps/*` | 音声認識・音声合成ランタイム向けのアダプター |
| `packages/core` | OS に依存しない registry、routing、Allocation のロジック |
| `packages/backends` | systemd、llama-swap、Linux telemetry との連携 |
| `packages/client` | v1 API を扱う TypeScript クライアント |
| `examples` | クライアントの利用例 |
| `specs` | API、設計、実装方針の文書 |

## 開発

```bash
bun run dev          # daemon を開発モードで起動
bun run perf:diagnostic # HTTP JSON/SSE LLM・ASR・TTSの単体／同時性能診断
bun run test         # テスト
bun run typecheck    # 型検査
bun run docs         # 設計文書をプレビュー
bun run docs:check   # 設計文書を検査
bun run check        # すべての検査を実行
```

変更を送る前に `bun run check` を実行してください。設計判断や仕様変更を残す場合は、`specs/` の文書も更新します。

## ライセンス

[MIT License](LICENSE)
