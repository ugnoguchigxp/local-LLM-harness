# Local AI Provider — コンセプト

コードネームは **LARM**（`@larm/*`）のままとする。製品として見せるものは Runtime Manager ではなく、**Agent Harness がそのまま繋ぐ Local LLM Provider** である。

## North Star

A local LLM provider that looks like an ordinary OpenAI-compatible API to agent harnesses (Codex, Claude Agent SDK, CLI, Ambient), while internally assembling the right runtime and replica: keep essential services hot, start optional ones when a request or an explicit prepare needs them, and route to what will finish soonest—without becoming a cluster orchestrator or an agent.

Agent SDK から見て普通の OpenAI 互換 Provider に見え、内部では Runtime の常駐・起動・replica 選択を組み立てる。普段使う AI は HOT に保ち、必要ならリクエスト（または明示的な `prepare`）で追加の Runtime を起こす。巨大な LLM Kubernetes にも、Coding Agent にもならない。

合格条件:

> Codex の設定が baseURL と論理モデル名だけになること。

内部の賢さは、そこに届いて初めてハーネスである。`/prepare` を Agent に要求した時点で、提供する形は変わっていない。

---

## 1. 解決する問題

ローカルで複数の AI モデル・サービスを運用すると、次が同時に起きる。

- LLM を常時起動すると RAM / 統一メモリを大量に消費する
- 必要になってからロードすると Cold Start が発生する（数秒〜数十秒以上）
- STT / TTS / Embedding / Vision / Coding Model など、用途ごとに Runtime が増える
- どれを常駐させ、どれを止められるのか判断が属人化する
- マシンを足すと、どの Node へ送るべきかクライアントが知る必要が出る
- **アプリケーションが個々のポート・実モデル名・replica に依存し、結合が複雑になる**

本プロジェクトはクラスタオーケストレーターを目指さない。個人または小規模環境で、

> Agent は論理モデルで話し、Provider がどの Runtime を HOT にし、どこへ流すかを決める

ことを目的とする。

現行の提供面は `proxy.js`（`:50043` / `:50041`、busy 時 503）である。クライアントは replica のポートを知っている。これを一つの Provider URL に畳むことが、再定義の最初の証拠である。

---

## 2. 位置づけ

Agent Intelligence と Inference Intelligence を混ぜない。

```text
Agent Harness
├─ Planning / Tool Use / Agent Loop
├─ Context / Memory retrieval
└─ Testing / Review
        │  OpenAI（必要なら後で Anthropic）互換
        ▼
Provider（本プロジェクト）
├─ Inference Gateway     ← 提供する形
├─ Logical Model
├─ Scheduler / resolve
├─ Lifecycle / leases
└─ Telemetry（後）
        │
        ▼
RuntimeBackend
├─ NSSM | systemd | llama-swap | Process | …
        │
        ▼
llama-server / その他 Runtime
```

Provider は Agent にならない。何を実装するか、どの Tool を使うか、何を Memory 検索するかは扱わない。

扱う範囲:

```text
Logical Model（公開）
Capability / Runtime Registry（内部）
Runtime State
Desired State（leases の合成 + リクエスト中の暗黙 lease）
Lifecycle
Replica Routing
Inference Gateway（LLM HTTP のプロキシ）
Prewarming（副経路）
```

Networking、Storage、Service Mesh、分散 Consensus、自前 LLM Runtime、KV Cache の所有は扱わない。

実態に近い表現:

> systemd / NSSM + Runtime Scheduler + OpenAI 互換 Gateway

概念的には小さな Kubernetes に似るが、Kubernetes を再実装しない。Resource を増やして「小さな Kubernetes」になることも拒む。

---

## 3. 原則

### Provision Form First

製品の変更は、Agent から見える契約が変わって初めて成立する。論理モデル・単一 baseURL・COLD/BUSY の扱いがそれに当たる。Cache / MTP / 量子化を内部 Resource にしても、公開面がポート直叩きなら再定義は起きていない。

### Keep It Small

