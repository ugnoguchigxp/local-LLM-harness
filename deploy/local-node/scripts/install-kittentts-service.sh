#!/usr/bin/env bash
set -euo pipefail
# Incremental registration; activation through a verified LARM release follows.
if [[ "${EUID}" -ne 0 ]]; then
  echo "Administrator authentication is required to register the KittenTTS Provider unit." >&2
  exit 1
fi
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
test -x /srv/ai/apps/kittentts-runtime/.venv/bin/uvicorn
test -f /srv/ai/models/kittentts/fp32/kitten_tts_nano_v0_8.onnx
test -f /srv/ai/models/kittentts/fp32/config.json
test -f /srv/ai/models/kittentts/fp32/voices.npz
for target in /etc/systemd/system/kittentts-tts.service /etc/polkit-1/rules.d/52-larm-kittentts-runtime-control.rules; do
  if [[ -L "${target}" || ( -e "${target}" && ! -f "${target}" ) ]]; then
    echo "Refusing unsafe installation target: ${target}" >&2
    exit 1
  fi
done
install -o root -g root -m 0644 "${source_root}/deploy/local-node/systemd/kittentts-tts.service" /etc/systemd/system/kittentts-tts.service
install -o root -g root -m 0644 "${source_root}/deploy/local-node/polkit/52-larm-kittentts-runtime-control.rules" /etc/polkit-1/rules.d/52-larm-kittentts-runtime-control.rules
systemctl daemon-reload
echo "KittenTTS unit registered. LARM will start its warm instance after release activation."
