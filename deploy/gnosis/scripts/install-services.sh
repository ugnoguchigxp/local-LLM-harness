#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
unit_source="${repo_root}/deploy/gnosis/systemd"
unit_target="/etc/systemd/system"

units=(
  llama-server.service
  llama-swap-worker.service
  qwen-asr.service
  qwen-tts.service
  voicevox-tts.service
)

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

for unit in "${units[@]}"; do
  install -o root -g root -m 0644 "${unit_source}/${unit}" "${unit_target}/${unit}"
done

systemctl daemon-reload
systemctl enable "${units[@]}"

echo "Units installed and enabled. This script intentionally does not reboot or restart services."
echo "Apply a changed unit explicitly, for example: systemctl restart llama-swap-worker.service"
