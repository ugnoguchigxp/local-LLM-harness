# アーキテクチャ

## 1. 決定事項

後から覆すと Core が作り直しになる。北極星は [docs/CONCEPT.md](../docs/CONCEPT.md)。

### D1. Desired State は lease の和集合

`prepare` は世界を上書きしない。lease を追加し、Desired は全 active lease の Capability 和集合に Resident 下限を足したものである。`release` は即停止ではなく lease 返却。Hot-first により、空きがあれば Preferred は残してよい。

Gateway の進行中リクエストは暗黙 lease を持ってよい（G2）。後勝ち Profile は採用しない。

### D2. 製品は Gateway + Control Plane。Core は制御プレーンのまま

`packages/core` は Registry / State / Desired / Plan / resolve / Backend 呼び出しに閉じる。`RuntimeBackend.generate()` は置かない。全 modality の推論を中継しない。

Agent から見た主契約は OpenAI 互換 Gateway である。Gateway は選んだ Runtime の `deployment.endpoint` へ HTTP をプロキシする。llama-swap の `/v1` や `proxy.js` は **upstream** であり、Agent 向けの公開面ではない。

制御 API（`/prepare` `/resolve` 等）は副経路。`/resolve` は副作用なしを維持する。起動は `/prepare` または Gateway のリクエスト経路（G2）の責務。

G1 まで現行 `proxy.js` を残す。Gateway は別ポートで立て、壊れたらクライアントの baseURL を戻せるようにする。

### D3. 最初の本番 Backend は NssmBackend。llama-swap は実行器として載せる

本番の Qwen 2 本は NSSM サービスである。S0 は観測。S1 で Preferred の stop/start を NssmBackend 経由で実証済み。LlamaSwapBackend はコード上存在する。本番 config は **nssm のまま**。`backend: llama-swap` を選んだ Runtime だけ LlamaSwapBackend が扱う。本番 NSSM プロセスと llama-swap が同じ 27B を奪い合わないよう、実験用 listen は `127.0.0.1:9292`、upstream は `58000` 台とする。

S2 で LLM 寿命を llama-swap へ移すのは、Gateway が「選んだ endpoint へ流す」形になってから。Scheduler は「どの Logical Runtime を HOT にしたいか」までを決める。llama-swap の matrix / TTL / preload と同じ swap solver を TypeScript で書かない。

### D4. 同じモデルの複数本は replica

`qwen-general` と `qwen-worker` は別 Capability ではない。どちらも `llm.general` を満たし、class だけが resident / preferred と異なる。

### D5. 状態の再同期

daemon の状態はメモリに持つ。再起動後は Backend.list と health で再構築する。SQLite は leases が再起動を跨ぐ必要が出てから。

### D6. 公開名は Logical Model。Capability は内部

Agent に出す `model` は `general` のような論理名である。Capability（`llm.general`）と Runtime id（`qwen-general`）は内部解決に使う。満たせない論理モデルは `/v1/models` に出さない。ModelVariant はまだ作らない。

### D7. Resident は stop しない

`qwen-general` への stop は制御 API でも Gateway でも拒否する。ensure/stop の対象は Preferred（`qwen-worker`）のみ。

---

## 2. 論理配置

```text
apps/daemon          Hono。YAML を読み、Core を呼び、制御 API と（G1 以降）Gateway を出す
packages/core        Registry / State / leases / planner / resolve
packages/backends    NssmBackend, LlamaSwapBackend, RoutingBackend
packages/gateway     OpenAI 互換プロキシ。G1 で追加。Core に置かない
config/              nodes.yaml, runtimes.yaml, profiles.yaml, llama-swap.yaml
                     G1 で models.yaml（論理モデル alias）を足してよい
```

`atomic-llama-cpp-turboquant/`、`models/`、既存 `.ps1` はソースツリーに取り込まない。config からパスやサービス名で参照するだけである。

