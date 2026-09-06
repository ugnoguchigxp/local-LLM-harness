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
- `scripts/build-larm-release.sh`: 明示したreview済みcommitを非特権で検証・bundle化し、desired intentへ署名
- `scripts/activate-larm-release.sh`: install済みroot helper。署名・treeを再検証しatomic切替だけを実行
- `scripts/record-larm-release-gate.sh`: HTTP canary、consumer一件、24時間soakの順序を状態機械で強制
- `scripts/rollback-larm-release.sh`: candidate codeをroot実行せず前世代へatomic rollback
- `scripts/release-larm.sh`: 新Controller移行前の既存世代向けlegacy release helper
- `scripts/verify.sh`: GPU, service, HTTP health, and memory checks
- `scripts/smoke-larm.sh`: Resident 27B固定のAllocation、stream、release smoke
- `scripts/smoke-agent-http.ts`: 任意のAgent Profileに対するHTTP JSON/SSE・解放・token失効smoke
- `scripts/smoke-http-provider-live.ts`: Bearer＋modelだけでLLM JSON/SSE、ASR、TTSを検証するlive smoke
- `scripts/monitor-http-provider-soak.ts`: 同一Provider世代の定期smokeを永続集計し、失敗と観測gapを保持
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
The installed daemon explicitly sets `LARM_SERVICE_HARNESS_AUTH_ENABLED=false`: SAAA can discover
and call batch ASR without a Bearer credential while the normal control and LLM boundaries remain
unchanged. Set it to `true` only together with a coordinated SAAA credential contract change.
It also creates non-secret audit settings in `/etc/larm/inference-audit.env`, creates
`/etc/larm/inference-audit.key` without replacing an existing key, and creates
`/var/lib/larm/inference-audit` with mode 0700. The daemon unit requires encrypted LLM audit
capture, and the persistent hourly `larm-inference-audit-prune.timer` enforces the seven-day,
10 GiB, and minimum-free-space bounds even after daemon downtime. Audit payloads are not part of
release or host-state backups. The prune service reads only the audit settings and key; API,
management, and Agent Connection credentials remain outside its environment.
`qwen-tts.service`はinstallのみ行い、boot時はdisableのままです。LARMは同梱の
polkit ruleにより、このPreferred serviceのstart / stopだけを無人実行できます。

`qwen-general`はloopbackのOpenAI互換HTTP endpointへ接続し、GatewayがJSONまたはSSEとして転送します。
公開data planeはHTTPだけです。`saaa-desktop`の
`host-private` Audienceも標準HTTPの`baseUrl`だけを返します。LAN境界外へ公開する場合は、LARM service
userが読める証明書と秘密鍵の絶対pathを`/etc/larm/larm.env`の`LARM_TLS_CERT_FILE`と
`LARM_TLS_KEY_FILE`へ対で設定し、HTTPSを使用してください。

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

通常のreleaseは、review済み完全commitから非特権builderがbundleを作り、署名済みdesired intentを
root activatorへ渡します。activatorは候補コードやtestを実行せず、署名、manifest、tree digestを再検証して
atomic切替とdaemon restartだけを行います。

```bash
cd /srv/ai/apps/local-LLM-harness
# Host preparation, only when required:
# sudo deploy/local-node/scripts/prepare-host.sh
deploy/local-node/scripts/preflight-larm.sh
# Complete the reviewed backup block above before installation.
sudo deploy/local-node/scripts/install-services.sh
approved_commit="$(git rev-parse HEAD)" # review済みの完全commitと照合する
LARM_RELEASE_COMMIT="${approved_commit}" deploy/local-node/scripts/build-larm-release.sh
# larm-release-activator.pathが署名済みintentを検出してroot activatorへ引き継ぐ。
systemctl status larm-release-activator.service --no-pager
curl -sS http://127.0.0.1:9810/v1/release-convergence \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" | jq
sudo systemctl start llama-server.service llama-swap-worker.service \
  qwen-asr.service whisper-asr.service voicevox-tts.service larm-daemon.service  # first install only
deploy/local-node/scripts/verify.sh
deploy/local-node/scripts/smoke-larm.sh
# After loading /etc/larm/larm.env without printing it, run the HTTP Agent Connection canary:
# LARM_BASE_URL=http://gnosis.local:9810 \
# LARM_AGENT_PROFILE=contextstill-background \
# LARM_AGENT_AUDIENCE=saaa-desktop \
# LARM_AGENT_CLIENT=contextstill \
# LARM_EXPECTED_MODEL=qwen-agent-worker \
# LARM_EXPECTED_RELEASE_COMMIT="$(git rev-parse HEAD)" \
# bun run smoke:agent-http
# LARM_CANARY_AUDIO_FILE=/path/to/non-sensitive.wav deploy/local-node/scripts/smoke-voice.sh
# After production calibration has changed deploy/local-node/slo.yaml to calibrated:
# LARM_CANARY_EVIDENCE_DIR=/srv/ai/logs/larm-canary \
# LARM_BENCHMARK_AUDIO_FILE=/path/to/non-sensitive.wav \
# deploy/local-node/scripts/canary-gate.sh
```

HTTP Provider canaryはsecret-free JSONをrepository外へ保存し、root管理の状態機械へ記録します。
consumer完了後、同じProvider世代の24時間soakが合格すると`complete`へ進みます。

