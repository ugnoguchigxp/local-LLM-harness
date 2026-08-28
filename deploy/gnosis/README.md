# gnosis deployment

This directory is the reproducible Linux deployment for the `gnosis` AI MAX+ 395 node.
It contains metadata and launch configuration only. Model weights, virtual environments,
build trees, caches, generated audio, and logs stay outside Git under `/srv/ai`.

## Layout

- `models.yaml`: registered artifact source and absolute runtime placement, never model data
- `sources.lock.yaml`: external runtime source/release pins, never built binaries
- `systemd/`: the units installed on gnosis
- `polkit/`: LARMにPreferred providerだけのstart / stopを許可する最小権限rule
- `scripts/prepare-host.sh`: conservative host prerequisites; no reboot and no UFW enable
- `scripts/install-services.sh`: unitをinstallし、Resident/controlだけをenableする（restartなし）
- `scripts/verify.sh`: GPU, service, HTTP health, and memory checks
- `scripts/smoke-larm.sh`: Resident 27B固定のAllocation、stream、release smoke
- `scripts/smoke-voice.sh`: operator提供音声によるSTT・通常TTS smoke
- `scripts/canary-gate.sh`: boot epoch固定と反復canary gate

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
sudo systemctl start llama-server.service llama-swap-worker.service \
  qwen-asr.service voicevox-tts.service larm-daemon.service  # first install only
deploy/gnosis/scripts/verify.sh
deploy/gnosis/scripts/smoke-larm.sh
# LARM_CANARY_AUDIO_FILE=/path/to/non-sensitive.wav deploy/gnosis/scripts/smoke-voice.sh
deploy/gnosis/scripts/canary-gate.sh
```

The installer copies and enables units but intentionally does not start or restart them. On an
update, inspect the diff and restart only a changed service when its behavior must be applied;
do not use the first-install start command as a blanket restart. The installer always converges
`qwen-tts.service` to disabled without stopping an active process.

Artifact stage and activation are asynchronous. A Runtime with multiple artifacts requires all
of them to reach `succeeded` staging operations before activation. The complete polling example
is in [`../../apps/daemon/README.md`](../../apps/daemon/README.md).

Do not reboot this dual-boot host as part of deployment automation. A reboot can select
Windows and make the node unavailable. Reboot only as an explicit, attended operation.

## Roll back LARM without touching Resident providers

```bash
sudo systemctl disable --now larm-daemon.service
# If a previous unit was backed up, restore that exact file and run daemon-reload.
# If this was the first LARM install, leaving the disabled unit installed is sufficient.
sudo systemctl daemon-reload
systemctl is-active llama-server.service qwen-asr.service voicevox-tts.service
```

This rollback does not remove `/etc/larm/larm.env`, artifact staging data, journals, or any model.
The existing direct Provider ports remain available. Removing a first-install unit or artifact data
is a separate destructive operator decision and is not part of the rollback command above.

After a successful canary, save aggregate timing, memory, error, queue, config revision, and boot
epoch in a new Spec HTML document. Do not commit prompts, transcripts, audio, credentials, raw model
data, or unredacted logs.
