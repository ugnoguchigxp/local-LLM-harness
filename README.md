# local-LLM-harness

AMD Ryzen AI MAX+ 395 / Ubuntu / ROCm を中心にした、Linux-first のローカルAI Providerです。Qwen 3.8 27B、音声認識、音声合成のRuntimeをsystemdとllama-swap越しに観測・制御します。

Qwen 3.8 27Bは通常処理とリアルタイム処理のResident defaultです。追加27B、Ornith-1.5-35B-A3B、Qwen3.6-35B-A3Bは明示routeでだけ起動し、Residentとは別の交換可能worker slotを共有します。35Bの品質既定は公式Q5_K_MのOrnithで、gfx1151向けROCmFP4は明示的なspeed候補、Qwenは比較・fallback用に残します。

通常requestは必要なcapabilityとrouteをAllocation APIへ渡します。`llm-default`は常駐27Bへ固定され、追加27Bへの分散は`llm-speed`、品質重視のOrnith 35Bは`llm-35b`、ROCmFP4速度版は`llm-35b-speed`、旧Qwen 35Bとの比較は`llm-qwen36-35b`を明示します。動的Agent接続では64Kの`coding-worker`と`deep-reasoning-35b`を使い、常駐27Bとの同居とworker間swapを両立します。管理APIではallowlist済みRuntime releaseをstage・plan・activate・rollbackでき、requestから任意のURL、model path、service、commandを注入することはできません。

## Repository policy

Gitで管理するのは、ソースコード、設定、systemd unit、再現手順、自動配備対象のモデル取得元とchecksumです。
VOICEVOXの外部runtime bundleはoperatorが利用規約に同意して配備する例外です。使用中の
<code>0.vvm</code>もrelease、配布元、bytes、SHA-256をsource-only metadataへ固定し、preflightで
実fileとの一致をfail-closed検証します。次の実体は管理しません。

- モデルweight、Hugging Face cache
- llama.cpp、llama-swap、VOICEVOX COREなどの取得・ビルド可能な実行物
- `.exe`、`.dll`、`.so`、build directory、virtual environment
- ログ、生成音声、一時ベンチマーク出力

実行物は `/srv/ai/apps`、モデルは `/srv/ai/models`、cacheは `/srv/ai/cache` に置きます。LARMが参照するartifactの取得元、revision、配置先、検証metadataは[`deploy/gnosis/models.yaml`](deploy/gnosis/models.yaml)が正本です。単一fileに加え、全fileのpath、bytes、SHA-256とsnapshot digestを固定したdirectory modelを無人stagingできます。Resident artifactのactivationは引き続きattended operationです。

## Layout

| Path | Role |
| --- | --- |
| `apps/daemon` | Route、Allocation、Gateway、runtime release、catalog reloadを提供するcontrol plane |
| `apps/qwen-asr` | OpenAI互換ASR adapter |
| `apps/qwen-tts` | gfx1151向けQwen3-TTS設定・patch |
| `apps/voicevox-tts` | 低遅延VOICEVOX adapter |
| `packages/core` | OS非依存のregistry/state/planner |
| `packages/backends` | Systemd、llama-swap、atomic state、Linux telemetry adapter |
| `packages/client` | v1 lifecycleとGatewayを扱う参照TypeScript client |
| `config/gnosis` | Linux production registryとllama-swap設定 |
| `deploy/gnosis` | systemd unit、host導入、検証、model manifest |
| `specs` | Spec HTMLで作成する設計書・仕様書・実装計画 |

## Development

```bash
bun install --frozen-lockfile
bun run check
bun run dev
```

`bun run check`はsource-only、Bash・Python・systemd、Spec HTML、TypeScript、全test、installer再実行検査をCIと同じ順序で実行します。

## Design documents

新しい設計書、仕様書、実装計画、調査結果は`specs/`にSpec HTMLのHTML fragmentとして作成します。既存Markdownは移行するまでそのまま参照できます。

```bash
bun run docs
bun run docs:check
bun run docs:check:fix
```

HTML文書は`<article lang="ja">`をrootとし、document固有の`html`、`head`、`body`、CSS、navigationは持たせません。詳細は[`specs/overview.html`](specs/overview.html)を参照してください。

Providerの最新コンセプトは[`specs/concept.html`](specs/concept.html)、公開APIは
[`specs/api.html`](specs/api.html)、残るproduction完了工程は
[`specs/production-completion-plan.html`](specs/production-completion-plan.html)、そのattended実行順は
[`specs/production-rollout-execution-plan.html`](specs/production-rollout-execution-plan.html)、実装結果は
[`specs/implementation-completion-m15-m21.html`](specs/implementation-completion-m15-m21.html)、on-demand LLM構成は
[`specs/on-demand-llm-worker-pool.html`](specs/on-demand-llm-worker-pool.html)、Agent向け動的Provider接続APIは
[`specs/agent-provider-connection-api.html`](specs/agent-provider-connection-api.html)（実装・実機E2E済み）、実装証跡は
[`specs/agent-provider-connection-implementation.html`](specs/agent-provider-connection-implementation.html)、Ornith配布物の選定根拠は
[`specs/ornith-1.5-35b-selection.html`](specs/ornith-1.5-35b-selection.html)を正本とします。

daemonは既定で `config/gnosis` を読み、`127.0.0.1:9810` で待ち受けます。別構成は `LARM_CONFIG_DIR` で指定できます。

repositoryのProvider unitはport 8080–8084をloopbackだけでlistenするstable desired stateです。
2026年8月29日のlive hostには移行用wildcard unitが残っているため、通常clientはLARM Gatewayを使用し、
review済みnetwork plan、Provider単位のrestart、capability smokeの順で段階適用します。

## gnosis operations

次の手順は、Production Completion Milestone
22の変更をreview済みclean commitへ固定し、rollback先を確保した後に実行します。
既存unitまたはrelease pointerがある場合は、installerより前に
[`deploy/gnosis/README.md`](deploy/gnosis/README.md)の手順でoperator管理領域へ退避します。

```bash
cd /srv/ai/apps/local-LLM-harness
# 必要な場合だけ、変更内容を確認してhost準備を実行:
# sudo deploy/gnosis/scripts/prepare-host.sh
deploy/gnosis/scripts/preflight-larm.sh
# deploy/gnosis/README.mdのdigest付きhost backupを先に作成
sudo deploy/gnosis/scripts/install-services.sh
deploy/gnosis/scripts/release-larm.sh plan
sudo deploy/gnosis/scripts/release-larm.sh apply
sudo systemctl start llama-server.service llama-swap-worker.service \
  qwen-asr.service voicevox-tts.service larm-daemon.service
deploy/gnosis/scripts/verify.sh
# SLO校正後のcanaryにはrepository外evidence directoryと非機密音声が必要です。
# LARM_CANARY_EVIDENCE_DIR=/srv/ai/logs/larm-canary \
# LARM_BENCHMARK_AUDIO_FILE=/path/to/non-sensitive.wav \
# deploy/gnosis/scripts/canary-gate.sh
```

`plan`の`cleanupConfirm`が`null`でない場合、保持上限を超える削除候補があります。表示された候補を確認し、そのdigestを`LARM_RELEASE_CLEANUP_CONFIRM`へ設定した`apply`だけが配備を続行します。

`systemctl start`は初回導入時だけ実行します。更新時にResident serviceを一括restartしません。詳細は[`docs/gnosis.md`](docs/gnosis.md)と[`deploy/gnosis/README.md`](deploy/gnosis/README.md)を参照してください。このdual-boot hostでは、配備処理からrebootしません。
