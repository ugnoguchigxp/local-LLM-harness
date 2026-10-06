#!/usr/bin/env bash
set -euo pipefail
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ "$(id -u)" != 0 ]]; then
  echo "run this media service installer from an administrator terminal" >&2
  exit 1
fi
# Existing workloads must finish before replacing worker configuration.
for service in larm-image-qwen21.service larm-music-ace-step.service; do
  if systemctl is-active --quiet "${service}"; then
    echo "${service} is active; wait for its request to finish before installation" >&2
    exit 1
  fi
done
for service in larm-image-qwen21.service larm-music-ace-step.service; do
  install -m 0644 "${source_root}/deploy/local-node/systemd/${service}" "/etc/systemd/system/${service}"
done
install -m 0644 "${source_root}/deploy/local-node/polkit/60-larm-media-control.rules" /etc/polkit-1/rules.d/60-larm-media-control.rules
systemctl daemon-reload
systemctl disable larm-image-qwen21.service larm-music-ace-step.service
printf '%s\n' 'Media workers installed for demand-only start/stop; no model was started.'
