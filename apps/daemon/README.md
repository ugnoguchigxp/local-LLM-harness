# @larm/daemon

Linux Runtimeを観測・制御するLARM daemonです。既定で `config/gnosis` を読み、SystemdBackendとLlamaSwapBackendへRuntime単位でルーティングします。

実装済みAPI contractの正本は[`../../specs/api.html`](../../specs/api.html)です。LLM、STT、通常TTS、表現TTSをprotocol-awareな共通Gatewayで提供し、通常clientは個別Provider portではなくGatewayを使用します。repositoryのProvider unitはloopback desired stateです。2026年8月29日のlive hostには移行用wildcard listenerが残り、network levelの閉鎖は[`../../specs/production-completion-plan.html`](../../specs/production-completion-plan.html)のMilestone 27で行います。

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
export LARM_SPEECH_MAX_BODY_BYTES=269484032
export LARM_GATEWAY_TIMEOUT_SECONDS=300
export LARM_SHUTDOWN_TIMEOUT_SECONDS=330
bun run dev
```

主要設定は次の通りです。

| Environment | Default | Purpose |
| --- | ---: | --- |
| `LARM_HOST` | `127.0.0.1` | listen address |
| `LARM_PORT` | `9810` | listen port |
| `LARM_CONFIG_DIR` | `config/gnosis` | Node、Runtime、Profile、Route registry |
| `LARM_OBSERVE_INTERVAL_MS` | `2000` | Backend観測間隔 |
| `LARM_STARTING_GRACE_SECONDS` | `300` | STARTINGからFAILEDへ移す猶予 |
| `LARM_PREFERRED_IDLE_TTL_SECONDS` | `60` | 未使用Preferredを回収するまでの時間 |
| `LARM_STARTUP_TIMEOUT_SECONDS` | `300` | Allocation起動上限 |
| `LARM_STARTUP_POLL_INTERVAL_MS` | `500` | readiness確認間隔 |
| `LARM_STATE_MAX_AGE_SECONDS` | `10` | observer snapshot freshness上限 |
| `LARM_HISTORY_LIMIT` | `1000` | memory上のterminal履歴上限 |
| `LARM_ACTIVE_ALLOCATION_LIMIT` | `1000` | active Allocationと直接Legacy Leaseの合計上限 |
| `LARM_API_TOKEN` | 未設定 | control API認証。Agent Connection APIではloopbackでも必須 |
| `LARM_MANAGEMENT_TOKEN` | 未設定 | artifact、release、catalog管理用の別credential |
| `LARM_CONNECTION_SIGNING_KEY` | 未設定 | Agent Provider短期token用の32-byte unpadded base64url鍵 |
| `LARM_CONNECTION_READY_TIMEOUT_SECONDS` | `120` | Connection初回semantic readinessの上限 |
| `LARM_PROVIDER_PROBE_TIMEOUT_SECONDS` | `15` | Provider単位の最小semantic probe上限 |
| `LARM_ARTIFACT_OPERATION_LIMIT` | `64` | pending/running artifact operationの合計上限 |
| `LARM_CONTROL_MAX_BODY_BYTES` | `65536` | control API body上限。設定可能な最大値は1 MiB |
| `LARM_GATEWAY_MAX_BODY_BYTES` | `4194304` | LLMとTTS JSON body上限。設定可能な最大値は64 MiB |
| `LARM_SPEECH_MAX_BODY_BYTES` | `269484032` | STT upload上限 |
| `LARM_GATEWAY_TIMEOUT_SECONDS` | `300` | uploadからresponse完了までの上限 |
| `LARM_SHUTDOWN_TIMEOUT_SECONDS` | `330` | operationとrequestのdrain上限 |
| `LARM_ARTIFACT_MANIFEST` | `deploy/gnosis/models.yaml` | artifact allowlist |
| `LARM_RELEASE_CATALOG` | `deploy/gnosis/releases.yaml` | immutable Runtime release catalog |
| `LARM_RELEASE_MANIFEST` | 未設定 | production release commitを読むmanifest。systemd unitはcurrent release内を指定 |
| `LARM_ARTIFACT_STAGING_ROOT` | `/srv/ai/models/.larm-staging` | 検証済みstaging data |
| `LARM_ARTIFACT_ROLLBACK_ROOT` | `/srv/ai/models/.larm-rollback` | rollback data |
| `LARM_ARTIFACT_STATE_ROOT` | `/var/lib/larm` | operation journal |
| `LARM_IDEMPOTENCY_TTL_SECONDS` | `300` | Allocation idempotency結果の保持時間 |
| `LARM_IDEMPOTENCY_LIMIT` | `1000` | TTL内のidempotency key件数上限。満杯時の新規keyは503でfail closed |
| `LARM_RECOVERY_GRACE_SECONDS` | `60` | 起動後の孤立Preferred回収猶予 |
| `LARM_TELEMETRY_MAX_AGE_SECONDS` | `10` | Preferred起動に使用できるresource telemetry freshness |

数値設定は起動時に範囲検証され、不正値ではdaemonを起動しません。

loopback以外でlistenする場合は`LARM_API_TOKEN`と`LARM_MANAGEMENT_TOKEN`の両方が必須です。`LARM_API_TOKEN`を設定した場合、`/health`と`/ready`以外へ`Authorization: Bearer ...`が必要です。
loopbackでも`LARM_MANAGEMENT_TOKEN`がない場合、Artifact管理と`allow-listed`配備はfail closedで無効になります。
Artifactの生成stateは既定で`/var/lib/larm`、stagingとrollback dataは`/srv/ai/models/.larm-*`へ置きます。

## Control API

```bash
curl http://127.0.0.1:9810/health
curl http://127.0.0.1:9810/runtimes
curl http://127.0.0.1:9810/state
curl http://127.0.0.1:9810/openapi.json
# 完全なRuntime・state inspectionにはmanagement tokenが必要です。
curl -H "x-larm-management-token: ${LARM_MANAGEMENT_TOKEN}" \
  http://127.0.0.1:9810/v1/inspection/runtimes
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

