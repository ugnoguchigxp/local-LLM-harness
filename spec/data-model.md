# Data model

永続化するdesired stateはYAML、観測state、lease、Allocationはdaemon memoryに保持します。
Artifact operation journalだけはrepository外の`/var/lib/larm`へ保存します。

## Node

`config/gnosis/nodes.yaml`

```yaml
nodes:
  gnosis:
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
    artifacts: [qwen38-primary]
    backend: systemd
    node: gnosis
    policy: { class: resident }
    resources: { estimatedMemoryGB: 40 }
    deployment:
      service: llama-server.service
      healthPort: 8080
      endpoint: http://127.0.0.1:8080
```

systemd deploymentは`service`、`healthPort`、`endpoint`が必須です。llama-swap deploymentは`modelId`、`listen`、`endpoint`が必須です。

## Route

Routeは公開APIの安定した選択単位です。候補順、primary/fallback、明示専用かを`config/gnosis/routes.yaml`へ宣言します。

```yaml
routes:
  llm-default:
    capabilities: [llm.general, llm.reasoning, llm.coding]
    candidates:
      - { runtime: qwen-general, purpose: primary }
      - { runtime: qwen-worker-quality, purpose: fallback }
```

## Allocation

Allocationは要求capabilityごとのRoute、Runtime、node、endpoint、選択理由をBindingへ固定し、
`pending | ready | failed | released | expired`の状態とTTLを持ちます。公開一覧ではendpointを隠し、
resolveまたはGatewayだけが固定endpointを使用します。daemon再起動後は再取得が必要です。

## Profile

Profileは同時に必要なcapability集合です。

```yaml
profiles:
  voice:
    require: [llm.general, speech.stt, speech.tts]
```

## Runtime state

statusは`COLD | STARTING | HOT | BUSY | STOPPING | FAILED`です。snapshotにはRuntime id、policy class、capability、backend、endpoint、service/model id、health detailを含めます。
