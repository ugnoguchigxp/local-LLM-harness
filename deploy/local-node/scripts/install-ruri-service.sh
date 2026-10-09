#!/usr/bin/env bash
set -euo pipefail
# Incremental installation only: no other Provider, credential or release changes.
if [[ "${EUID}" -ne 0 ]]; then
  echo "Administrator authentication is required to register the new Ruri Provider unit." >&2
  exit 1
fi
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
test -x /srv/ai/apps/ruri-system-one/.venv/bin/uvicorn
test -f /srv/ai/models/ruri-speaking-attitude-v1/model.onnx
test -f /srv/ai/models/ruri-speaking-attitude-v1/head.json
test -f /srv/ai/models/ruri-speaking-attitude-v1/calibration.json
for target in /etc/systemd/system/ruri-system-one.service /etc/polkit-1/rules.d/51-larm-ruri-runtime-control.rules; do
  if [[ -L "${target}" || ( -e "${target}" && ! -f "${target}" ) ]]; then
    echo "Refusing unsafe installation target: ${target}" >&2
    exit 1
  fi
done
install -o root -g root -m 0644 "${source_root}/deploy/local-node/systemd/ruri-system-one.service" /etc/systemd/system/ruri-system-one.service
install -o root -g root -m 0644 "${source_root}/deploy/local-node/polkit/51-larm-ruri-runtime-control.rules" /etc/polkit-1/rules.d/51-larm-ruri-runtime-control.rules
systemctl daemon-reload
echo "Ruri unit registered. It remains disabled and will be started by LARM after the verified release is activated."
