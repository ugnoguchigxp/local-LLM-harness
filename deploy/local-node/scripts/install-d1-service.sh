#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then
  echo "Administrator authentication is required to register the d1 Provider unit." >&2
  exit 1
fi
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
test -x /srv/ai/apps/d1-system-one/.venv/bin/uvicorn
test -f /srv/ai/models/d1-3b/model.safetensors
for target in /etc/systemd/system/d1-system-one.service /etc/polkit-1/rules.d/52-larm-d1-runtime-control.rules; do
  if [[ -L "${target}" || ( -e "${target}" && ! -f "${target}" ) ]]; then
    echo "Refusing unsafe installation target: ${target}" >&2
    exit 1
  fi
done
install -o root -g root -m 0644 "${source_root}/deploy/local-node/systemd/d1-system-one.service" /etc/systemd/system/d1-system-one.service
install -o root -g root -m 0644 "${source_root}/deploy/local-node/polkit/52-larm-d1-runtime-control.rules" /etc/polkit-1/rules.d/52-larm-d1-runtime-control.rules
systemctl daemon-reload
echo "d1 unit registered; LARM starts it when the explicit game profile is requested."
