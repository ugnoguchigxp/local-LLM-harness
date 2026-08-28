# gnosis deployment

This directory is the reproducible Linux deployment for the `gnosis` AI MAX+ 395 node.
It contains metadata and launch configuration only. Model weights, virtual environments,
build trees, caches, generated audio, and logs stay outside Git under `/srv/ai`.

## Layout

- `models.yaml`: model source and absolute runtime placement, never model data
- `sources.lock.yaml`: external runtime source/release pins, never built binaries
- `systemd/`: the units installed on gnosis
- `polkit/`: LARMにPreferred providerだけのstart / stopを許可する最小権限rule
- `scripts/prepare-host.sh`: conservative host prerequisites; no reboot and no UFW enable
- `scripts/install-services.sh`: unitをinstallし、Resident/controlだけをenableする（restartなし）
- `scripts/verify.sh`: GPU, service, HTTP health, and memory checks

Runtime-manager configuration is in [`../../config/gnosis`](../../config/gnosis).
Application-owned adapters are in [`../../apps`](../../apps).

LARM artifact operations use `/srv/ai/models/.larm-staging` and
`/srv/ai/models/.larm-rollback` for model data, and `/var/lib/larm` for operation
journals. `prepare-host.sh` creates these paths for the operator. The repository
continues to contain metadata only.

Only checksummed single-file artifacts are eligible for unattended staging.
Directory models and Resident runtime activation remain attended operations.
The installer creates `/etc/larm/larm.env` with a local management token when it
does not already exist. It never overwrites an existing credential.
`qwen-tts.service`はinstallのみ行い、boot時はdisableのままです。LARMは同梱の
polkit ruleにより、このPreferred serviceのstart / stopだけを無人実行できます。

## Apply

```bash
cd /srv/ai/apps/local-LLM-harness
sudo deploy/gnosis/scripts/install-services.sh
sudo systemctl start llama-server.service llama-swap-worker.service \
  qwen-asr.service voicevox-tts.service larm-daemon.service  # first install only
sudo systemctl restart llama-swap-worker.service  # only when its unit/config changed
deploy/gnosis/scripts/verify.sh
```

Do not reboot this dual-boot host as part of deployment automation. A reboot can select
Windows and make the node unavailable. Reboot only as an explicit, attended operation.
