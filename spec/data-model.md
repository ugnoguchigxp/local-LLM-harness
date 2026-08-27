# データモデル

永続化されるのは YAML だけである。実行時 State と Lease はメモリ。Logical Model は G1 で YAML alias として足す。

## 1. Node

`config/nodes.yaml`

```yaml
nodes:
  ai395-01:
    displayName: AMD Ryzen AI MAX+ 395
    endpoint: http://127.0.0.1
    resources:
      memoryTotalGB: 128
      reservedMemoryGB: 16
```

| フィールド | 必須 | 意味 |
| --- | --- | --- |
| `endpoint` | yes | その Node 上の Manager または推論到達点のベース。S0 は localhost |
| `resources.memoryTotalGB` | yes | 統一メモリ総量の宣言値 |
| `resources.reservedMemoryGB` | yes | Scheduler が触らない枠（OS 等）。S0 では表示のみ |

S0 では Node は 1 件。複数あっても、観測対象は `runtimes[].node` が指すローカル Node だけ。

## 2. Logical Runtime

`config/runtimes.yaml`

本マシンの初期定義:

```yaml
runtimes:
  qwen-general:
    capability:
      - llm.general
      - llm.reasoning
    backend: nssm
    node: ai395-01
    policy:
      class: resident
    resources:
      estimatedMemoryGB: 24
    deployment:
      service: llama-qwen-27b-backend
      healthPort: 50053
      endpoint: http://127.0.0.1:50043
      backendEndpoint: http://127.0.0.1:50053

  qwen-worker:
    capability:
      - llm.general
    backend: nssm
    node: ai395-01
    policy:
      class: preferred
    resources:
      estimatedMemoryGB: 24
    deployment:
      service: llama-qwen-27b-2-backend
      healthPort: 50051
      endpoint: http://127.0.0.1:50041
      backendEndpoint: http://127.0.0.1:50051
```

| フィールド | 必須 | 意味 |
| --- | --- | --- |
| `capability` | yes | この Runtime が満たす Capability。1 つ以上 |
| `backend` | yes | `nssm` \| `llama-swap` |
| `node` | yes | `nodes.yaml` のキー |
| `policy.class` | yes | `resident` \| `preferred` \| `elastic` |
| `resources.estimatedMemoryGB` | yes | 重み + 典型 KV の目安。ピーク観測値ではない |
| `deployment.service` | nssm 時 yes | Windows サービス名 |
| `deployment.proxyService` | nssm 時 no | proxy の NSSM 名。ensure/stop で backend の前後に扱う |
| `deployment.healthPort` | nssm 時 yes | llama-server の `/health` |
| `deployment.modelId` | llama-swap 時 yes | llama-swap の models キー |
| `deployment.listen` | llama-swap 時 yes | llama-swap のベース URL |
| `deployment.endpoint` | yes | 推論 HTTP の到達点。nssm 時は現行 proxy。Gateway はここへプロキシする |
| `deployment.backendEndpoint` | no | 実サーバ。llama-swap 時は `/upstream/{modelId}` を推奨 |

proxy サービス（`llama-qwen-27b-proxy` 等）は Logical Runtime にしない。推論プロセスの寿命と health だけを Runtime として扱う。proxy が落ちて backend が生きている場合、S0 では endpoint の TCP を見て `degraded` ヒントを付けてもよいが、必須ではない。state の一次は backend health とする。

## 3. WorkloadProfile

`config/profiles.yaml`

S1 の `prepare` は profile 名を Capability 集合に展開する。未知 Capability を含む profile は `409` `unsatisfiable`。

```yaml
profiles:
  default:
    require:
      - llm.general
  coding:
    require:
      - llm.general
      - llm.coding
  voice:
    require:
      - llm.general
      - speech.stt
      - speech.tts
  meeting:
    require:
      - llm.general
      - speech.stt
      - speech.diarization
      - translation
```

S1 以降、未知 Capability を含む profile は `prepare` で `409` `unsatisfiable`。

## 4. Logical Model（G1）

Agent に見せる公開名。Capability への薄い alias。ModelVariant ではない。

`config/models.yaml`（G1 で追加）:

```yaml
models:
  general:
    capability: llm.general
```

| フィールド | 必須 | 意味 |
| --- | --- | --- |
| `capability` | yes | この論理モデルが要求する内部 Capability。1 つ |

`/v1/models` には、Registry にその Capability を満たす Runtime があるものだけを出す。本マシンの初期は `general` のみ。`coding-fast` 等は、対応 Runtime が登録されてから足す。

制御 API は引き続き Capability / WorkloadProfile を使う。Agent には論理モデル名だけを要求する。

## 5. Runtime State

メモリ上の観測結果。YAML には書かない。

```ts
type RuntimeStatus =
  | "COLD"
  | "STARTING"
  | "HOT"
  | "BUSY"
  | "STOPPING"
  | "FAILED";

type RuntimeSnapshot = {
  id: string;
  status: RuntimeStatus;
  class: "resident" | "preferred" | "elastic";
  capability: string[];
  node: string;
  backend: string;
  endpoint: string;
  backendEndpoint?: string;
  service?: string;
  observedAt: string; // ISO-8601
  health?: {
    httpStatus?: number;
    ok: boolean;
    detail?: string;
  };
};
```

判定規則は [architecture.md](./architecture.md) の NssmBackend / LlamaSwapBackend 節に従う。

S0 に `STOPPING` は原則出ない（自分では止めない）。手動で `stop_servers.ps1` を叩いた直後は COLD へ落ちる。llama-swap の `stopping` も COLD 側に畳む。

## 6. Cluster State（GET /state の中身）

```ts
type ClusterState = {
  generatedAt: string;
  node: {
    id: string;
    displayName?: string;
    online: boolean;
    endpoint: string;
    resources: {
      memoryTotalGB: number;
      reservedMemoryGB: number;
    };
  };
  runtimes: RuntimeSnapshot[];
};
```

S0 の `online` は「daemon が動いている Node は online」でよい。リモート Node はまだ無い。

実メモリ使用量のサンプリング（現行 `monitor_memory_restart.ps1`）は S0 の必須範囲外。足すなら `node.resources` に観測値を optional で足し、推定値と混ぜない。

## 7. Lease（S1・実装済み）

```ts
type Lease = {
  id: string;
  client?: string;
  capabilities: string[];
  profile?: string;
  createdAt: string;
  ttlSeconds?: number;
};
```

Desired = Σ lease.capabilities ∪ { Resident が提供する capability }。

G2 で Gateway の進行中リクエストは暗黙 lease を足してよい。明示 `prepare` の意味論は変えない。
