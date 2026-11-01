#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this installer as the LARM daemon user." >&2
  exit 1
fi
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
config_root="${XDG_CONFIG_HOME:-${HOME}/.config}"
unit_dir="${config_root}/systemd/user"
target="${unit_dir}/audio8-tts.service"
test -x /srv/ai/apps/audio8-tts-runtime/.venv/bin/python
test -f /srv/ai/models/Edge0/Audio8-TTS-Realistic-0.6b/model.safetensors
test -f /srv/ai/models/Edge0/audio8-ja-voices-v2/manifest.json
if [[ -L "${target}" || ( -e "${target}" && ! -f "${target}" ) ]]; then
  echo "Refusing unsafe installation target: ${target}" >&2
  exit 1
fi
if systemctl --user is-active --quiet audio8-tts.service; then
  echo "Stop Audio8 through LARM before updating its user unit." >&2
  exit 1
fi
mkdir -p "${unit_dir}"
if [[ -f "${target}" ]] && ! cmp -s "${target}" "${source_root}/deploy/local-node/systemd/user/audio8-tts.service"; then
  backup_root="/srv/ai/apps/audio8-tts-runtime/unit-backups"
  mkdir -p "${backup_root}"
  backup="$(mktemp "${backup_root}/audio8-tts.XXXXXX.service")"
  cp -p -- "${target}" "${backup}"
fi
staged="$(mktemp "${unit_dir}/.audio8-tts.XXXXXX")"
trap 'rm -f -- "${staged}"' EXIT
install -m 0644 "${source_root}/deploy/local-node/systemd/user/audio8-tts.service" "${staged}"
mv -fT -- "${staged}" "${target}"
trap - EXIT
systemctl --user daemon-reload
echo "Audio8 user unit registered without enabling or starting it. LARM manages its lifecycle."
