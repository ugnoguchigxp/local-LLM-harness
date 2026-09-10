# @larm/daemon

Linux Runtimeを観測・制御するLARM daemonです。既定で `config/local-node` を読み、SystemdBackendとLlamaSwapBackendへRuntime単位でルーティングします。

実装済みAPI contractの正本は[`../../specs/api.html`](../../specs/api.html)です。LLM、STT、通常TTS、表現TTSをprotocol-awareな共通Gatewayで提供し、通常clientは個別Provider portではなくGatewayを使用します。repositoryのProvider unitはloopback desired stateです。2026年8月29日のlive hostには移行用wildcard listenerが残り、network levelの閉鎖は[`../../specs/production-completion-plan.html`](../../specs/production-completion-plan.html)のMilestone 27で行います。

## Start

```bash
cd /srv/ai/apps/local-LLM-harness
bun run dev
```

既定は `http://127.0.0.1:9810` です。

```bash
export LARM_CONFIG_DIR=/srv/ai/apps/local-LLM-harness/config/local-node
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
| `LARM_CONFIG_DIR` | `config/local-node` | Node、Runtime、Profile、Route registry |
| `LARM_OBSERVE_INTERVAL_MS` | `2000` | Backend観測間隔 |
| `LARM_STARTING_GRACE_SECONDS` | `300` | STARTINGからFAILEDへ移す猶予 |
| `LARM_PREFERRED_IDLE_TTL_SECONDS` | `60` | 未使用Preferredを回収するまでの時間 |
| `LARM_STARTUP_TIMEOUT_SECONDS` | `300` | Allocation起動上限 |
| `LARM_STARTUP_POLL_INTERVAL_MS` | `500` | readiness確認間隔 |
| `LARM_STATE_MAX_AGE_SECONDS` | `10` | observer snapshot freshness上限 |
| `LARM_HISTORY_LIMIT` | `1000` | memory上のterminal履歴上限 |
| `LARM_ACTIVE_ALLOCATION_LIMIT` | `1000` | active Allocationと直接Legacy Leaseの合計上限 |
| `LARM_API_TOKEN` | 未設定 | 通常control API認証。匿名Agent Connectionを有効にしたlocal-nodeでも他のcontrol APIには必須 |
| `LARM_ALLOW_ANONYMOUS_AGENT_CONNECTIONS` | `false` | `true`の場合、Agent Connection lifecycleだけを長期Bearerなしで許可。claim後のprovider credentialは引き続き必須 |
| `LARM_MANAGEMENT_TOKEN` | 未設定 | artifact、release、catalog管理用の別credential |
| `LARM_CONNECTION_SIGNING_KEY` | 未設定 | Agent Provider短期token用の32-byte unpadded base64url鍵 |
| `LARM_CONNECTION_READY_TIMEOUT_SECONDS` | `120` | Connection初回semantic readinessの上限 |
| `LARM_PROVIDER_PROBE_TIMEOUT_SECONDS` | `15` | Provider単位の最小semantic probe上限 |
| `LARM_TLS_CERT_FILE` / `LARM_TLS_KEY_FILE` | 未設定 | GatewayをHTTPSで提供するための、対で指定する絶対path |
| `LARM_ARTIFACT_OPERATION_LIMIT` | `64` | pending/running artifact operationの合計上限 |
| `LARM_CONTROL_MAX_BODY_BYTES` | `65536` | control API body上限。設定可能な最大値は1 MiB |
| `LARM_GATEWAY_MAX_BODY_BYTES` | `4194304` | LLMとTTS JSON body上限。設定可能な最大値は64 MiB |
| `LARM_SPEECH_MAX_BODY_BYTES` | `269484032` | STT upload上限 |
| `LARM_GATEWAY_TIMEOUT_SECONDS` | `300` | uploadからresponse完了までの上限。監査recoveryとの競合を避ける最大値は3300秒 |
| `LARM_CONTEXT_ENABLED` | `false` | Managed Context全体のkill switch。API tokenも必須 |
| `LARM_CONTEXT_METADATA_ROOT` | `/var/lib/larm/contexts` | principal-scoped metadata state |
| `LARM_CONTEXT_SOURCE_ROOT` | `/srv/ai/context-sources` | attestation済みimmutable source root |
| `LARM_CONTEXT_SOURCE_MAX_TOTAL_BYTES` | `549755813888` | source全体のhard quota |
| `LARM_CONTEXT_SNAPSHOT_ENABLED` | `false` | 認定済みsession snapshotだけを許可する独立kill switch |
| `LARM_CONTEXT_SNAPSHOT_ROOT` | `/srv/ai/context-snapshots` | 0700のCRC32C snapshot cache root |
| `LARM_CONTEXT_SNAPSHOT_MAX_BYTES` | `549755813888` | snapshot、pending、quarantineを含むhard quota |
| `LARM_CONTEXT_SNAPSHOT_FREE_FLOOR_BYTES` | `274877906944` | snapshot filesystemのfree floor |
| `LARM_CONTEXT_SNAPSHOT_MAX_WRITE_BYTES` | `5368709120` | slot save一件の事前予約上限 |
| `LARM_SHUTDOWN_TIMEOUT_SECONDS` | `330` | operationとrequestのdrain上限 |
| `LARM_ARTIFACT_MANIFEST` | `deploy/local-node/models.yaml` | artifact allowlist |
| `LARM_RELEASE_CATALOG` | `deploy/local-node/releases.yaml` | immutable Runtime release catalog |
| `LARM_RELEASE_MANIFEST` | 未設定 | production release commitを読むmanifest。systemd unitはcurrent release内を指定 |
| `LARM_ARTIFACT_STAGING_ROOT` | `/srv/ai/models/.larm-staging` | 検証済みstaging data |
| `LARM_ARTIFACT_ROLLBACK_ROOT` | `/srv/ai/models/.larm-rollback` | rollback data |
| `LARM_ARTIFACT_STATE_ROOT` | `/var/lib/larm` | operation journal |
| `LARM_IDEMPOTENCY_TTL_SECONDS` | `300` | Allocation idempotency結果の保持時間 |
| `LARM_IDEMPOTENCY_LIMIT` | `1000` | TTL内のidempotency key件数上限。満杯時の新規keyは503でfail closed |
| `LARM_RECOVERY_GRACE_SECONDS` | `60` | 起動後の孤立Preferred回収猶予 |
| `LARM_TELEMETRY_MAX_AGE_SECONDS` | `10` | Preferred起動に使用できるresource telemetry freshness |
| `LARM_INFERENCE_AUDIT_MODE` | `off` | `off`、`metadata`、`full-required`。production unitは`full-required` |
| `LARM_INFERENCE_AUDIT_ROOT` | `/var/lib/larm/inference-audit` | 暗号化済みLLM監査recordの保存先 |
| `LARM_INFERENCE_AUDIT_KEY_FILE` | `/etc/larm/inference-audit.key` | 32-byte unpadded base64url鍵file |
| `LARM_INFERENCE_AUDIT_RETENTION_SECONDS` | `604800` | 最大保持期間。7日を超える値は拒否 |
| `LARM_INFERENCE_AUDIT_MAX_BYTES` | `10737418240` | archive総容量上限 |
| `LARM_INFERENCE_AUDIT_MIN_FREE_BYTES` | `21474836480` | 維持するfilesystem空き容量 |
| `LARM_INFERENCE_AUDIT_MAX_RESPONSE_BYTES` | `16777216` | requestごとのresponse保存上限。設定可能な最大値は64 MiB |
| `LARM_INFERENCE_AUDIT_MATERIALIZATION_TIMEOUT_SECONDS` | `30` | template・token取得の上限 |

数値設定は起動時に範囲検証され、不正値ではdaemonを起動しません。

loopback以外でlistenする場合は`LARM_API_TOKEN`と`LARM_MANAGEMENT_TOKEN`の両方がserver設定として必須です。`LARM_API_TOKEN`を設定した場合、`/health`、`/ready`と明示的に有効化した匿名Agent Connection lifecycle以外へ`Authorization: Bearer ...`が必要です。
loopbackでも`LARM_MANAGEMENT_TOKEN`がない場合、Artifact管理と`allow-listed`配備はfail closedで無効になります。
Artifactの生成stateは既定で`/var/lib/larm`、stagingとrollback dataは`/srv/ai/models/.larm-*`へ置きます。

## LLM inference audit

`full-required`では、LLM requestの受信bytesを暗号化保存できた後にだけProviderを呼びます。同じProviderの
`/apply-template`と`/tokenize`からrendered prompt、token ID・pieceを採取し、clientへ転送したraw
非streaming JSON responseも最大16 MiBまで暗号化します。本文やtokenはjournald、metrics、HTTP APIには出しません。
template・tokenizeだけが失敗した場合は理由をmetadataへ残して推論を継続し、request保存不能時は503で
fail closedします。
`metadata`ではpayloadを保存せず、request IDとoutcomeの監査lifecycle eventだけを出します。
暗号payloadの認証情報にはUTC record pathとpayload種別も結び付け、別record・別種別への暗号文の
差し替えを復号時に拒否します。response監査bufferだけが失敗した場合は`truncated`として確定し、
client streamは中断しません。

local operator CLIは既定でmetadataだけを表示します。payloadを指定した場合だけ復号します。

```bash
bun run inference:audit -- list
bun run inference:audit -- show req_example metadata
bun run inference:audit -- show req_example request
bun run inference:audit -- show req_example prompt
bun run inference:audit -- show req_example tokens
bun run inference:audit -- show req_example response
bun run inference:audit -- verify req_example
bun run inference:audit -- prune
```

作成から168時間で閲覧対象外となり、daemon起動時・毎時および
`larm-inference-audit-prune.timer`が物理削除します。10 GiBまたは空き20 GiBの制約が先に来た場合は、
active recordを除く古い完了recordから7日未満でも削除します。鍵とarchiveはGit、release package、
通常backupの対象外です。prune後は空になった時刻directoryも除去し、crashが完了metadataのcommit後に
起きた場合は正常なoutcomeを維持したまま残存active markerだけを回収します。

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

## OpenAI互換HTTP Gateway

`LARM_API_TOKEN`を標準Bearerとして指定し、公開modelだけでChat Completionsを利用できます。
`GET /v1/models`は内部runtime、port、artifact pathを公開しません。LARMはmodelをcatalog上の
capability／routeへ解決し、内部Allocationの取得、cold startのsingle-flight、固定binding、解放を
リクエストの内側で行います。

```bash
curl -sS http://127.0.0.1:9810/v1/models \
  -H "Authorization: Bearer ${LARM_API_TOKEN}"

