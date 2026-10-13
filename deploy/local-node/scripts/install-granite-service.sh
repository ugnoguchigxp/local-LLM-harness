#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Service registration requires administrator authentication.' >&2; exit 1; }
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
test -x /srv/ai/apps/granite-asr-runtime/.venv/bin/uvicorn
test -f /srv/ai/apps/granite-asr-runtime/transcribe.cpp/build-vulkan/src/libtranscribe.so
test -f /srv/ai/models/granite-asr/granite-speech-4.1-2b-Q8_0.gguf
for target in /etc/systemd/system/granite-asr.service /etc/polkit-1/rules.d/53-larm-granite-runtime-control.rules; do
  [[ ! -L ${target} && ( ! -e ${target} || -f ${target} ) ]] || { echo "Unsafe installation target: ${target}" >&2; exit 1; }
done
install -o root -g root -m 0644 "${source_root}/deploy/local-node/systemd/granite-asr.service" /etc/systemd/system/granite-asr.service
install -o root -g root -m 0644 "${source_root}/deploy/local-node/polkit/53-larm-granite-runtime-control.rules" /etc/polkit-1/rules.d/53-larm-granite-runtime-control.rules
systemctl daemon-reload
systemctl disable granite-asr.service
echo 'Granite registered for LARM-managed lifecycle; activate the verified release next.'