個人プロジェクトとして扱える規模を維持する。機能は「今このマシンで困っていること」から足す。スキーマの数は再定義の証拠にしない。

### Gateway Is the Primary Contract

Agent SDK（Codex 等）の主経路は `GET /v1/models` と `POST /v1/chat/completions` である。制御 API（`/prepare` `/release` `/resolve` `/state`）は Ambient や診断用の副経路である。

### Core Remains Control Plane

`packages/core` は Registry / State / Desired / Plan / resolve に閉じる。トークン生成を再実装しない。`RuntimeBackend` に `generate()` を置かない。Gateway は選んだ endpoint へ HTTP をプロキシする。llama-server は既に OpenAI 互換である。

### Logical Model Outside, Capability Inside

公開名は `general` / `coding-fast` / `reasoning` のような論理モデルである。Capability（`llm.general`）と Logical Runtime（`qwen-general`）は内部の解決に使う。実モデル名・量子化名・ポートを Agent に出さない。

### Hot First, Completion Time over Tok/s

Cold な高性能より、十分な品質の HOT を優先する。Routing は理論上の tok/s ではなく、起動コストを含めた完了時間を見る。1 台では replica 間の BUSY 回避が実益である。2 台目が実在してからスコアを足す。

### Swap Only When Necessary

メモリに余裕があるなら、モデルを無意味に停止しない。入れ替えは Resource 不足か、今後必要となる構成が大きく変わる場合に限る。

### Always Keep the Interaction Path Alive

Ambient / 音声対話を前提にする環境では、最低限の Interaction Path を常に維持する。

```text
Audio Input → VAD → Streaming STT → General LLM
```

これらに対応する Runtime は Resident であり、通常の Resource Pressure では Eviction しない。gnosis では General LLM、Qwen3-ASR、VOICEVOX を Resident とする。GPUを共有する表現力重視の Qwen3-TTS は Preferred とし、通常応答の低遅延音声経路を守る。

### Backend-Agnostic

llama-swap は重要な LLM Backend だが Core ではない。Core は「何を HOT にするか」までを決める。プロセス寿命は Backend に委譲する。swap solver を TypeScript で再実装しない。

### Single Node First, Multi-Node Ready

最初は一台で完成させる。Node は Data Model の最初から持つ。分散 Consensus と Node Agent は今作らない。

### Predict Before React, React When the Agent Cannot Predict

明示的な `prepare` は残す。Ambient が「これから会議になる」と判断した時点で先に HOT にできる。本 Provider 自身はユーザー意図を推論しない。

一方、Codex は `/prepare` を呼ばない。Gateway 経由の推論リクエストは Preferred の ensure を起こしてよい。Resident への stop は API でも拒否する。

### Provider Does Not Decide User Intent

「何をしたいか」は Agent Harness が判断する。Provider の入力は論理モデル（内部では Capability）と Desired State である。

---

## 4. 提供する形

| 接点 | 今 | 目指す形 |
| --- | --- | --- |
| Base URL | `:50043` / `:50041`（replica をクライアントが選ぶ） | 一つの Provider URL |
| `model` | llama-server の実名 / `local-model` | 論理名（最初は `general`） |
| COLD | 502 / 接続失敗 | Gateway が ensure して待つ、または `Retry-After` 付き 503（待ち方針は Gateway 実装時に決める） |
| BUSY | `proxy.js` が 503 | Gateway が他の HOT replica へ振る |
| Ambient | `/prepare` `/resolve`（実装済み） | 残す。予測 warm-up 用。必須経路ではない |

STT / TTS / Embedding は、後で OpenAI の audio / embeddings 互換を足してよい。最初の提供面ではない。全 modality のストリームを Gateway が中継することは、今はやらない。

現行 `proxy.js` は Gateway が同等以上になるまで Data Plane として残す。壊れたらクライアントの baseURL を戻せば復帰できるよう、Gateway は当面 **別ポート** で立てる。daemon の制御 API は `127.0.0.1` のままとする。Gateway の LAN 公開は明示的に決めるまでしない。

