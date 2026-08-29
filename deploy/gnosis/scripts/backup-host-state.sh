#!/usr/bin/env bash
set -euo pipefail

action="${1:-plan}"
label="${LARM_BACKUP_LABEL:-}"
backup_root="${LARM_BACKUP_ROOT:-/var/lib/larm/operator-backups}"
test_mode="${LARM_BACKUP_TEST_MODE:-0}"
test_root="${LARM_BACKUP_TEST_ROOT:-}"
units=(
  larm-daemon.service
  llama-server.service
  llama-swap-worker.service
  qwen-asr.service
  qwen-tts.service
  voicevox-tts.service
)

fail() { echo "$*" >&2; exit 1; }
[[ "${action}" =~ ^(plan|apply)$ ]] || fail "usage: $0 plan|apply"
[[ "${label}" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,12}$ ]] \
  || fail "LARM_BACKUP_LABEL must be UTC timestamp plus commit prefix"
[[ "${backup_root}" == /* && "${backup_root}" != "/" && ! -L "${backup_root}" ]] \
  || fail "backup root must be an absolute non-symlink path"
if [[ "${test_mode}" == "1" ]]; then
  [[ "${test_root}" == /* && "${test_root}" != "/" && -d "${test_root}" && ! -L "${test_root}" ]] \
    || fail "LARM_BACKUP_TEST_ROOT must be an absolute non-symlink directory"
else
  test_root=""
fi
target="${backup_root}/${label}"

host_path() {
  printf '%s%s\n' "${test_root}" "$1"
}

service_state() {
  local operation="$1" unit="$2"
  if [[ "${test_mode}" == "1" ]]; then
    printf 'test-unknown\n'
  else
    systemctl "${operation}" "${unit}" 2>/dev/null || true
  fi
}

make_plan() {
  local inventory='[]' blockers='[]' unit path type digest active enabled current_path current_type current_target payload confirmation
  for unit in "${units[@]}"; do
    path="$(host_path "/etc/systemd/system/${unit}")"
    type="missing"
    digest=""
    if [[ -L "${path}" ]]; then
      type="symlink"
      blockers="$(jq -c --arg unit "${unit}" '. + ["unsafe_unit:" + $unit]' <<<"${blockers}")"
    elif [[ -f "${path}" ]]; then
      type="regular"
      digest="$(sha256sum "${path}" | awk '{print $1}')"
    elif [[ -e "${path}" ]]; then
      type="other"
      blockers="$(jq -c --arg unit "${unit}" '. + ["unsafe_unit:" + $unit]' <<<"${blockers}")"
    fi
    active="$(service_state is-active "${unit}")"
    enabled="$(service_state is-enabled "${unit}")"
    inventory="$(jq -c --arg unit "${unit}" --arg type "${type}" --arg digest "${digest}" \
      --arg active "${active:-unknown}" --arg enabled "${enabled:-unknown}" \
      '. + [{unit:$unit,type:$type,digest:($digest|if length > 0 then . else null end),active:$active,enabled:$enabled}]' \
      <<<"${inventory}")"
  done
  current_path="$(host_path /srv/ai/apps/larm-current)"
  current_type="missing"
  current_target=""
  if [[ -L "${current_path}" ]]; then
    current_type="symlink"
    current_target="$(readlink -- "${current_path}")"
  elif [[ -e "${current_path}" ]]; then
    current_type="unsafe"
    blockers="$(jq -c '. + ["unsafe_current_pointer"]' <<<"${blockers}")"
  fi
  payload="$(jq -cn --arg label "${label}" --arg target "${target}" \
    --argjson units "${inventory}" --arg currentType "${current_type}" \
    --arg currentTarget "${current_target}" --argjson blockers "${blockers}" \
    '{schemaVersion:1,action:"backup-host-state",label:$label,target:$target,units:$units,
      currentPointer:{type:$currentType,target:($currentTarget|if length > 0 then . else null end)},
      blockers:$blockers,allowed:($blockers|length == 0)}')"
  confirmation="$(printf '%s' "${payload}" | sha256sum | awk '{print $1}')"
  jq -c --arg confirmation "${confirmation}" '. + {confirmation:$confirmation}' <<<"${payload}"
}

if [[ "${action}" == "plan" ]]; then
  make_plan | jq .
  exit 0
fi

[[ "${test_mode}" == "1" || "$(id -u)" -eq 0 ]] || fail "apply requires root"
install -d -m 0700 -- "${backup_root}"
exec 9>"${backup_root}/backup.lock"
flock -n 9 || fail "another host backup is running"
[[ ! -e "${target}" && ! -L "${target}" ]] || fail "backup target already exists"
plan="$(make_plan)"
expected="$(jq -r .confirmation <<<"${plan}")"
[[ "$(jq -r .allowed <<<"${plan}")" == "true" ]] || { jq . <<<"${plan}" >&2; exit 1; }
[[ "${LARM_BACKUP_CONFIRM:-}" == "${expected}" ]] || {
  jq . <<<"${plan}" >&2
  fail "set LARM_BACKUP_CONFIRM to the reviewed confirmation digest"
}
staging="$(mktemp -d "${backup_root}/.staging-${label}.XXXXXX")"
trap 'rm -rf -- "${staging:-}"' EXIT
chmod 0700 -- "${staging}"
install -d -m 0700 -- "${staging}/units"
while IFS=$'\t' read -r unit digest; do
  [[ -n "${unit}" ]] || continue
  source="$(host_path "/etc/systemd/system/${unit}")"
  [[ "$(sha256sum "${source}" | awk '{print $1}')" == "${digest}" ]] \
    || fail "unit changed after backup plan: ${unit}"
  install -m 0600 -- "${source}" "${staging}/units/${unit}"
done < <(jq -r '.units[] | select(.type == "regular") | [.unit,.digest] | @tsv' <<<"${plan}")
if [[ "$(jq -r .currentPointer.type <<<"${plan}")" == "symlink" ]]; then
  jq -r .currentPointer.target <<<"${plan}" >"${staging}/larm-current.target"
  chmod 0600 -- "${staging}/larm-current.target"
fi
jq -c --arg createdAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
  '. + {createdAt:$createdAt}' <<<"${plan}" >"${staging}/manifest.json"
chmod 0600 -- "${staging}/manifest.json"
mv -- "${staging}" "${target}"
trap - EXIT
jq -n --arg target "${target}" --arg confirmation "${expected}" \
  '{backedUp:true,target:$target,confirmation:$confirmation}'
