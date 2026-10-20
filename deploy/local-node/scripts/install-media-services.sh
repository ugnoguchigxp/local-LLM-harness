#!/usr/bin/env bash
set -euo pipefail
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ "$(id -u)" != 0 ]]; then
  echo "run this media service installer from an administrator terminal" >&2
  exit 1
fi
# Preparation is a separate unprivileged verification; fail before installing units.
[[ -d /srv/ai/data/generated/3d/work && -f /srv/ai/apps/trellis-cpp-v0.8.1-vulkan/model-viewer-4.1.0.min.js ]] || {
  echo "run prepare-mesh-storage.py as the LARM user first" >&2; exit 1;
}
# Existing workloads must finish before replacing worker configuration.
for service in larm-image-qwen21.service larm-music-ace-step.service larm-mesh-trellis2.service larm-audio-stable.service; do
  if systemctl is-active --quiet "${service}"; then
    echo "${service} is active; wait for its request to finish before installation" >&2
    exit 1
  fi
done
for service in larm-image-qwen21.service larm-music-ace-step.service larm-mesh-trellis2.service larm-audio-stable.service; do
  install -m 0644 "${source_root}/deploy/local-node/systemd/${service}" "/etc/systemd/system/${service}"
done
install -m 0644 "${source_root}/deploy/local-node/polkit/60-larm-media-control.rules" /etc/polkit-1/rules.d/60-larm-media-control.rules
install -d -m 0755 /etc/systemd/system/larm-daemon.service.d
cat >/etc/systemd/system/larm-daemon.service.d/30-mesh-storage.conf <<'CONF'
[Service]
ReadWritePaths=/srv/ai/data/generated/3d
CONF
systemctl daemon-reload
systemctl disable larm-image-qwen21.service larm-music-ace-step.service larm-mesh-trellis2.service larm-audio-stable.service
printf '%s\n' 'Media workers installed for demand-only start/stop; no model was started.'