curl -sS -X POST http://127.0.0.1:9810/v1/chat/completions \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"coding-default","stream":false,"messages":[{"role":"user","content":"こんにちは"}]}'

# OpenAI互換SSE。-Nでcurlの受信bufferingを無効化します。
curl -sS -N -X POST http://127.0.0.1:9810/v1/chat/completions \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"model":"coding-default","stream":true,"messages":[{"role":"user","content":"こんにちは"}]}'

curl -sS -X POST http://127.0.0.1:9810/v1/audio/transcriptions \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" \
  -F 'model=qwen3-asr-1.7b' -F 'response_format=json' -F 'file=@sample.wav'

curl -sS -X POST http://127.0.0.1:9810/v1/audio/speech \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"voicevox-core","input":"こんにちは","voice":"Kasukabe_Tsumugi","response_format":"wav"}' \
  -o response.wav
```

公開modelは、deprecatedでないAgent ProfileのLLM・ASR・TTS Providerから構築します。
同じ公開modelを異なるrouteまたは異なる優先度へ重複定義した場合は起動時に拒否します。既定の
`coding-default`はResident Qwen 3.8 27Bへ、`qwen-nightworker`と`qwen-agent-worker`は明示選択のworker
routeへ解決します。優先度はSAAA 3000、NightWorker 2000、ContextStill 1000です。実行中requestは
preemptせず、解放後の次枠を高い値から選び、同値はFIFOです。

## KV:mem Provider経路

`KV:mem`はSAAA向けManaged Context実験経路の暫定名称です。公開model
`qwen3.8-kv-mem`は、明示専用route `llm-saaa-kv-mem`から`qwen-worker-quality`だけへ解決します。
fallback候補を持たないため、snapshot非対応のResidentやContextStill workerへ黙って切り替わりません。
通常の`coding-default`はResidentを維持し、ContextStillの`qwen-agent-worker`は
`qwen-worker-agent`上の従来KVを維持します。

Model Broker経由の通常Chatはsnapshot対応hostをon-demand起動しますが、Viewなしでは通常推論です。
Managed Contextをmaterializeするrequestは、明示Allocationと同じprincipalでContext Viewを作成し、Chatへ
`x-larm-allocation-id`、`x-larm-capability`、`x-larm-context-view-id`を渡します。controllerはViewを
Allocation、runtime、release、model binding、TTL、lease epochへbindし、一回だけconsumeします。

`GET /v1/context-status`はruntimeごとの`ACTIVE`、`STANDBY`、`DISABLED`、認定mode、quotaと理由を返します。
snapshot利用には次の条件がすべて必要です。

- `LARM_CONTEXT_ENABLED=true`
- `LARM_CONTEXT_SNAPSHOT_ENABLED=true`
- runtimeがManaged Context opt-in済み
- active releaseが`session-snapshot`認定済み
- 対象runtimeが`HOT`または`BUSY`
- View、principal、Allocation、release identityが一致

snapshotは64 MiB CRC32C envelope、temporary write、fsync、atomic rename、lazy verificationで管理します。
破損、identity drift、quota不足ではrestoreせず隔離し、source rebuildへ戻します。任意KV blockの連結、短いpromptへの
巻戻し、暗号学的改ざん耐性、background prewarmは認定範囲外です。詳細は
[`../../specs/saaa-qwen38-kv-mem-routing.html`](../../specs/saaa-qwen38-kv-mem-routing.html)を参照してください。

## 明示Allocation Gateway（互換・高度用途）

```bash
allocation_json="$(curl -sS -X POST http://127.0.0.1:9810/v1/allocations \
  -H 'Content-Type: application/json' \
  -d '{"requirements":[{"capability":"llm.general","route":"llm-default"}],"ttlSeconds":300}')"
