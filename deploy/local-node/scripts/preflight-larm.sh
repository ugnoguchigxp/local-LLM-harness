#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
base_url="${LARM_BASE_URL:-http://127.0.0.1:9810}"
credential="${LARM_CREDENTIAL_PATH:-/etc/larm/larm.env}"
installed_unit="${LARM_INSTALLED_UNIT:-/etc/systemd/system/larm-daemon.service}"
external_verifier="${repo_root}/deploy/local-node/scripts/verify-external-assets.ts"
repository_polkit="${repo_root}/deploy/local-node/polkit/50-larm-runtime-control.rules"
installed_polkit="/etc/polkit-1/rules.d/50-larm-runtime-control.rules"
provider_specs=(
  llama-server.service:8080
  qwen-asr.service:8081
  whisper-asr.service:8085
  qwen-tts.service:8082
  llama-swap-worker.service:8083
  voicevox-tts.service:8084
)

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
unit_type="missing"
unit_digest=""
if [[ -L "${installed_unit}" ]]; then
  unit_type="symlink"
elif [[ -f "${installed_unit}" ]]; then
  unit_type="regular"
  unit_digest="$(sha256sum "${installed_unit}" | awk '{print $1}')"
elif [[ -e "${installed_unit}" ]]; then
  unit_type="other"
fi
repository_unit_digest="$(sha256sum "${repo_root}/deploy/local-node/systemd/larm-daemon.service" | awk '{print $1}')"
unit_match=false
if [[ "${unit_type}" == "regular" && "${unit_digest}" == "${repository_unit_digest}" ]]; then
  unit_match=true
fi
polkit_type="missing"
polkit_digest=""
if [[ -L "${installed_polkit}" ]]; then
  polkit_type="symlink"
elif [[ -f "${installed_polkit}" ]]; then
  polkit_type="regular"
  polkit_digest="$(sha256sum "${installed_polkit}" | awk '{print $1}')"
elif [[ -e "${installed_polkit}" ]]; then
  polkit_type="other"
fi
repository_polkit_digest="$(sha256sum "${repository_polkit}" | awk '{print $1}')"
polkit_match=false
if [[ "${polkit_type}" == "regular" && "${polkit_digest}" == "${repository_polkit_digest}" ]]; then
  polkit_match=true
fi
service_load="$(systemctl show larm-daemon.service -p LoadState --value 2>/dev/null || true)"
service_active="$(systemctl is-active larm-daemon.service 2>/dev/null || true)"
service_enabled="$(systemctl is-enabled larm-daemon.service 2>/dev/null || true)"
port_owner="$(ss -H -ltnp 'sport = :9810' 2>/dev/null | head -n 1 || true)"
native_stream_listener="$(ss -H -ltnp 'sport = :8090' 2>/dev/null | head -n 1 || true)"
disk_available_bytes="$(df --output=avail -B1 /srv/ai 2>/dev/null | tail -n 1 | tr -d ' ' || printf '0')"
provider_units='[]'
for spec in "${provider_specs[@]}"; do
  unit="${spec%%:*}"
  port="${spec##*:}"
  repository_unit="${repo_root}/deploy/local-node/systemd/${unit}"
  installed_provider_unit="/etc/systemd/system/${unit}"
  repository_digest="$(sha256sum "${repository_unit}" | awk '{print $1}')"
  installed_digest=""
  installed_type="missing"
  if [[ -L "${installed_provider_unit}" ]]; then
    installed_type="symlink"
  elif [[ -f "${installed_provider_unit}" ]]; then
    installed_type="regular"
    installed_digest="$(sha256sum "${installed_provider_unit}" | awk '{print $1}')"
  elif [[ -e "${installed_provider_unit}" ]]; then
    installed_type="other"
  fi
  provider_active="$(systemctl is-active "${unit}" 2>/dev/null || true)"
  provider_enabled="$(systemctl is-enabled "${unit}" 2>/dev/null || true)"
  provider_listener="$(ss -H -ltn "sport = :${port}" 2>/dev/null | head -n 1 || true)"
  provider_units="$(jq -c \
    --arg unit "${unit}" \
    --argjson port "${port}" \
    --arg repositoryDigest "${repository_digest}" \
    --arg installedType "${installed_type}" \
    --arg installedDigest "${installed_digest}" \
    --arg active "${provider_active:-unknown}" \
    --arg enabled "${provider_enabled:-unknown}" \
    --arg listener "${provider_listener}" \
    '. + [{unit:$unit,port:$port,repositoryDigest:$repositoryDigest,
      installed:{type:$installedType,digest:$installedDigest,matchesRepository:($installedDigest != "" and $installedDigest == $repositoryDigest)},
      active:$active,enabled:$enabled,listener:$listener}]' <<<"${provider_units}")"
