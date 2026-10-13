#!/usr/bin/env bash
set -euo pipefail
root=/srv/ai/apps/larm-ornith-strix-profile
dropin=/etc/systemd/system/larm-daemon.service.d/99-ornith-strix-profile.conf
provider_config=/var/lib/larm/provider-config/llama-swap.yaml
action="${1:-}"
[[ ${EUID} -eq 0 ]] || { echo 'Profile activation requires administrator authentication.' >&2; exit 1; }
[[ ${action} == apply || ${action} == restore ]] || { echo 'usage: activate.sh apply|restore' >&2; exit 2; }
[[ -f ${root}/prepared.json && ! -L ${root}/prepared.json ]] || exit 1
[[ $(readlink -f /srv/ai/apps/larm-current) == "$(jq -er .activeRelease "${root}/prepared.json")" ]] \
  || { echo 'Active release changed; prepare against its current configuration.' >&2; exit 1; }
check_hashes() {
  local path digest
  while IFS=$'\t' read -r path digest; do
    [[ -f ${path} && ! -L ${path} && $(sha256sum -- "${path}" | cut -d ' ' -f1) == "${digest}" ]] \
      || { echo "Configuration changed: ${path}" >&2; return 1; }
  done < <(jq -r "$1 | to_entries[] | [.key,.value] | @tsv" "${root}/prepared.json")
}
publish() {
  local temp
  [[ ! -L ${provider_config} ]] || return 1
  temp="$(mktemp /var/lib/larm/provider-config/.ornith-strix.XXXXXX)"
  install -o root -g root -m 0644 -- "$1" "${temp}"
  mv -fT -- "${temp}" "${provider_config}"
}
restore_previous() {
  rm -f -- "${dropin}"
  publish "${root}/llama-swap.previous.yaml"
  systemctl daemon-reload
  systemctl restart larm-daemon.service
}
if [[ ${action} == restore ]]; then
  [[ -f ${dropin} && ! -L ${dropin} ]] && cmp -s "${root}/99-ornith-strix-profile.conf" "${dropin}" \
    || { echo 'Expected profile override is absent or changed.' >&2; exit 1; }
  cmp -s "${root}/config/llama-swap.yaml" "${provider_config}" \
    || { echo 'Provider configuration changed since activation; refusing to overwrite it.' >&2; exit 1; }
  check_hashes '.stagedFiles'
  restore_previous
  echo 'Previous profiles restored, including the Granite ASR override.'
  exit 0
fi
[[ ! -e ${dropin} && ! -L ${dropin} ]] || { echo 'Profile override already exists.' >&2; exit 1; }
check_hashes '.baselineFiles'
check_hashes '.stagedFiles'
# The connection request schema also needs the new explicit selector. Deploy the
# updated LARM source first; a configuration-only reload of older code will fail.
rg -q '"ornith1\.5Strix"' /srv/ai/apps/larm-current/packages/core/src/agent-connection.ts \
  || { echo 'Deploy LARM with the ornith1.5Strix selector before activating this snapshot.' >&2; exit 1; }
# Only activate a configuration already tested with this exact context and slot count.
jq -e '.completed == true' /srv/ai/evidence/ornith-three-trial-20261012/strix-profile-run/strix-profile/status.json >/dev/null
[[ $(sha256sum /srv/ai/models/ornith-trial-20261012/strix-lean/Ornith-1.5-35B-ROCmFP4-STRIX_LEAN.gguf | cut -d ' ' -f1) == aa35045aab39163851c8584e6cf8cc6f33e8fc2ffe28ca627d3414ec66584704 ]] \
  || { echo 'STRIX_LEAN artifact changed.' >&2; exit 1; }
install -o root -g root -m 0644 "${root}/99-ornith-strix-profile.conf" "${dropin}"
if ! publish "${root}/config/llama-swap.yaml" || ! systemctl daemon-reload \
  || ! systemctl restart larm-daemon.service \
  || ! runuser -u ugnoguchi -- /home/ugnoguchi/.bun/bin/bun "${root}/smoke.ts"; then
  restore_previous
  echo 'Activation failed; previous configuration restored.' >&2
  exit 1
fi
echo 'ornith1.5Strix is available. Existing clients reconnect after the daemon restart.'