allocation_id="$(jq -r .id <<<"${allocation_json}")"

curl -sS -X POST http://127.0.0.1:9810/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "x-larm-allocation-id: ${allocation_id}" \
  -d '{"model":"local","stream":false,"messages":[{"role":"user","content":"こんにちは"}]}'

# OpenAI互換SSE。-Nでcurlの受信bufferingを無効化します。
curl -sS -N -X POST http://127.0.0.1:9810/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
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

LLM Gatewayは、`POST /v1/chat/completions`の`stream: false`にはJSON、`stream: true`には
OpenAI互換SSE (`text/event-stream`) を返します。低遅延応答は同じHTTP接続上のSSE deltaを
逐次転送して実現します。

追加27Bは`route`へ`llm-speed`、公式Q5_K_MのOrnith 35Bは`llm-35b`、ROCmFP4速度版は`llm-35b-speed`を明示した場合だけ選択されます。比較用Qwen3.6-35Bは`llm-qwen36-35b`で固定できます。`llm-default`はswapせずResident 27Bへ固定されます。fallbackはrequestで`allowFallback: true`を指定した場合だけ許可されます。同じworker swap groupの別Runtimeにactive Allocationがある場合もpreemptしません。既定の`capacityPolicy: reject`は拒否し、`capacityPolicy: wait`はTTL内で優先度付き待機列へ入ります。

