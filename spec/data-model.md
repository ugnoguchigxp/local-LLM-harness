# Data model

永続化するdesired stateはYAML、観測stateとleaseはdaemon memoryに保持します。

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

## Profile

Profileは同時に必要なcapability集合です。

```yaml
profiles:
  voice:
    require: [llm.general, speech.stt, speech.tts]
```

## Runtime state

statusは`COLD | STARTING | HOT | BUSY | STOPPING | FAILED`です。snapshotにはRuntime id、policy class、capability、backend、endpoint、service/model id、health detailを含めます。
