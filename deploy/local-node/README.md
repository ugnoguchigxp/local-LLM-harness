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
- `scripts/prepare-embedding-runtime.sh`: 固定source revisionからrepository外へEmbedding binaryをbuild
- `scripts/configure-larm-lan-access.sh`: 現在のLAN prefixを動的検出し、LANから9810だけを許可するplan・apply・rollback
- `scripts/configure-saaa-rest-access.sh`: 旧exact-host ruleの互換運用・rollback用
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
`qwen-tts.service`と`larm-embedding.service`はinstallのみ行い、boot時はdisableのままです。LARMは同梱の
polkit ruleにより、これらPreferred serviceのstart / stopだけを無人実行できます。Embeddingモデルは
`intfloat/multilingual-e5-small` revision `614241f622f53c4eeff9890bdc4f31cfecc418b3`の
ONNX/QInt8 snapshotへ固定され、artifact stagingが全6ファイルのsize・SHA-256・snapshot digestを検証します。

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
reboot. LAN REST access is handled separately by `configure-larm-lan-access.sh`, which never
changes SSH or Provider rules. Provider rule removal is handled by the separate digest-bound tool in
[`../../specs/production-completion-plan.html`](../../specs/production-completion-plan.html).

LARM does not require or install a static host address. If the retired
`/etc/netplan/99-larm-static-ip.yaml` overlay is still present, restore DHCP through an attended
Netplan transaction before relying on mDNS/DNS discovery:

```bash
deploy/local-node/scripts/restore-dhcp.sh plan
sudo deploy/local-node/scripts/restore-dhcp.sh apply
```

The LAN rule does not fix an address, prefix, or interface in source. It derives the current
default-route interface and its sole global RFC1918 IPv4 prefix, refuses an inactive or unreadable
firewall, and rejects ambiguous network discovery, duplicate LAN rules, or Gateway rules outside
the discovered prefix. `LARM_LAN_INTERFACE` is only an attended override when multiple default-route
interfaces make automatic discovery impossible. Review the discovered values and plan digest before
applying it.

```bash
lan_plan="$(sudo deploy/local-node/scripts/configure-larm-lan-access.sh plan)"
printf '%s\n' "${lan_plan}"
lan_confirm="$(jq -er .confirmation <<<"${lan_plan}")"
sudo env LARM_LAN_NETWORK_CONFIRM="${lan_confirm}" \
  deploy/local-node/scripts/configure-larm-lan-access.sh apply
```

Rollback is accepted only for a rule recorded as added by this tool:

```bash
lan_rollback_plan="$(sudo deploy/local-node/scripts/configure-larm-lan-access.sh rollback-plan)"
printf '%s\n' "${lan_rollback_plan}"
lan_rollback_confirm="$(jq -er .confirmation <<<"${lan_rollback_plan}")"
sudo env LARM_LAN_NETWORK_ROLLBACK_CONFIRM="${lan_rollback_confirm}" \
  deploy/local-node/scripts/configure-larm-lan-access.sh rollback
```

通常のreleaseは、review済み完全commitから非特権builderがbundleを作り、署名済みdesired intentを
root activatorへ渡します。activatorは候補コードやtestを実行せず、署名、manifest、tree digestを再検証して
atomic切替とdaemon restartだけを行います。

```bash
cd /srv/ai/apps/local-LLM-harness
# Host preparation, only when required:
# sudo deploy/local-node/scripts/prepare-host.sh
# As ugnoguchi, prepare the pinned external Embedding runtime when required:
# deploy/local-node/scripts/prepare-embedding-runtime.sh
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
# Embedding model staging・release activation後のquery/pass、renew、revoke、release canary:
# LARM_EXPECTED_RELEASE_COMMIT="$(git rev-parse HEAD)" bun run smoke:embedding
# LARM_CANARY_AUDIO_FILE=/path/to/non-sensitive.wav deploy/local-node/scripts/smoke-voice.sh
# After production calibration has changed deploy/local-node/slo.yaml to calibrated:
# LARM_CANARY_EVIDENCE_DIR=/srv/ai/logs/larm-canary \
# LARM_BENCHMARK_AUDIO_FILE=/path/to/non-sensitive.wav \
# deploy/local-node/scripts/canary-gate.sh
```

## KV:memの試用と運用

