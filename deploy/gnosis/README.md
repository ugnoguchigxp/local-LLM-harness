# gnosis deployment

This directory is the reproducible Linux deployment for the `gnosis` AI MAX+ 395 node.
It contains metadata and launch configuration only. Model weights, virtual environments,
build trees, caches, generated audio, and logs stay outside Git under `/srv/ai`.

## Layout

- `models.yaml`: registered artifact source and absolute runtime placement, never model data
- `releases.yaml`: immutable Runtime-to-artifact release catalog
- `sources.lock.yaml`: external runtime source/release pins, never built binaries
- `systemd/`: the units installed on gnosis
- `polkit/`: LARMにPreferred providerだけのstart / stopを許可する最小権限rule
- `scripts/prepare-host.sh`: conservative host prerequisites; no reboot and no UFW enable
- `scripts/install-services.sh`: unitをinstallし、Resident/controlだけをenableする（restartなし）
- `scripts/preflight-larm.sh`: secretを含めないread-only commissioning inventory
- `scripts/release-larm.sh`: clean commitのversioned apply、rollback、review済みbounded retention
- `scripts/verify.sh`: GPU, service, HTTP health, and memory checks
- `scripts/smoke-larm.sh`: Resident 27B固定のAllocation、stream、release smoke
- `scripts/smoke-voice.sh`: operator提供音声によるSTT・通常TTS smoke
- `scripts/canary-gate.sh`: boot epoch固定と反復canary gate
- `scripts/shadow-larm.sh`: 推論せずlegacyとv1のroute・Runtime・endpointを比較
- `scripts/fault-larm.sh`: 明示confirmationを要求するdaemon・Preferred fault harness
- `scripts/benchmark-larm.ts`: repository外raw JSONと匿名化summaryを作るResident benchmark

Runtime-manager configuration is in [`../../config/gnosis`](../../config/gnosis).
Application-owned adapters are in [`../../apps`](../../apps).

LARM artifact operations use `/srv/ai/models/.larm-staging` and
`/srv/ai/models/.larm-rollback` for model data, and `/var/lib/larm` for operation
journals. `prepare-host.sh` creates these paths for the operator. The repository
continues to contain metadata only.

Checksummed single files and exact directory snapshots are eligible for unattended staging.
A snapshot fixes a sorted file list, per-file size and SHA-256, total size, file limit, and
canonical snapshot digest. Unlisted files, links, and unsafe paths are rejected. Resident runtime
activation remains an attended operation; Qwen TTS is the first Preferred snapshot activation target.
The installer creates `/etc/larm/larm.env` with a local management token when it
does not already exist. It never overwrites an existing credential.
`qwen-tts.service`はinstallのみ行い、boot時はdisableのままです。LARMは同梱の
polkit ruleにより、このPreferred serviceのstart / stopだけを無人実行できます。

## Apply

Before overwriting an existing daemon unit, keep an operator-owned backup outside the repository:

```bash
backup_dir="/var/lib/larm/operator-backups/$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 0700 "${backup_dir}"
if sudo test -f /etc/systemd/system/larm-daemon.service; then
  sudo cp --preserve=mode,ownership,timestamps \
    /etc/systemd/system/larm-daemon.service "${backup_dir}/"
fi
sudo systemctl cat larm-daemon.service >"/tmp/larm-daemon.before.txt" || true
```

`prepare-host.sh` installs packages, masks sleep targets, adds the service account to the GPU
groups, creates data directories, and stages UFW rules. It does not enable UFW, configure
ROCm/TTM, or reboot. Run it only after reviewing those host-level changes.

```bash
cd /srv/ai/apps/local-LLM-harness
# Host preparation, only when required:
# sudo deploy/gnosis/scripts/prepare-host.sh
sudo deploy/gnosis/scripts/install-services.sh
deploy/gnosis/scripts/release-larm.sh plan
sudo deploy/gnosis/scripts/release-larm.sh apply
sudo systemctl start llama-server.service llama-swap-worker.service \
  qwen-asr.service voicevox-tts.service larm-daemon.service  # first install only
deploy/gnosis/scripts/verify.sh
deploy/gnosis/scripts/smoke-larm.sh
# LARM_CANARY_AUDIO_FILE=/path/to/non-sensitive.wav deploy/gnosis/scripts/smoke-voice.sh
deploy/gnosis/scripts/canary-gate.sh
```

`plan`の`cleanupCandidates`が空でない場合は、候補と`cleanupConfirm`をreviewしてから次のように
同じcommitへapplyします。digestが一致しなければ、削除も切替も行いません。

```bash
plan_json="$(deploy/gnosis/scripts/release-larm.sh plan)"
cleanup_confirm="$(jq -r '.cleanupConfirm // empty' <<<"${plan_json}")"
sudo env LARM_RELEASE_CLEANUP_CONFIRM="${cleanup_confirm}" \
  deploy/gnosis/scripts/release-larm.sh apply
```

The installer copies and enables units but intentionally does not start or restart them. On an
update, inspect the diff and restart only a changed service when its behavior must be applied;
do not use the first-install start command as a blanket restart. The installer always converges
`qwen-tts.service` to disabled without stopping an active process.

`larm-daemon.service`はGit worktreeではなく`/srv/ai/apps/larm-current`を参照します。
`release-larm.sh apply`はclean commitをrepository外へ展開し、frozen installと全gateを通過した後だけ
current symlinkを原子的に切り替え、LARM daemonだけをrestartします。manifestにはcommit、LARM・Bun
version、lockfile digest、config revision、作成時刻を保存します。前世代へ戻す操作は次の通りです。

```bash
sudo deploy/gnosis/scripts/release-larm.sh rollback
```

保持数を超えた世代は`plan`で候補を確認し、その`cleanupConfirm`を
`LARM_RELEASE_CLEANUP_CONFIRM`へ明示した`apply`だけが削除します。削除は新世代のidentityとreadinessを
確認した後に行い、health失敗時はcurrentとrollback pointerの両方を復元します。単独の`cleanup`も
実行時に表示するdigestとの一致が必要です。credential、model、journalはrelease directory外にあり、
upgradeとrollbackで保持されます。dirty source、symlink root、並行mutation、gate失敗はcurrent切替前に
拒否します。

Artifact stage and activation are asynchronous. A Runtime with multiple artifacts requires all
of them to reach `succeeded` staging operations before activation. The complete polling example
is in [`../../apps/daemon/README.md`](../../apps/daemon/README.md).

推論trafficを切り替えないshadow比較と、明示confirmation付きfault matrixは次の順で実行します。

```bash
deploy/gnosis/scripts/shadow-larm.sh
deploy/gnosis/scripts/fault-larm.sh plan
# Reviewして対象を選んだ後だけ:
# sudo env LARM_FAULT_CONFIRM=gnosis-attended deploy/gnosis/scripts/fault-larm.sh daemon-restart
```

Do not reboot this dual-boot host as part of deployment automation. A reboot can select
Windows and make the node unavailable. Reboot only as an explicit, attended operation.

## Roll back LARM without touching Resident providers

```bash
sudo deploy/gnosis/scripts/release-larm.sh rollback
systemctl is-active llama-server.service qwen-asr.service voicevox-tts.service
```

This rollback does not remove `/etc/larm/larm.env`, artifact staging data, journals, or any model.
The existing direct Provider ports remain available. Removing a first-install unit or artifact data
is a separate destructive operator decision and is not part of the rollback command above.

After a successful canary, save aggregate timing, memory, error, queue, config revision, and boot
epoch in a new Spec HTML document. Do not commit prompts, transcripts, audio, credentials, raw model
data, or unredacted logs.
