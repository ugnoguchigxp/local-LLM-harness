# local-node deployment

This directory is the reproducible `local-node` Linux deployment profile for AI MAX+ 395 hardware.
It contains metadata and launch configuration only. Model weights, virtual environments,
build trees, caches, generated audio, and logs stay outside Git under `/srv/ai`.

## Layout

- `models.yaml`: registered artifact source and absolute runtime placement, never model data
- `releases.yaml`: immutable Runtime-to-artifact release catalog
- `sources.lock.yaml`: external runtime source/release pins, never built binaries
- `systemd/`: the units installed by the `local-node` profile
- `polkit/`: LARMにPreferred providerだけのstart / stopを許可する最小権限rule
- `scripts/prepare-host.sh`: conservative host prerequisites; no firewall mutation or reboot
- `scripts/configure-saaa-rest-access.sh`: exact SAAA source hostから9810だけを許可するplan・apply・rollback
- `scripts/restore-dhcp.sh`: legacy LARM固定address overlayをattended Netplanで除去してDHCPを検証
- `scripts/install-services.sh`: unitをinstallし、Resident/controlだけをenableする（restartなし）。
  `LARM_INSTALL_SCOPE=gateway`ではLARM Gatewayだけをinstall・enableし、既存Provider unitを変更しない
- `scripts/preflight-larm.sh`: secretを含めないread-only commissioning inventory
- `scripts/backup-host-state.sh`: installed unitとcurrent pointerのdigest付きoperator backup
- `scripts/network-converge.sh`: listener・UFW差分のplanとdigest確認付き限定apply・rollback
- `scripts/verify-external-assets.ts`: operator配備VOICEVOX VVMのidentity検証
- `scripts/release-larm.sh`: clean commitのversioned apply、rollback、review済みbounded retention
- `scripts/verify.sh`: GPU, service, HTTP health, and memory checks
- `scripts/verify-saaa-native-provider.ts`: exact native subprotocolと`native.ready`のrelease gate
- `scripts/smoke-larm.sh`: Resident 27B固定のAllocation、stream、release smoke
- `scripts/smoke-saaa-agent-connection.sh`: request-originを含むSAAA向けcreate・claim・WebSocket・release smoke
- `scripts/smoke-saaa-websocket.ts`: 短期Provider credentialでnative WebSocketを検証するend-to-end smoke
- `scripts/soak-saaa-websocket.ts`: 1,000 turn・30分・毎turn network flap/resume・latency/RSS gate
- `scripts/benchmark-saaa-websocket.ts`: 16 byte frame codecの10,000 delta latency/RSS gate
- `scripts/smoke-voice.sh`: operator提供音声によるSTT・通常TTS smoke
- `scripts/canary-gate.sh`: 4 seriesのSLO、boot epoch、fallback、leakを拒否するcanary gate
- `scripts/shadow-larm.sh`: 推論せずlegacyとv1のroute・Runtime・endpointを比較
- `scripts/fault-larm.sh`: 明示confirmationを要求するdaemon・Preferred fault harness
- `scripts/benchmark-larm.ts`: repository外raw JSONと匿名化summaryを分離する4 series benchmark
- `scripts/performance-larm.ts`: LLM・ASR・TTSの単体性能と3系統同時利用時の劣化を比較する診断benchmark
- `scripts/reazonspeech_shadow_api.py`: production routeを変えずCPU ASRを比較する評価専用endpoint
- `scripts/reazonspeech_espnet_shadow_api.py`: ReazonSpeech ESPnet v2をROCmで比較する評価専用endpoint
- `scripts/compare-slo.ts`: version管理された`deploy/local-node/slo.yaml`とのfail-closed比較

Runtime-manager configuration is in [`../../config/local-node`](../../config/local-node).
Application-owned adapters are in [`../../apps`](../../apps).