## Agent Connection API

Profile一覧は`defaultAgentProfile: "coding-default"`を返します。既定ProfileはConnection作成bodyから
省略できます。workerと35BのRuntime・Routeは用途別の公開model／profileとして明示選択できます。
claimはLARM Gatewayの`baseUrl`、public `model`、Provider限定の短期token、semantic health URLを
返します。backend portや長期API token、独自transport descriptorは返しません。

```bash
connection_json="$(curl -fsS -X POST http://127.0.0.1:9810/v1/agent-connections \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: agent-$(date +%s)" \
  -d '{"audience":"same-host"}')"
connection_id="$(jq -er .id <<<"${connection_json}")"

# GET /v1/agent-connections/:idをreadyまでpollしてからclaimします。
curl -fsS -X POST "http://127.0.0.1:9810/v1/agent-connections/${connection_id}/claim" \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"format":"openai-provider-v1"}'
```

`/health`ではなくclaim内のProvider health URLを使用してください。LLM healthは
`max_tokens: 1`の固定推論をJSONとHTTP SSEの両形式で行い、JSONのcompletion tokenがちょうど1、
SSEのmedia type、meaningful delta、`data: [DONE]`まで検証します。
成功は10秒、失敗は1秒だけcacheし、通常task queueへprobeを追加しません。
SAAAのMac接続は[`../../docs/local-node.md`](../../docs/local-node.md)の直接LAN接続contractを使います。
local-nodeのproduction unitは通常control・management APIの認証を維持して`0.0.0.0:9810`をlistenし、
Agent Connection lifecycleだけは長期Bearerを省略できます。Audience `saaa-desktop`は受理したConnection
作成requestのoriginから`/v1` URLを生成します。固定IPは
設定せず、SAAAはmDNS/DNS名または現在のDHCP addressで到達したURLをそのまま使用します。

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

