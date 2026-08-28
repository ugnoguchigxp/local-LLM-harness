# Local AI Provider concept

LARMは、Linux上の複数のローカルAI Runtimeを一つのProviderとして扱うための小さなcontrol planeです。Agentは実モデル名、quantization、port、service名を意識せず、論理的な能力を要求します。

## North Star

> Keep the realtime interaction path hot, load optional capacity only when needed, and expose one stable provider contract.

対象は次の範囲です。

- Runtime registryとhealth観測
- Resident / Preferred policy
- leaseの合成によるdesired state
- capabilityからRuntimeへのresolve
- systemdとllama-swapへのlifecycle委譲
- OpenAI互換Gateway（今後）

Agent loop、tool use、memory retrieval、モデル実行エンジン、分散consensusは扱いません。

## Linux-first runtime model

```text
Agent / Voice Client
        │
        ▼
LARM daemon
├─ control API
├─ registry / state / planner
└─ routing backend
   ├─ SystemdBackend
   └─ LlamaSwapBackend
        │
        ▼
llama-server / Qwen-ASR / Qwen-TTS / VOICEVOX
```

CoreはOS固有APIをimportしません。systemd操作とllama-swap HTTP APIは`packages/backends`に閉じ込めます。

## Runtime policy

- `resident`: 対話経路に必須。LARMから停止しない
- `preferred`: 必要時に起動し、active leaseがなくidle TTLを過ぎたら停止可能
- `elastic`: 将来の追加capacity向け

gnosisでは、Qwen3.8 primary、Qwen3-ASR、VOICEVOXをResidentとします。256K workerとGPUを競合する表現力重視Qwen3-TTSはPreferredです。

## Repository boundary

Repositoryはsource-onlyです。モデルweight、外部Runtime binary、build output、cacheはGitに入れません。外部artifactは`deploy/gnosis/models.yaml`と配備文書でsource、revision、checksum、配置先だけを管理します。