LARM artifact operations use `/srv/ai/models/.larm-staging` and
`/srv/ai/models/.larm-rollback` for model data, and `/var/lib/larm` for operation
journals. `prepare-host.sh` creates these paths for the operator. The repository
continues to contain metadata only.

Checksummed single files and exact directory snapshots are eligible for unattended staging.
A snapshot fixes a sorted file list, per-file size and SHA-256, total size, file limit, and
canonical snapshot digest. Unlisted files, links, and unsafe paths are rejected. Resident runtime
activation remains an attended operation; Qwen TTS is the first Preferred snapshot activation target.
The installer creates `/etc/larm/larm.env` with local API, Agent Connection signing,
and management credentials. Existing values are preserved and only missing variables
are added. Operator-side smoke commands can load them with
`set -a; source /etc/larm/larm.env; set +a` without printing their values.
It also creates non-secret audit settings in `/etc/larm/inference-audit.env`, creates
`/etc/larm/inference-audit.key` without replacing an existing key, and creates
`/var/lib/larm/inference-audit` with mode 0700. The daemon unit requires encrypted LLM audit
capture, and the persistent hourly `larm-inference-audit-prune.timer` enforces the seven-day,
10 GiB, and minimum-free-space bounds even after daemon downtime. Audit payloads are not part of
release or host-state backups. The prune service reads only the audit settings and key; API,
management, and Agent Connection credentials remain outside its environment.
`qwen-tts.service`はinstallのみ行い、boot時はdisableのままです。LARMは同梱の
polkit ruleにより、このPreferred serviceのstart / stopだけを無人実行できます。

`qwen-general`のWebSocket capabilityは、`larm-native-qwen-provider.service`が
loopback `ws://127.0.0.1:8090/v1/native/llm/stream`で
`larm.native-llm-stream.v1`を受理し、SAD1 encoding、pause/resume、cancel、tool continuation、
usage、必要capacityをすべて宣言するstrict `native.ready`を返した場合だけclaimへ現れます。companion
自身もpatched engineのraw semantic Unix socket IPCを受けた場合だけreadyになります。
`llama-server`のHTTP/SSE endpointを接続してもreadyにならず、LARMはSSE bridgeへfallbackしません。
LAN向けSAAA streamingを有効にする場合は、LARM service userが読める証明書と秘密鍵の絶対pathを
`/etc/larm/larm.env`の`LARM_TLS_CERT_FILE`と`LARM_TLS_KEY_FILE`へ対で設定してください。

## Apply

Before overwriting any installed unit, create an operator-owned backup outside the repository.
The plan rejects symlinked/non-regular units; apply copies the profile's LARM/Provider units and
the current release pointer without copying credential contents.

```bash
backup_label="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"
backup_plan="$(env LARM_BACKUP_LABEL="${backup_label}" \
  deploy/local-node/scripts/backup-host-state.sh plan)"
printf '%s\n' "${backup_plan}"
backup_confirm="$(jq -er .confirmation <<<"${backup_plan}")"
sudo env LARM_BACKUP_LABEL="${backup_label}" LARM_BACKUP_CONFIRM="${backup_confirm}" \
  deploy/local-node/scripts/backup-host-state.sh apply
```

`prepare-host.sh` installs packages, masks sleep targets, adds the service account to the GPU
groups, and creates data directories. It does not change or enable UFW, configure ROCm/TTM, or
reboot. SAAA REST access is handled separately by `configure-saaa-rest-access.sh`, which never
changes SSH or Provider rules. Provider rule removal is handled by the separate digest-bound tool in
[`../../specs/production-completion-plan.html`](../../specs/production-completion-plan.html).

LARM does not require or install a static host address. If the retired
`/etc/netplan/99-larm-static-ip.yaml` overlay is still present, restore DHCP through an attended
Netplan transaction before relying on mDNS/DNS discovery:

```bash
deploy/local-node/scripts/restore-dhcp.sh plan
sudo deploy/local-node/scripts/restore-dhcp.sh apply
```