---

## 5. 解決の層

```text
Logical Model          公開。例: general
        │
        ▼
Capability             内部。例: llm.general
        │
        ▼
Logical Runtime        例: qwen-general (resident), qwen-worker (preferred)
        │
        ▼
Deployment / Backend / Node
```

最初に公開する論理モデルは、Registry が満たせるものだけである。本マシンでは当面 `general`（→ `llm.general`）のみ。`coding-fast` 等は、それを満たす Runtime が登録されてから出す。未解決の論理モデルを `/v1/models` に並べない。

Logical Model は YAML の薄い alias で足りる。Model / ModelVariant / Cache / InferenceAsset を正式 Resource にするのは、Gateway に実トラフィックが乗ってから検討する。

---

## 6. 基本モデル（制御）

```text
Current Runtime State
        +
Desired Runtime State   ← 全 lease の和集合 + Resident 下限 + 進行中リクエストの暗黙 lease
        +
Available Resources
        ↓
Transition Plan
        ↓
Runtime Lifecycle
        ↓
Ready  →  Gateway が HTTP をプロキシ
```

例: 現在 General LLM A が HOT、B が HOT、STT / TTS が COLD のとき、VOICE の明示 lease が入ると、

```text
General LLM A     KEEP（Resident）
General LLM B     STOP if necessary（Preferred）
STT               START
TTS               START
```

という Transition を実行する。

Gateway の 1 リクエストは、対象 Runtime を処理中は止めない（暗黙 lease）。TTL 付きで短く持ってよい。後勝ちで Profile を上書きするモデルは採用しない。

---

## 7. Runtime の分類

### Resident

常時 HOT。通常の Resource Pressure では停止しない。Gateway も制御 API も Resident を stop しない。

初期想定（音声系は後続）:

```text
audio-input
vad
stt
general-llm          ← 本マシンでは Qwen 27B #1（qwen-general）
```

### Preferred

可能な限り HOT を維持する。空きが足りなければ停止できる。Gateway の COLD 経路と `prepare` が ensure してよい対象。

```text
general-worker       ← 本マシンでは Qwen 27B #2（qwen-worker）
tts
```

### Elastic

必要時に起動し、lease が消え TTL が過ぎれば解放できる。

```text
coding-llm
large-reasoner
embedding
reranker
diarization
translation
specialized-vision
```

同じモデルの複数インスタンスは、別 Capability ではなく **同一 Capability の replica** として扱う。本マシンの Qwen 2 本は `llm.general` の並列スロットであり、#1 が Resident、#2 が Preferred である。

---

## 8. Capability（内部）

内部の要求単位。論理モデルと WorkloadProfile がこれに展開される。

```text
llm.general
llm.coding
llm.reasoning
speech.stt
speech.stt.streaming
speech.tts
speech.diarization
embedding
reranking
vision
translation
```

制御 API の `/resolve` は Capability を受け取り、副作用なしで endpoint を返す（HOT 最優先、次に BUSY、Resident 優先）。Gateway の公開契約は論理モデルであり、Capability を Agent に要求しない。

---

## 9. Desired State は leases の和集合である

Desired State は世界に一つだけ存在する「今の Profile」ではない。複数の消費者が並走する。

- `POST /prepare` は明示 lease を作る。「少なくともこの Capability 集合を HOT にせよ」
- `POST /release` は lease を返す。即停止するとは限らない
- Gateway の進行中リクエストは暗黙 lease を持ってよい
- Desired = **全 active lease の Capability 和集合** + **Resident 下限**
- 空きがあっても Hot-first により Preferred は残してよい
- Resident は lease が空でも HOT を維持する

後勝ちで Profile を上書きするモデルは採用しない。優先度クラス（Ambient > 対話 > batch）は必要になってから足す。

---

## 10. 制御プレーンとデータプレーン

製品は **Gateway + Control Plane** である。Core は制御プレーンのままである。