```text
Codex / Claude / CLI / Ambient
        │  /v1/chat/completions（主）    /prepare 等（副）
        ▼
   apps/daemon
        ├─ gateway（G1+）
        └─ control API
                │
                ▼
           packages/core
                │
                ▼
           RuntimeBackend
                │
                ▼
           NSSM / llama-server / llama-swap
```

Core は `hono` も OS 固有 API も import しない。Backend の interface にだけ依存する。Gateway は Core の resolve /（G2）ensure を呼び、推論本文は Runtime へプロキシする。

---

## 3. RuntimeBackend

```ts
interface RuntimeBackend {
  list(): Promise<RuntimeInstance[]>;
  health(runtimeId: string): Promise<RuntimeHealth>;
  ensure(runtime: RuntimeDefinition): Promise<RuntimeInstance>; // S1+
  stop(runtimeId: string): Promise<void>;                       // S1+
}
```

`generate()` は足さない。S1 以降、daemon は Preferred に対して `ensure` / `stop` を呼ぶ。Resident は Backend が拒否する。

### NssmBackend

各 Logical Runtime の Deployment から、Windows サービス名と health 用ポートを知る。

| 観測 | 判定の使い方 |
| --- | --- |
| `GET http://127.0.0.1:{healthPort}/health` が `"status":"ok"` | HOT |
| 同上 + `fail_on_no_slot=true` が 503 | BUSY |
| TCP は listen しているが `/health` が ok でない | STARTING |
| サービス Running だが listen していない | STARTING |
| サービス Stopped / ポート閉 | COLD |
| サービスが存在しない、または Running なのに長時間 health 失敗 | FAILED |

サービス状態の取得に管理者権限が要る場合がある。**HTTP health を HOT 判定の一次ソースにする。** NSSM / `Get-Service` は COLD と STARTING と FAILED の切り分けに使う。取れなければ `unknown` をサービス状態として残し、ポートと HTTP だけで判定する。

S1 以降は Preferred のみ `nssm start|stop` する。Resident は拒否する。

### LlamaSwapBackend

`backend: llama-swap` の Runtime だけを扱う。llama-swap プロセス自体は daemon が起動しない。

| 観測 | 判定の使い方 |
| --- | --- |
| `GET {listen}/running` が `ready` かつ `{listen}/upstream/{modelId}/health` が `"status":"ok"` | HOT |
| 同上 + `fail_on_no_slot=true` が 503 | BUSY |
| `/running` が `starting` | STARTING |
| モデルが running に無い、または `stopped` | COLD |
| llama-swap の listen に届かない | COLD（service `Unknown`） |

`ensure` は `POST /api/models/load/{modelId}`（無ければ `GET /upstream/{modelId}/health` で warm）。`stop` は `POST /api/models/unload/{modelId}`。Resident は拒否する。同時 2 replica は llama-swap の matrix `g & w` に委譲する。

llama-swap の `/v1` は upstream である。Agent 向けの OpenAI 互換面は G1 の Gateway に置く。Gateway が無い間は実験クライアントが llama-swap `/v1` を直接叩いてよい。

daemon は Runtime ごとに Backend を振り分ける RoutingBackend を使う。本番 `config/runtimes.yaml` がすべて nssm なら NssmBackend だけが動く。

---

## 4. 観測ループ

daemon は起動時に YAML を読み、Registry をメモリに載せる。以降、短い間隔（初期 2 秒）で Backend.list / health を回し、Runtime State を更新する。`GET /state` は最後の観測スナップショットを返す。観測そのものをリクエストパスで同期実行してもよいが、health のタイムアウトを積み重ねて応答が遅くならないようにする。

現行 `Wait-LlmHttpHealth` と同様、ロード中は `/health` が数十秒失敗し続ける。これを FAILED に落とす猶予は **起動後 300 秒** を初期値とし、config で変える。

---

## 5. 次のパッケージ

```text
packages/gateway/              G1。OpenAI 互換プロキシ。起動はしない（G2 で Preferred ensure）
packages/backends/process/     S3。STT 等
```

空のパッケージをマイルストーンより先に作らない。`proxy.js` は G1 が同等になるまで残す。