`KV:mem`はSAAAのQwen 3.8要求に限定して明示選択するManaged Context経路の暫定名称です。
SAAAの標準HTTP Provider設定では公開modelを`qwen3.8-kv-mem`にします。このmodelは
`llm-saaa-kv-mem`から`qwen-worker-quality`だけへ解決され、request時にon-demand起動します。
fallbackはありません。ContextStillは`qwen-agent-worker`を維持し、`qwen-worker-agent`の従来KVを使用します。
通常の`coding-default`もResident Qwenのままです。

```bash
curl -sS -X POST http://127.0.0.1:9810/v1/chat/completions \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-kv-mem","stream":false,"messages":[{"role":"user","content":"こんにちは"}]}'
```

このrequestはsnapshot対応hostの選択確認には使えますが、Context Viewを指定しないためsnapshot自体は利用しません。
KVをmaterializeする場合は`llm-saaa-kv-mem`の明示Allocationを維持したままContext Viewを作成し、同じ
Chat requestへ`x-larm-allocation-id`と`x-larm-context-view-id`を渡します。

Managed Contextは認定済みのreasoning runtimeがhost中のときだけActiveになります。source本文は
control APIへinlineせず、API tokenと同じprincipal scopeへ先にprovisionします。コマンドはlive
runtimeのcanonical tokenizerでattestationを作成し、本文を表示せず、登録に使うhandle、SHA-256、
byte数、token数、tokenizer digestだけを返します。

```bash
set -a
source /etc/larm/larm.env
set +a
bun run context:source:provision provision policy-v7 /absolute/path/to/policy.txt
curl -sS http://127.0.0.1:9810/v1/context-status \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" | jq
```

既定tokenizer endpointはresidentの<code>http://127.0.0.1:8080</code>です。別の認定runtimeを使う場合は
<code>LARM_CONTEXT_TOKENIZER_ENDPOINT</code>をそのloopback endpointへ設定します。Provisionは512 GiBの
source byte quotaと256 GiB filesystem free floorをprocess間lock内で検査します。登録bodyの
<code>byteCount</code>、<code>tokenCount</code>、<code>tokenizerDigest</code>はコマンド出力を使用し、daemon側で
attestationと再照合されます。

Source Set quotaはprincipalあたり20,000,000 tokenです。一回のActive Viewは262,144 contextから
32,768 output reserveと4,096 safety marginを引いた最大225,280 tokenであり、20M全体を一度に
attentionへ載せる意味ではありません。qwen-worker-qualityのsnapshot上限は512 GiB、filesystem
free floorは256 GiBです。snapshot modeはreleaseのconformance認証がある場合だけ公開します。
snapshotは64 MiB chunk CRC32Cで偶発破損をrestore前に検出し、破損時は隔離してsource rebuildへ
戻ります。daemon起動時はmanifestだけを読み、本文は使用時に一度検証します。認定範囲は保存prefixに
未見suffixを加えるsession continuationであり、短いpromptへの巻戻しや任意KV block連結ではありません。

7日間soakはKV:memの受入条件ではありません。利用者試用中は次を確認し、異常時はsnapshot kill switchから
先に停止します。

```bash
curl -sS http://127.0.0.1:9810/v1/context-status \
  -H "Authorization: Bearer ${LARM_API_TOKEN}" | jq

# snapshotだけを停止する場合
# systemd overrideまたはunit設定で LARM_CONTEXT_SNAPSHOT_ENABLED=false としてdaemonをrestart
# Managed Context全体を停止する場合は LARM_CONTEXT_ENABLED=false
```

CRC拒否、identity drift、source rebuild fallback、quota、filesystem free floor、daemonの
release/config/boot identityを観測します。KV:memのGo条件とconsumer分離は
[`../../specs/saaa-qwen38-kv-mem-routing.html`](../../specs/saaa-qwen38-kv-mem-routing.html)を参照してください。

隔離Qwen workerでM3bを再実行する場合は、専用の絶対slot rootを指定して次を実行します。

```bash
LARM_CONTEXT_SPIKE_ENDPOINT=http://127.0.0.1:59001 \
LARM_CONTEXT_SPIKE_SLOT_SAVE_PATH=/srv/ai/context-m3b-isolated \
  bun run context:kv:conformance
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

The installer copies and enables Resident/control units but intentionally does not start or restart current units. It
stops, disables, and removes the obsolete `larm-native-qwen-provider.service` unit when present. On an
update, inspect the diff and restart only a changed service when its behavior must be applied;
do not use the first-install start command as a blanket restart. The installer always converges
`qwen-tts.service` and `larm-embedding.service` to disabled without stopping an active process.

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