voice_allocation_json="$(curl -sS -X POST http://127.0.0.1:9810/v1/allocations \
  -H 'Content-Type: application/json' \
  -d '{"requirements":[{"capability":"speech.stt","route":"stt-default"},{"capability":"speech.tts","route":"tts-default"}],"ttlSeconds":300}')"
voice_allocation_id="$(jq -r .id <<<"${voice_allocation_json}")"

# speech.stt Bindingを含むAllocationでは、音声をbufferせず転送します。
curl -sS -X POST http://127.0.0.1:9810/v1/audio/transcriptions \
  -H "x-larm-allocation-id: ${voice_allocation_id}" -F 'file=@sample.wav'

# TTS Bindingが複数ある場合はcapabilityを明示します。
curl -sS -X POST http://127.0.0.1:9810/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -H "x-larm-allocation-id: ${voice_allocation_id}" \
  -H 'x-larm-capability: speech.tts' \
  -d '{"model":"voicevox-core","input":"こんにちは","voice":"Kasukabe_Tsumugi","response_format":"wav"}' \
  -o /dev/null

curl -sS -X DELETE "http://127.0.0.1:9810/v1/allocations/${voice_allocation_id}"
```

追加27Bは`route`へ`llm-speed`、公式Q5_K_MのOrnith 35Bは`llm-35b`、ROCmFP4速度版は`llm-35b-speed`を明示した場合だけ選択されます。比較用Qwen3.6-35Bは`llm-qwen36-35b`で固定できます。`llm-default`はswapせずResident 27Bへ固定されます。fallbackはrequestで`allowFallback: true`を指定した場合だけ許可されます。同じworker swap groupの別Runtimeにactive Allocationがある場合はpreemptせず、新しい要求を拒否します。

## Agent Connection API

Agentは登録済みProfileとAudienceだけを指定します。`coding-default`は常駐27B、`coding-worker`は
常駐27Bと並列に使う64K追加27B、`deep-reasoning-35b`は同じworker slotへswapする64K
Ornith 35Bです。claimはLARM Gatewayの`baseUrl`、public `model`、Provider限定の短期token、
semantic health URLを返します。backend portや長期API tokenは返しません。

```bash
connection_json="$(curl -fsS -X POST http://127.0.0.1:9810/v1/agent-connections \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: agent-$(date +%s)" \
  -d '{"agentProfile":"deep-reasoning-35b","audience":"same-host"}')"
connection_id="$(jq -er .id <<<"${connection_json}")"

# GET /v1/agent-connections/:idをreadyまでpollしてからclaimします。
curl -fsS -X POST "http://127.0.0.1:9810/v1/agent-connections/${connection_id}/claim" \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"format":"openai-provider-v1"}'
```

`/health`ではなくclaim内のProvider health URLを使用してください。LLM healthは
`max_tokens: 1`の固定推論を行い、completion tokenがちょうど1であることまで検証します。
成功は10秒、失敗は1秒だけcacheし、通常task queueへprobeを追加しません。
SAAAのMac接続は[`../../docs/gnosis.md`](../../docs/gnosis.md)の直接LAN接続contractを使います。
gnosisのproduction unitは認証を必須にした上で`0.0.0.0:9810`をlistenし、Audience
`saaa-desktop`は`http://192.168.0.65:9810/v1`を広告します。