```text
Clients / Agent Harnesses
        │
        ├─ POST /v1/chat/completions     主経路（Gateway）
        └─ POST /prepare 等              副経路（制御 API）
                │
                ▼
        apps/daemon
           ├─ packages/gateway     HTTP プロキシ。論理モデル → Runtime
           └─ packages/core        Registry / leases / planner / resolve
                │
                ▼
           RuntimeBackend
```

- Gateway は LLM の OpenAI 互換 HTTP をプロキシする。自前の token iterator を持たない
- 制御 API の `/resolve` は副作用なしを維持する。起動は `/prepare` または Gateway のリクエスト経路の責務
- STT ストリームなど全 modality を中継しない
- S0 時点の Gateway は未実装。現行 `proxy.js` を使う

---

## 11. Backend 境界

```text
Control Plane (Desired State / leases / class policy / resolve)
        ↓
RuntimeBackend
        ↓
NSSM | llama-swap | Process | …
```

Control Plane が持つもの:

- Logical Model → Capability → Logical Runtime
- WorkloadProfile と leases
- Resident 不変条件
- 予測的 prepare（リクエスト前）
- Gateway からの ensure 要求（Preferred のみ）
- Node 選択（将来）
- 非 LLM プロセスの Desired State

Backend に委譲するもの:

- プロセスの spawn / kill
- ポート割当
- health
- 同一 Node 内の同時起動制約（llama-swap matrix など）
- LLM に限った TTL の実行
- 実際の推論 HTTP（llama-server 等）

最初の本番 Backend は NSSM で動いているため **NssmBackend** とする。LlamaSwapBackend はコード上存在する。本番の寿命を llama-swap へ移すのは、Gateway が「選んだ endpoint へ流す」形になってから行う。

STT / VAD / 音声入力は llama-swap の対象外である。Resident Baseline に入れる前に ProcessBackend が必要である。

---

## 12. Runtime 状態

```text
COLD
STARTING
HOT
BUSY
STOPPING
FAILED
```

`HOT` は「Request を即時処理可能」。`BUSY` はプロセスは載っているがスロットがない（現行 `proxy.js` の `fail_on_no_slot` に相当）。Gateway は BUSY な Resident があっても、Preferred replica が HOT ならそちらへ振ってよい。

`WARM`（プロセスは生きているが accelerator から退避、など）は、Backend が実際にその操作を提供できるようになってから足す。今の llama-server + NSSM には相当する操作が無い。

`DRAINING` は必要になってから足す。

---

## 13. WorkloadProfile

よく使う Capability 集合に名前を付ける。制御 API の `prepare` 糖衣である。llama-swap の `profiles`（model-id rewrite）とは別物である。

初期想定:

```text
default    llm.general
voice      llm.general, speech.stt, speech.tts
meeting    llm.general, speech.stt, speech.diarization, translation
coding     llm.general, llm.coding
```

公開論理モデルとは別物である。Agent は `model=general` を送り、Ambient は `prepare { profile: "meeting" }` を送ってよい。

---

## 14. Node

MVP は 1 台で動作すればよい。Data Model 上は最初から Node を持つ。

```yaml
nodes:
  ai395-01:
    endpoint: http://127.0.0.1
```

将来マシンを足すときは Node 定義を増やす。分散 Consensus、専用 Cluster Manager、Node Agent は作らない。

---

## 15. 初期利用環境

```text
AMD Ryzen AI MAX+ 395
Unified Memory 128GB
Node id: ai395-01
```

現行本番:

```text
Qwen 3.8 27B  #1   resident    backend :50053  proxy :50043
Qwen 3.8 27B  #2   preferred   backend :50051  proxy :50041
```

実測（2026-08-17、Q3 二重常駐）では GPU dedicated 約 35GB、空き約 77GB。スケジューラが本領を発揮するのは、STT / TTS / Coder を足して空きが細くなってからである。

最初に解くのは「スクリプトとポート番号で運用していること」であり、公開面では「Agent が replica ポートを知っていること」である。論理モデルは当面 `general` 一つで足りる。選択の旨味は Coder か STT を足してから出る。それでも契約を先に置く。クライアント設定を書き換えさせるのは、Codex しか繋がっていない今が一番安い。