The SAAA rule requires one explicit IPv4 host, refuses an inactive or unreadable firewall, and
rejects broader or duplicate port 9810 allow rules. Review the plan digest before applying it.

```bash
saaa_plan="$(SAAA_SOURCE_IPV4=192.168.0.x \
  deploy/local-node/scripts/configure-saaa-rest-access.sh plan)"
printf '%s\n' "${saaa_plan}"
saaa_confirm="$(jq -er .confirmation <<<"${saaa_plan}")"
sudo env SAAA_SOURCE_IPV4=192.168.0.x LARM_SAAA_NETWORK_CONFIRM="${saaa_confirm}" \
  deploy/local-node/scripts/configure-saaa-rest-access.sh apply
```

Rollback is accepted only for a rule recorded as added by this tool:

```bash
saaa_rollback_plan="$(sudo env SAAA_SOURCE_IPV4=192.168.0.x \
  deploy/local-node/scripts/configure-saaa-rest-access.sh rollback-plan)"
printf '%s\n' "${saaa_rollback_plan}"
saaa_rollback_confirm="$(jq -er .confirmation <<<"${saaa_rollback_plan}")"
sudo env SAAA_SOURCE_IPV4=192.168.0.x \
  LARM_SAAA_NETWORK_ROLLBACK_CONFIRM="${saaa_rollback_confirm}" \
  deploy/local-node/scripts/configure-saaa-rest-access.sh rollback
```

Do not run the apply sequence below as a stable deployment until Milestone 22 is a reviewed clean
commit and a rollback target is available.

```bash
cd /srv/ai/apps/local-LLM-harness
# Host preparation, only when required:
# sudo deploy/local-node/scripts/prepare-host.sh
deploy/local-node/scripts/preflight-larm.sh
# Complete the reviewed backup block above before installation.
sudo deploy/local-node/scripts/install-services.sh
deploy/local-node/scripts/release-larm.sh plan
sudo deploy/local-node/scripts/release-larm.sh apply
sudo systemctl start llama-server.service larm-native-qwen-provider.service llama-swap-worker.service \
  qwen-asr.service whisper-asr.service voicevox-tts.service larm-daemon.service  # first install only
deploy/local-node/scripts/verify.sh
deploy/local-node/scripts/smoke-larm.sh
# After loading /etc/larm/larm.env without printing it, use the same DHCP-aware URL as SAAA:
# LARM_BASE_URL=http://gnosis.local:9810 deploy/local-node/scripts/smoke-saaa-agent-connection.sh
# native Providerのcommissioning後、claimをclaim.jsonへ保存してから:
# export LARM_SAAA_STREAM_URL="$(jq -er '.providers[] | select(.streaming) | .streaming.url' claim.json)"
# export LARM_SAAA_PROVIDER_TOKEN="$(jq -er '.providers[] | select(.streaming) | .credential.token' claim.json)"
# export LARM_SAAA_ALLOCATION_ID="$(jq -er '.allocationId' claim.json)"
# export LARM_SAAA_MODEL="$(jq -er '.providers[] | select(.streaming) | .model' claim.json)"
# bun run smoke:saaa-websocket
# 1,000 turn / 30分 gate。各turnの切断中にConnectionをrenew/claimし、token rotationを検証する:
# export LARM_BASE_URL=https://gnosis.local:9810
# export LARM_API_TOKEN=...  # secret storeまたは読み込んだlarm.envから設定し、表示しない
# export LARM_SAAA_CONNECTION_ID="$(jq -er '.id' claim.json)"
# bun run soak:saaa-websocket
# unset LARM_SAAA_STREAM_URL LARM_SAAA_PROVIDER_TOKEN LARM_SAAA_ALLOCATION_ID LARM_SAAA_MODEL
# unset LARM_BASE_URL LARM_API_TOKEN LARM_SAAA_CONNECTION_ID
# LARM_CANARY_AUDIO_FILE=/path/to/non-sensitive.wav deploy/local-node/scripts/smoke-voice.sh
# After production calibration has changed deploy/local-node/slo.yaml to calibrated:
# LARM_CANARY_EVIDENCE_DIR=/srv/ai/logs/larm-canary \
# LARM_BENCHMARK_AUDIO_FILE=/path/to/non-sensitive.wav \
# deploy/local-node/scripts/canary-gate.sh
```

