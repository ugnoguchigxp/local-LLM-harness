# gnosis deployment

This directory is the reproducible Linux deployment for the `gnosis` AI MAX+ 395 node.
It contains metadata and launch configuration only. Model weights, virtual environments,
build trees, caches, generated audio, and logs stay outside Git under `/srv/ai`.

## Layout

- `models.yaml`: model source and absolute runtime placement, never model data
- `systemd/`: the units installed on gnosis
- `scripts/prepare-host.sh`: conservative host prerequisites; no reboot and no UFW enable
- `scripts/install-services.sh`: install and enable units without restarting them
- `scripts/verify.sh`: GPU, service, HTTP health, and memory checks

Runtime-manager configuration is in [`../../config/gnosis`](../../config/gnosis).
Application-owned adapters are in [`../../apps`](../../apps).

## Apply

```bash
cd /srv/ai/apps/local-LLM-harness
sudo deploy/gnosis/scripts/install-services.sh
sudo systemctl restart llama-swap-worker.service  # only when its unit/config changed
deploy/gnosis/scripts/verify.sh
```

Do not reboot this dual-boot host as part of deployment automation. A reboot can select
Windows and make the node unavailable. Reboot only as an explicit, attended operation.