KV キャッシュはコンテキスト伸長に応じて膨らむ。現行メモリ監視は 1 プロセス 43GB 近傍を閾値にしている。`estimatedMemoryGB` は重みの目安にすぎず、ピークは観測値を優先する。

---

## 16. 技術方向

| 層 | 選定 |
| --- | --- |
| Language | TypeScript |
| Runtime | Bun |
| API | Hono |
| Schema | Zod |
| Configuration | YAML |
| 本番 Backend | NssmBackend（Qwen 2 本） |
| 実験 Backend | LlamaSwapBackend（コード済み。本番 config は nssm のまま） |
| 公開面 | OpenAI 互換 Gateway（プロキシ）。Anthropic 互換は Claude SDK を実クライアントにする直前まで遅らせる |
| State | メモリ。再起動後は Backend.list で再同期 |
| SQLite | leases がプロセス再起動を跨ぐ必要が出てから |

Core Domain は HTTP フレームワークと特定 Backend から分離する。Scheduler / resolve は純粋関数として単体テスト可能であること。これが Core 分離の合格条件である。

必要になるまで Microservice 化しない。単一 daemon で構成してよい。Gateway は同じプロセスの別 listen でも、`packages/gateway` として Core から分離する。

---

## 17. Non-Goals

現フェーズでは次を実装しない。

```text
Full Kubernetes replacement
Distributed consensus / etcd equivalent
Service Mesh / Container orchestration
Node Agent / 複数マシンの Scheduler
Cache を第一級 Resource にする / SSD KV の所有
ModelVariant / InferenceAsset を正式 Resource 化する
RuntimeAdapter.generate()
自前 LLM Runtime
llama-swap と同等の swap solver の再実装
MTP / 量子化の自動 Routing
Reasoning Governor
Agent Loop / Coding Agent / Agent Memory
Provider-side RAG / Episode Search / Context 仮想化
全 modality の推論プロキシ
Anthropic Messages を最初から第一級にする
AI による完全自律 Scheduler
Large-scale cloud serving
```

Cache 再利用・MTP・辞書・量子化選択は、Runtime の起動フラグや Adapter 設定として後から載せてよい。Control Plane の CRD にはしない。

---

## 18. ロードマップ（スライス）

S0（観測）と S1（leases / Preferred の ensure・stop / 副作用なし resolve）は実装済みである。次は提供面である。

| スライス | 成果 | やらない |
| --- | --- | --- |
| **S0 観測** | Registry + `GET /state`。NSSM 2 本が見える | （完了） |
| **S1 制御** | leases + `prepare` / `release`。Preferred だけ stop/start。`resolve` は副作用なし | （完了） |
| **G1 経路** | 別ポートの Gateway。`GET /v1/models` に論理名。`POST /v1/chat/completions` を HOT replica へプロキシ。BUSY なら他方。両方だめなら 503 | 起動しない。`proxy.js` は残す。Resident に触らない |
| **G2 起動** | COLD なら `qwen-worker` だけ ensure してから流す。進行中リクエストは暗黙 lease | Resident の stop。待ち時間方針（長待ち vs `Retry-After`）をここで決める |
| **S2 委譲** | 本番 Runtime の寿命を llama-swap へ移す（Backend 実装は既にある） | 全 PowerShell の一括廃止はしない。Gateway より先に本番を移さない |
| **S3 拡張** | ProcessBackend と STT Resident。必要なら STT 辞書は Adapter 設定として | InferenceAsset CRD。2 台目 Node は要求が出てから |

G1 の段階で「Agent はポートではなく論理モデルで話す」は達成される。再定義の最初の証拠はここである。

計画の正本のうち、完了分は [spec/milestone-0.md](../spec/milestone-0.md) と [spec/api.md](../spec/api.md)。S2 は [spec/milestone-2.md](../spec/milestone-2.md)。次スライスの契約は [spec/architecture.md](../spec/architecture.md) の決定事項に従う。