`plan`の`cleanupCandidates`が空でない場合は、候補と`cleanupConfirm`をreviewしてから次のように
同じcommitへapplyします。digestが一致しなければ、削除も切替も行いません。

```bash
plan_json="$(deploy/local-node/scripts/release-larm.sh plan)"
cleanup_confirm="$(jq -r '.cleanupConfirm // empty' <<<"${plan_json}")"
sudo env LARM_RELEASE_CLEANUP_CONFIRM="${cleanup_confirm}" \
  deploy/local-node/scripts/release-larm.sh apply
```

The installer copies and enables units but intentionally does not start or restart them. On an
update, inspect the diff and restart only a changed service when its behavior must be applied;
do not use the first-install start command as a blanket restart. The installer always converges
`qwen-tts.service` to disabled without stopping an active process.

`larm-daemon.service`はGit worktreeではなく`/srv/ai/apps/larm-current`を参照します。
`release-larm.sh apply`はclean commitをrepository外へ展開し、frozen installと全gateを通過した後だけ
current symlinkを原子的に切り替え、LARM daemonだけをrestartします。manifestにはcommit、LARM・Bun
version、lockfile digest、`node_modules` tree digest、config revision、作成時刻を保存します。既存世代の
再利用とrollbackでは、manifest、Git source tree、lockfile、dependency tree、config revisionを切替前に
再検証し、`/health.releaseCommit`まで一致を確認します。
前世代へ戻す操作は次の通りです。

```bash
sudo deploy/local-node/scripts/release-larm.sh rollback
```

保持数を超えた世代は`plan`で候補を確認し、その`cleanupConfirm`を
`LARM_RELEASE_CLEANUP_CONFIRM`へ明示した`apply`だけが削除します。削除は新世代のidentityとreadinessを
確認した後に行い、health失敗時はcurrentとrollback pointerの両方を復元します。単独の`cleanup`も
実行時に表示するdigestとの一致が必要です。credential、model、journalはrelease directory外にあり、
upgradeとrollbackで保持されます。dirty source、symlink root、並行mutation、gate失敗はcurrent切替前に
拒否します。初回releaseのhealthが失敗して前世代がない場合はdaemonを停止し、作成したcurrent
pointerを除去して未導入状態へ戻します。

Artifact stage and activation are asynchronous. A Runtime with multiple artifacts requires all
of them to reach `succeeded` staging operations before activation. The complete polling example
is in [`../../apps/daemon/README.md`](../../apps/daemon/README.md).

推論trafficを切り替えないshadow比較と、明示confirmation付きfault matrixは次の順で実行します。

```bash
deploy/local-node/scripts/shadow-larm.sh
deploy/local-node/scripts/fault-larm.sh plan
# Reviewして対象を選んだ後だけ:
# sudo env LARM_FAULT_CONFIRM=local-node-attended deploy/local-node/scripts/fault-larm.sh daemon-restart
```

Do not reboot this dual-boot host as part of deployment automation. A reboot can select
Windows and make the node unavailable. Reboot only as an explicit, attended operation.

## Roll back LARM without touching Resident providers

```bash
sudo deploy/local-node/scripts/release-larm.sh rollback
systemctl is-active llama-server.service qwen-asr.service whisper-asr.service voicevox-tts.service
```

This rollback does not remove `/etc/larm/larm.env`, artifact staging data, journals, or any model.
Before the Gateway-only cutover, the existing direct Provider ports remain available. After that
cutover, use LARM release rollback first; restoring a single direct Provider and limited CIDR is a
separate attended network rollback. Removing a first-install unit or artifact data is a separate
destructive operator decision and is not part of the rollback command above.

