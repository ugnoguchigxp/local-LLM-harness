#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
base_url="${LARM_BASE_URL:-http://127.0.0.1:9810}"
credential="${LARM_CREDENTIAL_PATH:-/etc/larm/larm.env}"
installed_unit="${LARM_INSTALLED_UNIT:-/etc/systemd/system/larm-daemon.service}"

commit="$(git -C "${repo_root}" rev-parse HEAD)"
candidate_revision="$(cd "${repo_root}" && bun run apps/daemon/src/print-config-revision.ts 2>/dev/null || true)"
dirty=false
[[ -z "$(git -C "${repo_root}" status --porcelain=v1 --untracked-files=normal)" ]] || dirty=true
health='null'
if health_value="$(curl -fsS --max-time 3 "${base_url}/health" 2>/dev/null)"; then
  health="${health_value}"
fi
credential_type="missing"
credential_mode=""
credential_owner=""
if [[ -L "${credential}" ]]; then
  credential_type="symlink"
elif [[ -f "${credential}" ]]; then
  credential_type="regular"
  credential_mode="$(stat -c '%a' -- "${credential}")"
  credential_owner="$(stat -c '%U:%G' -- "${credential}")"
elif [[ -e "${credential}" ]]; then
  credential_type="other"
fi
unit_match=false
if [[ -f "${installed_unit}" ]] && cmp -s "${repo_root}/deploy/gnosis/systemd/larm-daemon.service" "${installed_unit}"; then
  unit_match=true
fi
service_load="$(systemctl show larm-daemon.service -p LoadState --value 2>/dev/null || true)"
service_active="$(systemctl is-active larm-daemon.service 2>/dev/null || true)"
service_enabled="$(systemctl is-enabled larm-daemon.service 2>/dev/null || true)"
port_owner="$(ss -H -ltnp 'sport = :9810' 2>/dev/null | head -n 1 || true)"
disk_available_bytes="$(df --output=avail -B1 /srv/ai 2>/dev/null | tail -n 1 | tr -d ' ' || printf '0')"

jq -n \
  --arg timestamp "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
  --arg commit "${commit}" \
  --arg candidateConfigRevision "${candidate_revision}" \
  --argjson dirty "${dirty}" \
  --argjson health "${health}" \
  --arg credentialType "${credential_type}" \
  --arg credentialMode "${credential_mode}" \
  --arg credentialOwner "${credential_owner}" \
  --argjson unitMatch "${unit_match}" \
  --arg load "${service_load:-unknown}" \
  --arg active "${service_active:-unknown}" \
  --arg enabled "${service_enabled:-unknown}" \
  --arg portOwner "${port_owner}" \
  --argjson diskAvailableBytes "${disk_available_bytes:-0}" \
  '{timestamp:$timestamp,commit:$commit,candidateConfigRevision:$candidateConfigRevision,dirty:$dirty,daemonHealth:$health,
    credential:{type:$credentialType,mode:$credentialMode,owner:$credentialOwner},
    unit:{matchesRepository:$unitMatch,load:$load,active:$active,enabled:$enabled},
    listener:{port:9810,description:$portOwner},disk:{path:"/srv/ai",availableBytes:$diskAvailableBytes}}'
