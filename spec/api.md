# HTTP API

制御 API は `http://127.0.0.1:9810` を初期 listen とする（config で変更可）。LAN 公開はしない。バインドは `127.0.0.1`。

Agent から見た **主契約は G1 以降の OpenAI 互換 Gateway**（別ポート）である。本ファイル前半の `/prepare` `/resolve` 等は Ambient と診断用の副経路である。

エラーは次の形に揃える。

```json
{
  "error": {
    "code": "not_found",
    "message": "runtime qwen-coder is not in the registry"
  }
}
```

未実装の将来エンドポイントは `501`。存在しないパスは `404`。

S0 と S1 は実装済み。

---

## S0 で実装する

### `GET /health`

daemon 自身の liveness。Backend の成否では 5xx にしない。

```json
{ "status": "ok" }
```

### `GET /runtimes`

Registry の静的定義。観測状態は含めない。

```json
{
  "runtimes": [
    {
      "id": "qwen-general",
      "capability": ["llm.general", "llm.reasoning"],
      "backend": "nssm",
      "node": "ai395-01",
      "policy": { "class": "resident" },
      "resources": { "estimatedMemoryGB": 24 },
      "deployment": {
        "service": "llama-qwen-27b-backend",
        "healthPort": 50053,
        "endpoint": "http://127.0.0.1:50043",
        "backendEndpoint": "http://127.0.0.1:50053"
      }
    }
  ]
}
```

### `GET /state`

最後の観測スナップショット。[data-model.md](./data-model.md) の `ClusterState`。

成功時は常に `200`。個別 Runtime が FAILED でも、daemon としては 200 で本体に載せる。

### `GET /runtimes/:id`

Registry の 1 件。無ければ `404`。

---

## S1 で実装する

### `POST /prepare`

lease を追加する。「少なくともこの Capability 集合を HOT にせよ」。Resident は起動しない。Capability がどれも HOT でなく、Preferred で賄えるなら `qwen-worker` を ensure する。

```json
{ "profile": "default" }
```

または

```json
{
  "capabilities": ["llm.general"],
  "client": "ambient"
}
```

すでに HOT なら `200`:

```json
{
  "leaseId": "lease_...",
  "desired": ["llm.general", "llm.reasoning"],
  "ready": true,
  "runtimes": ["qwen-general"]
}
```

ロードが必要なときは `202`:

```json
{
  "leaseId": "lease_...",
  "operationId": "op_...",
  "desired": ["llm.general", "llm.reasoning"],
  "ready": false,
  "runtimes": ["qwen-worker"]
}
```

Registry に存在しない Capability（例: `meeting` の `speech.stt`）は lease を作らず `409` `unsatisfiable`。未知の profile は `404`。

### `GET /operations/:id`

`202` で返した operation の経過。`succeeded` かつ `ready: true` なら ensure 完了。

### `POST /release`

lease を返す。即停止しない。アクティブな lease が 0 になり、Preferred が他の HOT Runtime で代替できるときだけ、TTL（既定 60 秒、`LARM_PREFERRED_IDLE_TTL_SECONDS`）後に `qwen-worker` を stop する。Resident は停止しない。

```json
{ "leaseId": "lease_..." }
```

### `POST /resolve`

副作用なし。HOT を最優先、次に BUSY。Resident を Preferred より優先。HOT/BUSY が無ければ `503` `not_ready`。

```json
{ "capability": "llm.general" }
```

```json
{
  "runtime": "qwen-general",
  "node": "ai395-01",
  "endpoint": "http://127.0.0.1:50043",
  "status": "HOT"
}
```

---

## G1 で実装する（主契約）

別ポート。制御 API の `9810` は触らない。現行 `proxy.js`（`:50043` / `:50041`）は残す。**起動・停止はしない。**

### `GET /v1/models`

論理モデルの一覧。満たせない alias は出さない。最初は `general`（内部 Capability `llm.general`）のみ。

### `POST /v1/chat/completions`

`model` を論理名として解決し、HOT な replica の `deployment.endpoint` へ HTTP をプロキシする。BUSY なら他の HOT replica。HOT が無く BUSY だけなら BUSY へ。どちらも無ければ `503`。ストリームはそのまま通す。トークン列を自前で組み立てない。

llama-server の API キーは Gateway が upstream へ転送する。制御 API のキーとは混ぜない。

---

## G2 で実装する

G1 と同じ経路に、COLD 時の Preferred ensure を足す。対象は `qwen-worker` のみ。Resident は stop しない。進行中リクエストは暗黙 lease。ロードが長いときの待ち vs `Retry-After` 503 は、このスライスで決めて文書化する。

---

## 認証

制御 API は localhost のみ。API キーは付けない。llama-server 側の `sk-local-ai-max-395` は制御 API とは別物であり、読まない・ログに出さない。Gateway は推論リクエストの Authorization を upstream へ渡す。
