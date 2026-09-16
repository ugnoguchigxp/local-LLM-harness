# Data model

永続化するdesired stateはYAML、観測state、lease、Allocationはdaemon memoryに保持します。
Artifact operation journalだけはrepository外の`/var/lib/larm`へ保存します。
daemon再起動後にactive Allocationは復元せず、利用側が再取得します。

## Node

`config/local-node/nodes.yaml`

```yaml
nodes:
  local-node:
    endpoint: http://127.0.0.1
    resources:
      memoryTotalGB: 128
      reservedMemoryGB: 16
```

## Runtime

`backend`は`systemd`または`llama-swap`です。

```yaml
runtimes:
  qwen-general:
    capability: [llm.general, llm.reasoning, llm.coding]
    protocol: openai.chat-completions.v1
    artifacts: [qwen38-primary]
    backend: systemd
    node: local-node
    policy: { class: resident }
    resources:
      estimatedMemoryGB: 40
      maxConcurrentRequests: 1
      maxQueuedRequests: 0
      queueTimeoutMs: 1000
    deployment:
      service: llama-server.service
      healthPort: 8080
      endpoint: http://127.0.0.1:8080
```

Gateway対応Runtimeはprotocolと実行slot・queue上限が必須です。systemd deploymentは`service`、
`healthPort`、`endpoint`、llama-swap deploymentは`modelId`、`listen`、`endpoint`が必須です。

## Route

Routeは公開APIの安定した選択単位です。候補順、primary/fallback、明示専用かを`config/local-node/routes.yaml`へ宣言します。

```yaml
routes:
  llm-default:
    capabilities: [llm.general, llm.reasoning, llm.coding]
    candidates:
      - { runtime: qwen-general, purpose: primary }
```

## Allocation

Allocationは要求capabilityごとのRoute、Runtime、node、endpoint、選択理由をBindingへ固定し、
`pending | ready | failed | released | expired`の状態とTTLを持ちます。公開Allocation responseではendpointを隠し、
resolveまたはGatewayだけが固定endpointを使用します。daemon再起動後は再取得が必要です。
Allocation IDとresponse headerはboot epochを持ち、旧epochのIDを明示的に拒否します。

## Artifact

artifact manifestは`kind: file | snapshot`のdiscriminated unionです。snapshotは固定revision、
合計bytes、最大file数、sorted file list、fileごとのbytes・SHA-256、canonical snapshot digestを持ちます。
weightはrepositoryへ保存せず、artifact operation journalだけを`/var/lib/larm`へ保存します。

## Profile

Profileは同時に必要なcapability集合です。

```yaml
profiles:
  voice:
    require: [llm.general, speech.stt, speech.tts]
```

## Runtime state

statusは`COLD | STARTING | HOT | BUSY | STOPPING | FAILED`です。snapshotにはRuntime id、policy class、capability、backend、endpoint、service/model id、health detailを含めます。