done

set +e
ufw_output="$(ufw status 2>&1)"
ufw_rc=$?
set -e
ufw_readable=false
ufw_status="unknown"
if [[ "${ufw_rc}" -eq 0 ]] && grep -Eq '^Status: (active|inactive)$' <<<"${ufw_output}"; then
  ufw_readable=true
  ufw_status="$(awk '/^Status:/ {print $2; exit}' <<<"${ufw_output}")"
fi
ufw_provider_rules="$(awk '$1 ~ /^(8080|8081|8082|8083|8084|8085)(\/tcp)?$/ && $0 ~ /[[:space:]]ALLOW[[:space:]]+IN[[:space:]]/ {print}' \
  <<<"${ufw_output}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
ufw_gateway_rules="$(awk '$1 ~ /^9810(\/tcp)?$/ && $0 ~ /[[:space:]]ALLOW[[:space:]]+IN[[:space:]]/ {print}' \
  <<<"${ufw_output}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
ufw_ssh_rules="$(awk '$1 ~ /^22(\/tcp)?$/ && $0 ~ /[[:space:]]ALLOW[[:space:]]+IN[[:space:]]/ {print}' \
  <<<"${ufw_output}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
external_assets="$(bun run "${external_verifier}")"

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
  --arg unitType "${unit_type}" \
  --arg unitDigest "${unit_digest}" \
  --arg repositoryUnitDigest "${repository_unit_digest}" \
  --argjson polkitMatch "${polkit_match}" \
  --arg polkitType "${polkit_type}" \
  --arg polkitDigest "${polkit_digest}" \
  --arg repositoryPolkitDigest "${repository_polkit_digest}" \
  --arg load "${service_load:-unknown}" \
  --arg active "${service_active:-unknown}" \
  --arg enabled "${service_enabled:-unknown}" \
  --arg portOwner "${port_owner}" \
  --arg nativeStreamListener "${native_stream_listener}" \
  --argjson diskAvailableBytes "${disk_available_bytes:-0}" \
  --argjson providers "${provider_units}" \
  --argjson ufwReadable "${ufw_readable}" \
  --arg ufwStatus "${ufw_status}" \
  --argjson ufwProviderRules "${ufw_provider_rules}" \
  --argjson ufwGatewayRules "${ufw_gateway_rules}" \
  --argjson ufwSshRules "${ufw_ssh_rules}" \
  --argjson externalAssets "[${external_assets}]" \
  '{timestamp:$timestamp,commit:$commit,candidateConfigRevision:$candidateConfigRevision,dirty:$dirty,daemonHealth:$health,
    credential:{type:$credentialType,mode:$credentialMode,owner:$credentialOwner},
    unit:{type:$unitType,digest:$unitDigest,repositoryDigest:$repositoryUnitDigest,
      matchesRepository:$unitMatch,load:$load,active:$active,enabled:$enabled},
    polkit:{type:$polkitType,digest:$polkitDigest,repositoryDigest:$repositoryPolkitDigest,matchesRepository:$polkitMatch},
    listener:{port:9810,description:$portOwner},
    nativeStream:{port:8090,protocol:"larm.native-llm-stream.v1",listener:$nativeStreamListener},providers:$providers,
    firewall:{readable:$ufwReadable,status:$ufwStatus,providerAllowRules:$ufwProviderRules,
      gatewayAllowRules:$ufwGatewayRules,sshAllowRules:$ufwSshRules},
    externalAssets:$externalAssets,disk:{path:"/srv/ai",availableBytes:$diskAvailableBytes}}'

[[ "$(jq -r .valid <<<"${external_assets}")" == "true" ]] || exit 1
