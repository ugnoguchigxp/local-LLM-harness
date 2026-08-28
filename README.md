# local-LLM-harness

AMD Ryzen AI MAX+ 395 / Ubuntu / ROCm を中心にした、Linux-first のローカルAI Providerです。Qwen 3.8 27B、音声認識、音声合成のRuntimeをsystemdとllama-swap越しに観測・制御します。

Qwen 3.8 27Bは通常処理とリアルタイム処理のResident defaultです。速度特化Runtimeは明示routeでだけ選択し、35Bはproduction Registryへ登録していません。

## Repository policy

Gitで管理するのは、ソースコード、設定、systemd unit、再現手順、モデル取得元とchecksumだけです。次の実体は管理しません。

- モデルweight、Hugging Face cache
- llama.cpp、llama-swap、VOICEVOX COREなどの取得・ビルド可能な実行物
- `.exe`、`.dll`、`.so`、build directory、virtual environment
- ログ、生成音声、一時ベンチマーク出力

実行物は `/srv/ai/apps`、モデルは `/srv/ai/models`、cacheは `/srv/ai/cache` に置きます。LARMが参照するartifactの取得元、revision、配置先、検証metadataは[`deploy/gnosis/models.yaml`](deploy/gnosis/models.yaml)が正本です。単一fileに加え、全fileのpath、bytes、SHA-256とsnapshot digestを固定したdirectory modelを無人stagingできます。Resident artifactのactivationは引き続きattended operationです。

## Layout

| Path | Role |
| --- | --- |
| `apps/daemon` | Route、Allocation、Gateway、artifact operationを提供するcontrol plane |
| `apps/qwen-asr` | OpenAI互換ASR adapter |
| `apps/qwen-tts` | gfx1151向けQwen3-TTS設定・patch |
| `apps/voicevox-tts` | 低遅延VOICEVOX adapter |
| `packages/core` | OS非依存のregistry/state/planner |
| `packages/backends` | SystemdBackend、LlamaSwapBackend |
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
[`specs/api.html`](specs/api.html)、次期工程は
[`specs/next-implementation-plan.html`](specs/next-implementation-plan.html)、実装結果は
[`specs/implementation-completion.html`](specs/implementation-completion.html)を正本とします。

daemonは既定で `config/gnosis` を読み、`127.0.0.1:9810` で待ち受けます。別構成は `LARM_CONFIG_DIR` で指定できます。

## gnosis operations

```bash
cd /srv/ai/apps/local-LLM-harness
# 必要な場合だけ、変更内容を確認してhost準備を実行:
# sudo deploy/gnosis/scripts/prepare-host.sh
sudo deploy/gnosis/scripts/install-services.sh
sudo systemctl start llama-server.service llama-swap-worker.service \
  qwen-asr.service voicevox-tts.service larm-daemon.service
deploy/gnosis/scripts/verify.sh
```

`systemctl start`は初回導入時だけ実行します。更新時にResident serviceを一括restartしません。詳細は[`docs/gnosis.md`](docs/gnosis.md)と[`deploy/gnosis/README.md`](deploy/gnosis/README.md)を参照してください。このdual-boot hostでは、配備処理からrebootしません。
