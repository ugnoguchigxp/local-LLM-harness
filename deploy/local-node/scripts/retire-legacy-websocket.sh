#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

test_mode="${LARM_LEGACY_WS_RETIRE_TEST_MODE:-0}"
if [[ "${test_mode}" == "1" ]]; then
  state_root="${LARM_RELEASE_STATE_ROOT:?required in test mode}"
  current_link="${LARM_RELEASE_CURRENT:?required in test mode}"
  unit_path="${LARM_LEGACY_WS_UNIT_PATH:?required in test mode}"
  retired_root="${LARM_RETIRED_UNIT_ROOT:?required in test mode}"
  gate_recorder="${LARM_RELEASE_GATE_RECORDER:?required in test mode}"
  openapi_file="${LARM_OPENAPI_FILE:?required in test mode}"
  systemctl_log="${LARM_SYSTEMCTL_LOG:?required in test mode}"
else
  [[ "$(id -u)" -eq 0 ]] || { echo "legacy WebSocket retirement must run as root" >&2; exit 1; }
  state_root=/var/lib/larm/release-controller
  current_link=/srv/ai/apps/larm-current
  unit_path=/etc/systemd/system/larm-native-qwen-provider.service
  retired_root=/var/lib/larm/retired-units
  gate_recorder=/usr/local/libexec/larm/record-larm-release-gate
  openapi_file=""
  systemctl_log=""
fi

fail() { echo "$*" >&2; exit 1; }

systemctl_run() {
  if [[ "${test_mode}" == "1" ]]; then
    printf '%s\n' "$*" >>"${systemctl_log}"
    case "$1" in
      is-active) printf 'inactive\n'; return 3 ;;
      is-enabled) printf 'disabled\n'; return 1 ;;
      show) printf '\n'; return 0 ;;
      *) return 0 ;;
    esac
  fi
  systemctl "$@"
}

[[ -d "${state_root}" && ! -L "${state_root}" && -f "${state_root}/status.json" ]] \
  || fail "release convergence state is unavailable"
[[ -L "${current_link}" ]] || fail "active release pointer is unavailable"
jq -e '.stage == "soak_verified" and .result == "succeeded"' "${state_root}/status.json" >/dev/null \
  || fail "legacy WebSocket cannot be retired before soak verification"

release="$(readlink -f -- "${current_link}")"
[[ -d "${release}" && ! -L "${release}" && -f "${release}/release-manifest.json" ]] \
  || fail "active release is unsafe"
commit="$(jq -er .commit "${release}/release-manifest.json")"
revision="$(jq -er .configRevision "${release}/release-manifest.json")"
desired="$(jq -er .desiredRelease "${state_root}/status.json")"
observed="$(jq -er .observedRelease "${state_root}/status.json")"
[[ "${commit}" == "${desired}" && "${commit}" == "${observed}" ]] \
  || fail "desired, observed, and active releases do not match"

for removed in \
  packages/core/src/saaa-llm-stream.ts \
  packages/backends/src/native-llm-stream.ts \
  apps/daemon/src/llm-stream-session.ts \
  deploy/local-node/systemd/larm-native-qwen-provider.service; do
  [[ ! -e "${release}/${removed}" ]] || fail "active release still contains ${removed}"
done

if [[ -n "${openapi_file}" ]]; then
  [[ -f "${openapi_file}" && ! -L "${openapi_file}" ]] || fail "test OpenAPI document is unsafe"
  openapi="$(<"${openapi_file}")"
else
  openapi="$(curl -fsS --max-time 5 http://127.0.0.1:9810/openapi.json)" \
    || fail "live OpenAPI document is unavailable"
fi
jq -e '.paths | has("/v1/llm/stream") | not' <<<"${openapi}" >/dev/null \
  || fail "live OpenAPI still advertises the legacy WebSocket route"

if [[ -e "${unit_path}" || -L "${unit_path}" ]]; then
  [[ -f "${unit_path}" && ! -L "${unit_path}" && "$(stat -c '%h' -- "${unit_path}")" -eq 1 ]] \
    || fail "legacy unit target is unsafe"
fi

systemctl_run disable --now larm-native-qwen-provider.service >/dev/null 2>&1 || true
if [[ -f "${unit_path}" ]]; then
  if [[ -e "${retired_root}" || -L "${retired_root}" ]]; then
    [[ -d "${retired_root}" && ! -L "${retired_root}" ]] || fail "retired unit directory is unsafe"
  elif [[ "${test_mode}" == "1" ]]; then
    install -d -m 0700 "${retired_root}"
  else
    install -d -o root -g root -m 0700 "${retired_root}"
  fi
  digest="$(sha256sum "${unit_path}" | awk '{print $1}')"
  retired="${retired_root}/larm-native-qwen-provider.service.${digest}"
  [[ ! -e "${retired}" && ! -L "${retired}" ]] || fail "retired unit backup already exists"
  mv -T -- "${unit_path}" "${retired}"
  chmod 0600 "${retired}"
fi
systemctl_run daemon-reload >/dev/null

active="$(systemctl_run is-active larm-native-qwen-provider.service 2>/dev/null || true)"
enabled="$(systemctl_run is-enabled larm-native-qwen-provider.service 2>/dev/null || true)"
fragment="$(systemctl_run show larm-native-qwen-provider.service -p FragmentPath --value 2>/dev/null || true)"
[[ "${active}" != "active" && "${active}" != "activating" && "${active}" != "reloading" ]] \
  || fail "legacy WebSocket service remains active"
[[ "${enabled}" != "enabled" && "${enabled}" != "enabled-runtime" && -z "${fragment}" ]] \
  || fail "legacy WebSocket unit remains installed or enabled"
[[ ! -e "${unit_path}" && ! -L "${unit_path}" ]] || fail "legacy WebSocket unit remains installed"
if [[ "${test_mode}" != "1" ]] && ss -H -ltn 'sport = :8090' | grep -q .; then
  fail "legacy WebSocket listener remains on port 8090"
fi

canary="${state_root}/canary-evidence.json"
[[ -f "${canary}" && ! -L "${canary}" ]] || fail "canary evidence is unavailable"
epoch="$(jq -er .bootEpoch "${canary}")"
[[ "$(jq -er .configRevision "${canary}")" == "${revision}" ]] \
  || fail "canary configuration generation does not match"

evidence="$(mktemp "${state_root}/.legacy-websocket-decommission.XXXXXX")"
trap 'rm -f -- "${evidence}"' EXIT
jq -n \
  --arg releaseCommit "${commit}" \
  --arg configRevision "${revision}" \
  --arg bootEpoch "${epoch}" \
  --arg observedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion:1,kind:"legacy-websocket-decommission",releaseCommit:$releaseCommit,
    configRevision:$configRevision,bootEpoch:$bootEpoch,observedAt:$observedAt,
    serviceActive:false,serviceEnabled:false,port8090Listening:false,
    installedUnitPresent:false,openApiRoutePresent:false,sourcePresent:false}' >"${evidence}"
chmod 0600 "${evidence}"

if [[ "${test_mode}" == "1" ]]; then
  LARM_RELEASE_GATE_TEST_MODE=1 \
    LARM_RELEASE_STATE_ROOT="${state_root}" \
    LARM_RELEASE_CURRENT="${current_link}" \
    bash "${gate_recorder}" decommission "${evidence}"
else
  "${gate_recorder}" decommission "${evidence}"
fi
trap - EXIT
rm -f -- "${evidence}"

echo "legacy proprietary WebSocket service retired; unit backup is in ${retired_root}"