```bash
umask 077
LARM_EXPECTED_RELEASE_COMMIT="${approved_commit}" \
  bun run smoke:http-provider-live > /srv/ai/logs/larm-canary/http-provider.json
sudo /usr/local/libexec/larm/record-larm-release-gate canary \
  /srv/ai/logs/larm-canary/http-provider.json
# ContextStill一件完了・成果一回保存・次job境界再評価の証跡を得た後だけ:
# sudo /usr/local/libexec/larm/record-larm-release-gate consumer \
#   /absolute/path/to/contextstill-consumer-evidence.json
# 同一release/config/bootで24時間、96 sample以上、失敗0、最大gap 30分以下となった後だけ:
# sudo /usr/local/libexec/larm/record-larm-release-gate soak \
#   /var/lib/larm/http-provider-soak/status.json
```

consumer証跡はcanaryと同じProvider世代を固定し、次のstrict JSONとします。`configurationRevision`と
`bootEpoch`が保存済みcanaryと一致しない証跡、手動・業務pauseの解除結果、二重保存は受理されません。

```json
{
  "schemaVersion": 1,
  "kind": "consumer-completion",
  "consumer": "contextstill",
  "desiredRelease": "<40桁commit>",
  "configurationRevision": "<64桁config revision>",
  "bootEpoch": "<canaryと同じepoch>",
  "jobIdSha256": "<64桁hash>",
  "result": "completed",
  "persistenceCount": 1,
  "nextBoundaryActivityRechecked": true,
  "observedAt": "2026-09-06T00:00:00Z"
}
```

`larm-http-provider-monitor.timer`は15分ごとにcatalog、JSON、SSEを実行し、
`/var/lib/larm/http-provider-soak/status.json`へ世代別の`sampleCount`、`failureCount`、
`durationSeconds`、`maxGapSeconds`をatomic保存します。失敗履歴は同じ世代内の後続成功では消えず、
release／config／bootのいずれかが変わった場合だけ新しいsoak windowを開始します。

The installer copies and enables units but intentionally does not start or restart current units. It
stops, disables, and removes the obsolete `larm-native-qwen-provider.service` unit when present. On an
update, inspect the diff and restart only a changed service when its behavior must be applied;
do not use the first-install start command as a blanket restart. The installer always converges
`qwen-tts.service` to disabled without stopping an active process.

`larm-daemon.service`はGit worktreeではなく`/srv/ai/apps/larm-current`を参照します。builderは
`/srv/ai/apps/larm-candidates/&lt;full-commit&gt;`でfrozen installと全gateを非特権実行し、modeを固定したtree
digestとconfig revisionをmanifestへ保存します。全gate後はdev dependencyを除去してproduction dependencyだけを
再installします。root activatorは`/etc/larm/release-signing.pub`だけを信頼し、
候補をroot所有releaseへcopy後にdigestを再検証します。`/health`、`/ready`、OpenAPI、model catalog、Activity、
Profile catalogの軽量contractが不一致なら前世代へ自動rollbackします。実推論は非特権の
`smoke:http-provider-live`が行います。

旧`release-larm.sh apply`はrollback期間の既存世代向け互換手段であり、新しい自動配備経路には使いません。
互換手段で切り替える場合も、release identityとcatalogの検証後に実ProviderへLLM JSON/SSE、
silence WAVによるASR、TTSのlive canaryを実行し、いずれかの失敗時は前世代へ自動rollbackします。
前世代へ戻す操作は、固定install済みrollback helperを使います。

```bash
sudo /usr/local/libexec/larm/rollback-larm-release
```

credential、model、journalはrelease directory外にあり、upgradeとrollbackで保持されます。dirty source、
暗黙HEAD、未署名intent、symlink escape、並行mutation、digest不一致、contract失敗は拒否します。

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
sudo /usr/local/libexec/larm/rollback-larm-release
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
既定ではHTTP JSON、HTTP SSE、ASR、TTSの単体系列と、各LLM応答形式を
音声2系統と同時発射するmixed系列を順番に実行します。Resident Providerは停止・再起動せず、
warmupは最初の要求を集計から除くだけです。

```bash
set -a
source /etc/larm/larm.env
set +a
bun run perf:diagnostic
```

固定fixtureと外部証跡を使う場合は、`LARM_PERF_AUDIO_FILE`へ絶対パス、`LARM_PERF_OUTPUT`へ既存でない
repository外の絶対パスを指定します。反復数は`LARM_PERF_ITERATIONS`、warmup数は
`LARM_PERF_WARMUPS`、系列は`LARM_PERF_SCENARIOS`で変更できます。選択肢は
`llm,llm-sse,asr,tts,mixed,mixed-sse`です。HTTP JSONとSSEのfirst token、全体latency、
output tokens/secを同じProviderに対して比較します。

評価専用のOpenAI互換ASRをproduction Bindingの代わりに測る場合は、loopback上の
`POST /v1/audio/transcriptions`を`LARM_PERF_ASR_URL`へ指定します。ASR-onlyではAllocationを作らず、
mixedではLLMとTTSを通常Allocationへ固定し、外部ASRと同時発射します。識別子は
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
`llm-realtime`はOpenAI互換HTTP SSEの最初のcontent deltaをTTFBとします。
`llm-normal`は非streaming HTTP JSONを測ります。

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