Artifact stage、release activation・rollback、allow-listed起動は一つのmutation coordinatorで直列化します。競合中の変更は待たせずfail closedします。Runtime catalogは起動時に一度だけ検証・固定し、設定変更はversioned LARM releaseの適用とdaemon restartで行います。shutdownは新規mutationを閉じ、実行中operationを設定済み期限までdrainします。

単一fileと、全fileが列挙・検証されたdirectory snapshotをstageできます。未列挙file、symlink、危険path、checksum不一致を拒否します。Resident Runtimeの無人activationは拒否します。
`deploymentPolicy: allow-listed`のAllocationにも同じ管理tokenが必要です。
activation後のhealth確認に失敗した場合は、直前のartifact targetへ自動rollbackします。
Artifact downloadのBackend上限は既定3600秒で、例のpoll上限はその結果を取得できるよう3700秒です。

`@larm/client`の`waitForOperation`はcontrol operationをterminal状態までpollし、進行中HTTPを含む全体timeoutと`AbortSignal`を扱います。`withAllocation`は成功・失敗のどちらでもAllocationを一度だけ解放し、処理と解放が両方失敗した場合は双方を`AggregateError`で保持します。

Canary後は`larm_active_allocations`、`larm_execution_active`、`larm_execution_queued`、`larm_artifact_operations_active`が実状態へ収束したことを確認します。

- Resident Runtimeは停止しません。
- Preferred Runtimeだけを`prepare`とidle `release`の対象にします。
- local-node installerはPreferredの`qwen-tts.service`だけをstart / stopできるpolkit ruleを導入します。
- Resident systemd serviceはbackendとpolkitの両方でlifecycle変更の対象外です。
- llama-swap process自体の寿命はsystemdが管理し、daemonはmodelのload/unloadだけを委譲します。