## Artifact operations

管理APIはmanifestとrelease catalogに登録済みのIDだけを受け付けます。Stage、activate、rollbackは202と非同期operationを返します。依存する次の操作へ進む前に、`GET /v1/artifact-operations/:id`が`succeeded`になるまで待つ必要があります。

```bash
set -euo pipefail

management_headers=(-H "x-larm-management-token: ${LARM_MANAGEMENT_TOKEN}")
# LARM_API_TOKENを設定している場合:
# management_headers+=(-H "Authorization: Bearer ${LARM_API_TOKEN}")

wait_artifact_operation() {
  local operation_id="$1" max_wait_seconds="${2:-3700}"
  local deadline=$((SECONDS + max_wait_seconds)) operation_json operation_status

  while ((SECONDS < deadline)); do
    operation_json="$(curl -fsS --max-time 5 "${management_headers[@]}" \
      "http://127.0.0.1:9810/v1/artifact-operations/${operation_id}")"
    operation_status="$(jq -r .status <<<"${operation_json}")"
    case "${operation_status}" in
      succeeded) return 0 ;;
      failed|interrupted) jq . <<<"${operation_json}"; return 1 ;;
      pending|running) sleep 1 ;;
      *) jq . <<<"${operation_json}"; return 1 ;;
    esac
  done

  echo "artifact operation timed out: ${operation_id}" >&2
  return 1
}

release_id="qwen-worker-fast-current"
operation_json="$(curl -fsS -X POST "${management_headers[@]}" \
  "http://127.0.0.1:9810/v1/runtime-releases/${release_id}/stage")"
wait_artifact_operation "$(jq -r .id <<<"${operation_json}")"

active_release="$(curl -fsS "${management_headers[@]}" \
  http://127.0.0.1:9810/v1/deployments/qwen-worker-fast | jq -c .activeRelease)"
operation_json="$(curl -fsS -X POST "${management_headers[@]}" \
  -H 'content-type: application/json' \
  -d "{\"release\":\"${release_id}\",\"expectedActiveRelease\":${active_release}}" \
  http://127.0.0.1:9810/v1/deployments/qwen-worker-fast/activate)"
wait_artifact_operation "$(jq -r .id <<<"${operation_json}")"
```

Runtimeが参照する全artifactをstageしてからactivateします。`deploymentPolicy: allow-listed`のAllocationでは、このstageからactivationまでをdaemonが一つの起動operation内で行います。

`GET /v1/runtime-releases`は各releaseを`active`、`previous`、`staged`、`available`のいずれかで返します。`POST /v1/deployments/:runtime/plan`は実ファイルを再検証し、未stage bytes、Runtime状態、停止要否、rollback可能性、blockerを変更なしで返します。deployment stateにはactive・previous・desiredのprovider config revisionも含まれます。provider config revisionはreleaseと一緒に固定する起動contractの識別子で、APIから任意の設定内容やpathを渡すものではありません。

Catalog reload、artifact stage、release activation・rollback、allow-listed起動は一つのmutation coordinatorで直列化します。競合中の変更は待たせずfail closedし、catalog切替中のrelease・deployment参照も503を返します。shutdownは新規mutationを閉じ、実行中operationを設定済み期限までdrainします。

単一fileと、全fileが列挙・検証されたdirectory snapshotをstageできます。未列挙file、symlink、危険path、checksum不一致を拒否します。Resident Runtimeの無人activationは拒否します。
`deploymentPolicy: allow-listed`のAllocationにも同じ管理tokenが必要です。
activation後のhealth確認に失敗した場合は、直前のartifact targetへ自動rollbackします。
Artifact downloadのBackend上限は既定3600秒で、例のpoll上限はその結果を取得できるよう3700秒です。

`@larm/client`の`waitForOperation`はcontrol operationをterminal状態までpollし、進行中HTTPを含む全体timeoutと`AbortSignal`を扱います。`withAllocation`は成功・失敗のどちらでもAllocationを一度だけ解放し、処理と解放が両方失敗した場合は双方を`AggregateError`で保持します。

Canary後は`larm_active_allocations`、`larm_execution_active`、`larm_execution_queued`、`larm_artifact_operations_active`が実状態へ収束したことを確認します。

- Resident Runtimeは停止しません。
- Preferred Runtimeだけを`prepare`とidle `release`の対象にします。
- gnosis installerはPreferredの`qwen-tts.service`だけをstart / stopできるpolkit ruleを導入します。
- Resident systemd serviceはbackendとpolkitの両方でlifecycle変更の対象外です。
- llama-swap process自体の寿命はsystemdが管理し、daemonはmodelのload/unloadだけを委譲します。