After a successful canary, save aggregate timing, memory, error, queue, config revision, and boot
epoch in a new Spec HTML document. Do not commit prompts, transcripts, audio, credentials, raw model
data, or unredacted logs.

日常の性能切り分けには、release commit一致を要求するSLO canaryとは別に診断benchmarkを使います。
既定ではLLM・ASR・TTSの単体系列と、3系統を同一Allocationから同時発射するmixed系列を順番に実行します。
Resident Providerは停止・再起動せず、warmupは最初の要求を集計から除くだけです。

```bash
set -a
source /etc/larm/larm.env
set +a
bun run perf:diagnostic
```

WebSocket wire実装のlocal release gateはmodelを呼ばず、20 byte deltaを10,000回encodeして
250 ms / peak RSS増加16 MiBの上限を検証します。protocol conformanceと合わせて実行します。

```bash
bun run conformance:saaa
bun run benchmark:saaa-websocket
```

固定fixtureと外部証跡を使う場合は、`LARM_PERF_AUDIO_FILE`へ絶対パス、`LARM_PERF_OUTPUT`へ既存でない
repository外の絶対パスを指定します。反復数は`LARM_PERF_ITERATIONS`、warmup数は
`LARM_PERF_WARMUPS`、系列は`LARM_PERF_SCENARIOS`で変更できます。

評価専用のOpenAI互換ASRをproduction Bindingの代わりに測る場合は、loopback上の
`POST /v1/audio/transcriptions`を`LARM_PERF_ASR_URL`へ指定します。ASR-onlyではAllocationを作らず、
mixedではLLMとTTSだけを既存LARM Allocationへ固定し、外部ASRを同時発射します。識別子は
`LARM_PERF_ASR_ROUTE`、`LARM_PERF_ASR_RUNTIME`、`LARM_PERF_ASR_RELEASE`でreportへ固定します。
外部URLはcredential、query、fragmentを含まないHTTP loopbackだけを受理します。

## SLO calibration and network convergence

`deploy/local-node/slo.yaml` is deliberately `uncalibrated` until all four production series have been
measured. That state always fails the comparator. Calibration uses a repository-external raw and
summary path; the summary contains only aggregate identity and metrics. Evidence files are created
with atomic no-overwrite publication and mode 0600, including comparator output. LLM samples require
a valid nonstreaming JSON completion, STT requires non-empty JSON text, and telemetry is sampled
continuously while each series runs. A failed run still publishes its bounded raw error codes and
partial samples before exiting nonzero; it never emits a passing aggregate summary.
`llm-realtime`は`coding-default` Agent Connectionを作成してclaimされたWebSocketを測り、最初の
binary deltaをTTFBとする。`llm-normal`は非streaming HTTP JSONを測る。

```bash
evidence_dir=/srv/ai/logs/larm-calibration/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "${evidence_dir}"
LARM_BENCHMARK_OUTPUT="${evidence_dir}/raw.json" \
LARM_BENCHMARK_SUMMARY="${evidence_dir}/summary.json" \
LARM_BENCHMARK_COMMIT="$(git rev-parse HEAD)" \
LARM_BENCHMARK_SERIES=all \
LARM_BENCHMARK_AUDIO_FILE=/path/to/non-sensitive.wav \
bun run deploy/local-node/scripts/benchmark-larm.ts
```

Before the final cutover, run `network-converge.sh plan`. An apply is accepted only when UFW is
readable, all Provider listeners are already loopback-only, every Provider allow rule is an exact
LAN-CIDR candidate, and `LARM_NETWORK_CONFIRM` equals the displayed digest. Rollback restores one
reviewed port and an IPv4 `/24`–`/32` only; first restore that Provider's operator-backed-up unit and
verify its network listener, then use `rollback-plan` and its separate confirmation digest. If a
multi-rule apply or its post-check fails, the tool restores every rule it already removed and reports
explicitly if that compensation is incomplete.
