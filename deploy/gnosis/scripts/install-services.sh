#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
unit_source="${repo_root}/deploy/gnosis/systemd"
unit_target="/etc/systemd/system"
operator="ugnoguchi"

units=(
  llama-server.service
  llama-swap-worker.service
  qwen-asr.service
  qwen-tts.service
  voicevox-tts.service
  larm-daemon.service
)

enabled_units=(
  llama-server.service
  llama-swap-worker.service
  qwen-asr.service
  voicevox-tts.service
  larm-daemon.service
)

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

if ! id "${operator}" >/dev/null 2>&1; then
  echo "Required service account does not exist: ${operator}" >&2
  exit 1
fi

install -d -o "${operator}" -g "${operator}" \
  /srv/ai/models/qwen38-worker \
  /srv/ai/models/.larm-staging \
  /srv/ai/models/.larm-rollback \
  /var/lib/larm

for unit in "${units[@]}"; do
  install -o root -g root -m 0644 "${unit_source}/${unit}" "${unit_target}/${unit}"
done

install -d -o root -g root -m 0755 /etc/polkit-1/rules.d
install -o root -g root -m 0644 \
  "${repo_root}/deploy/gnosis/polkit/50-larm-runtime-control.rules" \
  /etc/polkit-1/rules.d/50-larm-runtime-control.rules

install -d -o root -g "${operator}" -m 0750 /etc/larm
if [[ -L /etc/larm/larm.env ]]; then
  echo "Refusing symlinked credential file: /etc/larm/larm.env" >&2
  exit 1
fi
if [[ ! -e /etc/larm/larm.env ]]; then
  management_token="$(openssl rand -hex 32)"
  umask 0077
  printf 'LARM_MANAGEMENT_TOKEN=%s\n' "${management_token}" >/etc/larm/larm.env
elif [[ ! -f /etc/larm/larm.env ]]; then
  echo "Credential path is not a regular file: /etc/larm/larm.env" >&2
  exit 1
fi
chown root:"${operator}" /etc/larm/larm.env
chmod 0640 /etc/larm/larm.env

systemctl daemon-reload
systemctl enable "${enabled_units[@]}"
systemctl disable qwen-tts.service

echo "Resident/control units enabled; preferred qwen-tts.service left disabled for on-demand use."
echo "This script intentionally does not reboot or restart services."
echo "Apply a changed unit explicitly, for example: systemctl restart llama-swap-worker.service"
echo "LARM management credentials are stored in /etc/larm/larm.env."
