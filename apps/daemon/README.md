# @larm/daemon

Linux Runtimeを観測・制御するLARM daemonです。既定で `config/gnosis` を読み、SystemdBackendとLlamaSwapBackendへRuntime単位でルーティングします。

## Start

```bash
cd /srv/ai/apps/local-LLM-harness
bun run dev
```

既定は `http://127.0.0.1:9810` です。

```bash
export LARM_CONFIG_DIR=/srv/ai/apps/local-LLM-harness/config/gnosis
export LARM_PORT=9810
export LARM_PREFERRED_IDLE_TTL_SECONDS=60
export LARM_CONTROL_MAX_BODY_BYTES=65536
export LARM_GATEWAY_MAX_BODY_BYTES=4194304
export LARM_GATEWAY_TIMEOUT_SECONDS=300
export LARM_SHUTDOWN_TIMEOUT_SECONDS=330
bun run dev
```

loopback以外でlistenする場合は`LARM_API_TOKEN`と`LARM_MANAGEMENT_TOKEN`の両方が必須です。
loopbackでも`LARM_MANAGEMENT_TOKEN`がない場合、Artifact管理と`allow-listed`配備はfail closedで無効になります。
Artifactの生成stateは既定で`/var/lib/larm`、stagingとrollback dataは`/srv/ai/models/.larm-*`へ置きます。

## Control API

```bash
curl http://127.0.0.1:9810/health
curl http://127.0.0.1:9810/runtimes
curl http://127.0.0.1:9810/state
curl -sS -X POST http://127.0.0.1:9810/prepare \
  -H 'Content-Type: application/json' -d '{"profile":"voice"}'
curl -sS -X POST http://127.0.0.1:9810/resolve \
  -H 'Content-Type: application/json' -d '{"capability":"llm.general"}'
```

## v1 Allocation and Gateway

```bash
allocation_json="$(curl -sS -X POST http://127.0.0.1:9810/v1/allocations \
  -H 'Content-Type: application/json' \
  -d '{"requirements":[{"capability":"llm.general","route":"llm-default"}],"ttlSeconds":300}')"
allocation_id="$(jq -r .id <<<"${allocation_json}")"

curl -sS -N -X POST http://127.0.0.1:9810/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "x-larm-allocation-id: ${allocation_id}" \
  -d '{"model":"local","stream":true,"messages":[{"role":"user","content":"こんにちは"}]}'

curl -sS -X DELETE "http://127.0.0.1:9810/v1/allocations/${allocation_id}"
```

速度特化Runtimeは`route`へ`llm-speed`を明示した場合だけ選択されます。fallbackはrequestで`allowFallback: true`を指定した場合だけ許可されます。

## Artifact operations

管理APIはmanifestに登録済みのartifactとRuntimeだけを受け付けます。

```bash
curl -sS -X POST http://127.0.0.1:9810/v1/artifacts/qwen38-worker-fast/stage \
  -H "x-larm-management-token: ${LARM_MANAGEMENT_TOKEN}"

curl -sS -X POST http://127.0.0.1:9810/v1/deployments/qwen-worker-fast/activate \
  -H "x-larm-management-token: ${LARM_MANAGEMENT_TOKEN}"
```

Resident Runtimeの無人activationと、checksumのないdirectory modelは拒否します。
`deploymentPolicy: allow-listed`のAllocationにも同じ管理tokenが必要です。
activation後のhealth確認に失敗した場合は、直前のartifact targetへ自動rollbackします。

- Resident Runtimeは停止しません。
- Preferred Runtimeだけを`prepare`とidle `release`の対象にします。
- gnosis installerはPreferredの`qwen-tts.service`だけをstart / stopできるpolkit ruleを導入します。
- Resident systemd serviceはbackendとpolkitの両方でlifecycle変更の対象外です。
- llama-swap process自体の寿命はsystemdが管理し、daemonはmodelのload/unloadだけを委譲します。
