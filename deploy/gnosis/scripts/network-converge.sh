#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

action="${1:-plan}"
lan_cidr="${LAN_CIDR:-192.168.0.0/24}"
provider_ports=(8080 8081 8082 8083 8084)
test_mode="${LARM_NETWORK_TEST_MODE:-0}"

if [[ "${test_mode}" == "1" ]]; then
  test_root="${LARM_NETWORK_TEST_ROOT:-}"
  [[ "${test_root}" == /* && "${test_root}" != "/" && -d "${test_root}" && ! -L "${test_root}" ]] || {
    echo "LARM_NETWORK_TEST_ROOT must be an absolute non-symlink directory" >&2
    exit 2
  }
  [[ "$(realpath -se -- "${test_root}")" == "$(realpath -e -- "${test_root}")" ]] || {
    echo "LARM_NETWORK_TEST_ROOT must not traverse symlinked path components" >&2
    exit 2
  }
  test_root="$(realpath -e -- "${test_root}")"
  ss_fixture="${test_root}/ss.txt"
  ufw_fixture="${test_root}/ufw.txt"
  apply_log="${test_root}/apply.log"
  state_root="${test_root}/state"
  [[ -f "${ss_fixture}" && ! -L "${ss_fixture}" && -f "${ufw_fixture}" && ! -L "${ufw_fixture}" ]] || {
    echo "network test fixtures must be regular files" >&2
    exit 2
  }
else
  state_root="${LARM_NETWORK_STATE_ROOT:-/var/lib/larm/network}"
  [[ "${state_root}" == /* && "${state_root}" != "/" && ! -L "${state_root}" ]] || {
    echo "network state root must be an absolute non-symlink path" >&2
    exit 2
  }
  [[ "$(realpath -sm -- "${state_root}")" == "$(realpath -m -- "${state_root}")" ]] || {
    echo "network state root must not traverse symlinked path components" >&2
    exit 2
  }
  state_root="$(realpath -sm -- "${state_root}")"
fi

read_listeners() {
  if [[ "${test_mode}" == "1" ]]; then
    cat -- "${ss_fixture}"
  else
    ss -H -ltn
  fi
}

read_firewall() {
  if [[ "${test_mode}" == "1" ]]; then
    cat -- "${ufw_fixture}"
  else
    ufw status
  fi
}

run_firewall() {
  if [[ "${test_mode}" == "1" ]]; then
    printf 'ufw' >>"${apply_log}"
    printf ' %q' "$@" >>"${apply_log}"
    printf '\n' >>"${apply_log}"
    local operation="" cidr="" port="" argument previous=""
    for argument in "$@"; do
      if [[ "${previous}" == "from" ]]; then cidr="${argument}"; fi
      if [[ "${previous}" == "port" ]]; then port="${argument}"; fi
      [[ "${argument}" == "delete" ]] && operation="delete"
      previous="${argument}"
    done
    [[ -n "${operation}" ]] || operation="allow"
    if [[ "${operation}" == "delete" && "${port}" == "${LARM_NETWORK_TEST_FAIL_PORT:-}" ]]; then
      return 1
    fi
    local temporary
    temporary="$(mktemp "${test_root}/.ufw.XXXXXX")"
    if [[ "${operation}" == "delete" ]]; then
      awk -v target="${port}/tcp" -v source="${cidr}" \
        '!( $1 == target && $2 == "ALLOW" && $3 == "IN" && $4 == source ) {print}' \
        "${ufw_fixture}" >"${temporary}"
    else
      cat -- "${ufw_fixture}" >"${temporary}"
      printf '%-27s  ALLOW IN    %s\n' "${port}/tcp" "${cidr}" >>"${temporary}"
    fi
    mv -T -- "${temporary}" "${ufw_fixture}"
    if [[ "${operation}" == "delete" && "${port}" == "${LARM_NETWORK_TEST_FAIL_AFTER_DELETE_PORT:-}" ]]; then
      return 1
    fi
  else
    ufw "$@"
  fi
}

save_reviewed_plan() {
  local plan="$1" confirmation="$2" target temporary
  if [[ "${test_mode}" == "1" ]]; then
    install -d -m 0700 -- "${state_root}"
  else
    install -d -o root -g root -m 0700 -- "${state_root}"
  fi
  target="${state_root}/before-${confirmation}.json"
  if [[ -L "${target}" || ( -e "${target}" && ! -f "${target}" ) ]]; then
    echo "refusing unsafe network state target: ${target}" >&2
    exit 2
  fi
  if [[ -f "${target}" ]]; then
    [[ "$(cat -- "${target}")" == "${plan}" ]] || {
      echo "existing network state does not match the reviewed plan" >&2
      exit 2
    }
    return
  fi
  temporary="$(mktemp "${state_root}/.before-${confirmation}.XXXXXX")"
  chmod 0600 -- "${temporary}"
  printf '%s\n' "${plan}" >"${temporary}"
  mv -T -- "${temporary}" "${target}"
}

lock_network_mutation() {
  if [[ "${test_mode}" == "1" ]]; then
    install -d -m 0700 -- "${state_root}"
  else
    install -d -o root -g root -m 0700 -- "${state_root}"
  fi
  exec 9>"${state_root}/network.lock"
  flock -n 9 || {
    echo "another network convergence operation is running" >&2
    exit 2
  }
}

port_is_provider() {
  local requested="$1" candidate
  for candidate in "${provider_ports[@]}"; do
    [[ "${requested}" == "${candidate}" ]] && return 0
  done
  return 1
}

provider_listener_lines() {
  local input="$1" port
  for port in "${provider_ports[@]}"; do
    grep -E "(^|[[:space:]])[^[:space:]]*:${port}([[:space:]]|$)" <<<"${input}" || true
  done | sort -u
}

wildcard_listener_lines() {
  local input="$1" port
  for port in "${provider_ports[@]}"; do
    grep -E "(^|[[:space:]])(0\.0\.0\.0|\*|\[::\]|::):${port}([[:space:]]|$)" <<<"${input}" || true
  done | sort -u
}

json_lines() {
  jq -Rsc 'split("\n") | map(select(length > 0))'
}

make_plan() {
  local listeners firewall firewall_rc firewall_readable=false firewall_status="unknown"
  local provider_lines wildcard_lines allow_lines unexpected_lines duplicate_rules delete_rules blockers payload digest port count
  listeners="$(read_listeners)"
  set +e
  firewall="$(read_firewall 2>&1)"
  firewall_rc=$?
  set -e
  if [[ "${firewall_rc}" -eq 0 ]] && grep -Eq '^Status: (active|inactive)$' <<<"${firewall}"; then
    firewall_readable=true
    firewall_status="$(awk '/^Status:/ {print $2; exit}' <<<"${firewall}")"
  fi
  provider_lines="$(provider_listener_lines "${listeners}")"
  wildcard_lines="$(wildcard_listener_lines "${listeners}")"
  allow_lines="$(awk '$1 ~ /^(8080|8081|8082|8083|8084)(\/tcp)?$/ && $0 ~ /[[:space:]]ALLOW[[:space:]]+IN[[:space:]]/ {print}' <<<"${firewall}" || true)"
  delete_rules='[]'
  duplicate_rules='[]'
  for port in "${provider_ports[@]}"; do
    count="$(awk -v target="${port}/tcp" -v cidr="${lan_cidr}" \
      '$1 == target && $2 == "ALLOW" && $3 == "IN" && $4 == cidr {count++} END {print count + 0}' \
      <<<"${firewall}")"
    if [[ "${count}" -eq 1 ]]; then
      delete_rules="$(jq -c --argjson port "${port}" --arg cidr "${lan_cidr}" \
        '. + [{port:$port,cidr:$cidr}]' <<<"${delete_rules}")"
    elif [[ "${count}" -gt 1 ]]; then
      duplicate_rules="$(jq -c --argjson port "${port}" --arg cidr "${lan_cidr}" --argjson count "${count}" \
        '. + [{port:$port,cidr:$cidr,count:$count}]' <<<"${duplicate_rules}")"
    fi
  done
  unexpected_lines="$(while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    matched=false
    for port in "${provider_ports[@]}"; do
      if awk -v target="${port}/tcp" -v cidr="${lan_cidr}" \
        '$1 == target && $2 == "ALLOW" && $3 == "IN" && $4 == cidr {found=1} END {exit !found}' \
        <<<"${line}"; then
        matched=true
      fi
    done
    [[ "${matched}" == "true" ]] || printf '%s\n' "${line}"
  done <<<"${allow_lines}")"
  blockers='[]'
  [[ "${firewall_readable}" == "true" ]] || blockers="$(jq -c '. + ["ufw_unreadable"]' <<<"${blockers}")"
  [[ -z "${wildcard_lines}" ]] || blockers="$(jq -c '. + ["provider_wildcard_listener"]' <<<"${blockers}")"
  [[ -z "${unexpected_lines}" ]] || blockers="$(jq -c '. + ["unexpected_provider_allow_rule"]' <<<"${blockers}")"
  [[ "$(jq 'length' <<<"${duplicate_rules}")" -eq 0 ]] \
    || blockers="$(jq -c '. + ["duplicate_provider_allow_rule"]' <<<"${blockers}")"
  payload="$(jq -cn \
    --arg lanCidr "${lan_cidr}" \
    --arg firewallStatus "${firewall_status}" \
    --argjson firewallReadable "${firewall_readable}" \
    --argjson listeners "$(printf '%s' "${provider_lines}" | json_lines)" \
    --argjson wildcardListeners "$(printf '%s' "${wildcard_lines}" | json_lines)" \
    --argjson providerAllowRules "$(printf '%s' "${allow_lines}" | json_lines)" \
    --argjson unexpectedAllowRules "$(printf '%s' "${unexpected_lines}" | json_lines)" \
    --argjson duplicateAllowRules "${duplicate_rules}" \
    --argjson deleteRules "${delete_rules}" \
    --argjson blockers "${blockers}" \
    '{schemaVersion:1,action:"remove-legacy-provider-lan-rules",lanCidr:$lanCidr,
      firewall:{readable:$firewallReadable,status:$firewallStatus},listeners:$listeners,
      wildcardListeners:$wildcardListeners,providerAllowRules:$providerAllowRules,
      unexpectedAllowRules:$unexpectedAllowRules,duplicateAllowRules:$duplicateAllowRules,
      deleteRules:$deleteRules,blockers:$blockers,
      allowed:($blockers|length == 0)}')"
  digest="$(printf '%s' "${payload}" | sha256sum | awk '{print $1}')"
  jq -c --arg confirmation "${digest}" '. + {confirmation:$confirmation}' <<<"${payload}"
}

validate_rollback_cidr() {
  local cidr="$1" prefix address octet normalized block_size
  local -a octets
  [[ "${cidr}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/(2[4-9]|3[0-2])$ ]] || return 1
  prefix="${cidr##*/}"
  address="${cidr%/*}"
  IFS=. read -r -a octets <<<"${address}"
  [[ "${#octets[@]}" -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    ((10#${octet} >= 0 && 10#${octet} <= 255)) || return 1
  done
  normalized="$((10#${octets[0]})).$((10#${octets[1]})).$((10#${octets[2]})).$((10#${octets[3]}))"
  [[ "${address}" == "${normalized}" ]] || return 1
  ((prefix >= 24 && prefix <= 32)) || return 1
  block_size=$((1 << (32 - prefix)))
  ((10#${octets[3]} % block_size == 0))
}

validate_rollback_cidr "${lan_cidr}" || {
  echo "LAN_CIDR must be a canonical IPv4 /24 through /32" >&2
  exit 2
}

restore_rules() {
  local rules="$1" index port cidr failed=0
  for ((index = $(jq 'length' <<<"${rules}") - 1; index >= 0; index -= 1)); do
    port="$(jq -r ".[${index}].port" <<<"${rules}")"
    cidr="$(jq -r ".[${index}].cidr" <<<"${rules}")"
    if ! firewall_rule_exists "${port}" "${cidr}"; then
      run_firewall allow from "${cidr}" to any port "${port}" proto tcp || true
    fi
    firewall_rule_exists "${port}" "${cidr}" || failed=1
  done
  [[ "${failed}" -eq 0 ]]
}

firewall_rule_exists() {
  local port="$1" cidr="$2" firewall firewall_rc
  set +e
  firewall="$(read_firewall 2>&1)"
  firewall_rc=$?
  set -e
  [[ "${firewall_rc}" -eq 0 ]] && grep -Eq '^Status: (active|inactive)$' <<<"${firewall}" \
    && awk -v target="${port}/tcp" -v source="${cidr}" \
      '$1 == target && $2 == "ALLOW" && $3 == "IN" && $4 == source {found=1} END {exit !found}' \
      <<<"${firewall}"
}

make_rollback_plan() {
  local port="$1" cidr="$2" listeners firewall firewall_rc firewall_readable=false
  local listener_lines wildcard_lines existing=false blockers payload digest
  port_is_provider "${port}" || { echo "rollback port must be one of 8080-8084" >&2; exit 2; }
  validate_rollback_cidr "${cidr}" || { echo "rollback CIDR must be an IPv4 /24 through /32" >&2; exit 2; }
  listeners="$(read_listeners)"
  listener_lines="$(grep -E "(^|[[:space:]])[^[:space:]]*:${port}([[:space:]]|$)" <<<"${listeners}" || true)"
  wildcard_lines="$(grep -E "(^|[[:space:]])(0\.0\.0\.0|\*|\[::\]|::):${port}([[:space:]]|$)" <<<"${listeners}" || true)"
  set +e
  firewall="$(read_firewall 2>&1)"
  firewall_rc=$?
  set -e
  if [[ "${firewall_rc}" -eq 0 ]] && grep -Eq '^Status: (active|inactive)$' <<<"${firewall}"; then
    firewall_readable=true
  fi
  if awk -v target="${port}/tcp" -v cidr="${cidr}" \
    '$1 == target && $2 == "ALLOW" && $3 == "IN" && $4 == cidr {found=1} END {exit !found}' \
    <<<"${firewall}"; then
    existing=true
  fi
  blockers='[]'
  [[ "${firewall_readable}" == "true" ]] || blockers="$(jq -c '. + ["ufw_unreadable"]' <<<"${blockers}")"
  [[ -n "${wildcard_lines}" ]] || blockers="$(jq -c '. + ["provider_not_listening_on_network"]' <<<"${blockers}")"
  [[ "${existing}" == "false" ]] || blockers="$(jq -c '. + ["rule_already_exists"]' <<<"${blockers}")"
  payload="$(jq -cn --argjson port "${port}" --arg cidr "${cidr}" \
    --argjson firewallReadable "${firewall_readable}" --argjson existing "${existing}" \
    --argjson listeners "$(printf '%s' "${listener_lines}" | json_lines)" \
    --argjson blockers "${blockers}" \
    '{schemaVersion:1,action:"restore-single-provider-rule",port:$port,cidr:$cidr,
      firewallReadable:$firewallReadable,existing:$existing,listeners:$listeners,
      blockers:$blockers,allowed:($blockers|length == 0)}')"
  digest="$(printf '%s' "${payload}" | sha256sum | awk '{print $1}')"
  jq -c --arg confirmation "${digest}" '. + {confirmation:$confirmation}' <<<"${payload}"
}

case "${action}" in
  plan)
    make_plan | jq .
    ;;
  apply)
    [[ "${test_mode}" == "1" || "$(id -u)" -eq 0 ]] || { echo "apply requires root" >&2; exit 2; }
    lock_network_mutation
    plan="$(make_plan)"
    expected="$(jq -r .confirmation <<<"${plan}")"
    [[ "$(jq -r .allowed <<<"${plan}")" == "true" ]] || { jq . <<<"${plan}" >&2; exit 1; }
    [[ -n "${LARM_NETWORK_CONFIRM:-}" && "${LARM_NETWORK_CONFIRM}" == "${expected}" ]] || {
      jq . <<<"${plan}" >&2
      echo "set LARM_NETWORK_CONFIRM to the reviewed confirmation digest" >&2
      exit 2
    }
    save_reviewed_plan "${plan}" "${expected}"
    applied_rules='[]'
    while IFS=$'\t' read -r port cidr; do
      [[ -n "${port}" ]] || continue
      if ! run_firewall --force delete allow from "${cidr}" to any port "${port}" proto tcp; then
        if ! firewall_rule_exists "${port}" "${cidr}"; then
          applied_rules="$(jq -c --argjson port "${port}" --arg cidr "${cidr}" \
            '. + [{port:$port,cidr:$cidr}]' <<<"${applied_rules}")"
        fi
        if restore_rules "${applied_rules}"; then
          echo "failed to delete reviewed provider rule for port ${port}; prior deletions were restored" >&2
        else
          echo "failed to delete reviewed provider rule for port ${port}; automatic restoration is incomplete" >&2
        fi
        exit 1
      fi
      applied_rules="$(jq -c --argjson port "${port}" --arg cidr "${cidr}" \
        '. + [{port:$port,cidr:$cidr}]' <<<"${applied_rules}")"
    done < <(jq -r '.deleteRules[] | [.port,.cidr] | @tsv' <<<"${plan}")
    after="$(make_plan)"
    if [[ "$(jq -r .allowed <<<"${after}")" != "true" || "$(jq '.deleteRules | length' <<<"${after}")" -ne 0 ]]; then
      jq . <<<"${after}" >&2
      if restore_rules "${applied_rules}"; then
        echo "network post-check failed; reviewed rules were restored" >&2
      else
        echo "network post-check failed; automatic restoration is incomplete" >&2
      fi
      exit 1
    fi
    jq -n --arg confirmation "${expected}" '{applied:true,confirmation:$confirmation}'
    ;;
  rollback-plan)
    rollback_port="${2:-}"
    rollback_cidr="${LARM_NETWORK_ROLLBACK_CIDR:-}"
    [[ -n "${rollback_port}" && -n "${rollback_cidr}" ]] || {
      echo "usage: LARM_NETWORK_ROLLBACK_CIDR=x.x.x.x/24 $0 rollback-plan PORT" >&2
      exit 2
    }
    make_rollback_plan "${rollback_port}" "${rollback_cidr}" | jq .
    ;;
  rollback)
    [[ "${test_mode}" == "1" || "$(id -u)" -eq 0 ]] || { echo "rollback requires root" >&2; exit 2; }
    lock_network_mutation
    rollback_port="${2:-}"
    rollback_cidr="${LARM_NETWORK_ROLLBACK_CIDR:-}"
    [[ -n "${rollback_port}" && -n "${rollback_cidr}" ]] || {
      echo "usage: LARM_NETWORK_ROLLBACK_CIDR=x.x.x.x/24 $0 rollback PORT" >&2
      exit 2
    }
    rollback_plan="$(make_rollback_plan "${rollback_port}" "${rollback_cidr}")"
    rollback_expected="$(jq -r .confirmation <<<"${rollback_plan}")"
    [[ "$(jq -r .allowed <<<"${rollback_plan}")" == "true" ]] || { jq . <<<"${rollback_plan}" >&2; exit 1; }
    [[ -n "${LARM_NETWORK_ROLLBACK_CONFIRM:-}" && "${LARM_NETWORK_ROLLBACK_CONFIRM}" == "${rollback_expected}" ]] || {
      jq . <<<"${rollback_plan}" >&2
      echo "set LARM_NETWORK_ROLLBACK_CONFIRM to the reviewed confirmation digest" >&2
      exit 2
    }
    run_firewall allow from "${rollback_cidr}" to any port "${rollback_port}" proto tcp
    firewall_rule_exists "${rollback_port}" "${rollback_cidr}" || {
      echo "restored firewall rule was not observable after rollback" >&2
      exit 1
    }
    jq -n --argjson port "${rollback_port}" --arg cidr "${rollback_cidr}" \
      '{restored:true,port:$port,cidr:$cidr}'
    ;;
  *)
    echo "usage: $0 plan|apply|rollback-plan PORT|rollback PORT" >&2
    exit 2
    ;;
esac
