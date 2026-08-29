#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

action="${1:-plan}"
source_ip="${SAAA_SOURCE_IPV4:-}"
test_mode="${LARM_SAAA_NETWORK_TEST_MODE:-0}"

validate_source_ip() {
  local value="$1" first octet normalized="" separator=""
  local -a octets
  [[ "${value}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r -a octets <<<"${value}"
  for octet in "${octets[@]}"; do
    [[ "${octet}" =~ ^(0|[1-9][0-9]{0,2})$ && $((10#${octet})) -le 255 ]] || return 1
    normalized+="${separator}$((10#${octet}))"
    separator=.
  done
  [[ "${normalized}" == "${value}" ]] || return 1
  first=$((10#${octets[0]}))
  [[ "${first}" -ge 1 && "${first}" -le 223 && "${first}" -ne 127 ]] || return 1
}

[[ -n "${source_ip}" ]] || {
  echo "SAAA_SOURCE_IPV4 is required" >&2
  exit 2
}
validate_source_ip "${source_ip}" || {
  echo "SAAA_SOURCE_IPV4 must be one canonical unicast IPv4 address" >&2
  exit 2
}
source_cidr="${source_ip}/32"
state_key="${source_ip//./_}"

if [[ "${test_mode}" == "1" ]]; then
  test_root="${LARM_SAAA_NETWORK_TEST_ROOT:-}"
  [[ "${test_root}" == /* && "${test_root}" != "/" && -d "${test_root}" && ! -L "${test_root}" ]] || {
    echo "LARM_SAAA_NETWORK_TEST_ROOT must be an absolute non-symlink directory" >&2
    exit 2
  }
  [[ "$(realpath -se -- "${test_root}")" == "$(realpath -e -- "${test_root}")" ]] || {
    echo "LARM_SAAA_NETWORK_TEST_ROOT must not traverse symlinked path components" >&2
    exit 2
  }
  test_root="$(realpath -e -- "${test_root}")"
  ufw_fixture="${test_root}/ufw.txt"
  apply_log="${test_root}/apply.log"
  state_root="${test_root}/state"
  [[ -f "${ufw_fixture}" && ! -L "${ufw_fixture}" ]] || {
    echo "network test fixture must be a regular file" >&2
    exit 2
  }
else
  state_root="${LARM_SAAA_NETWORK_STATE_ROOT:-/var/lib/larm/saaa-rest-network}"
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

read_firewall() {
  if [[ "${test_mode}" == "1" ]]; then
    cat -- "${ufw_fixture}"
  else
    ufw status
  fi
}

run_firewall() {
  if [[ "${test_mode}" != "1" ]]; then
    ufw "$@"
    return
  fi
  printf 'ufw' >>"${apply_log}"
  printf ' %q' "$@" >>"${apply_log}"
  printf '\n' >>"${apply_log}"
  [[ "${LARM_SAAA_NETWORK_TEST_FAIL:-0}" != "1" ]] || return 1
  local operation="allow" argument previous="" cidr="" temporary
  for argument in "$@"; do
    [[ "${previous}" == "from" ]] && cidr="${argument}"
    [[ "${argument}" == "delete" ]] && operation="delete"
    previous="${argument}"
  done
  temporary="$(mktemp "${test_root}/.ufw.XXXXXX")"
  if [[ "${operation}" == "delete" ]]; then
    awk -v cidr="${cidr}" \
      '!( $1 == "9810/tcp" && $2 == "ALLOW" && $3 == "IN" && $4 == cidr ) {print}' \
      "${ufw_fixture}" >"${temporary}"
  else
    cat -- "${ufw_fixture}" >"${temporary}"
    printf '%-27s  ALLOW IN    %s\n' "9810/tcp" "${cidr}" >>"${temporary}"
  fi
  mv -T -- "${temporary}" "${ufw_fixture}"
}

json_lines() {
  jq -Rsc 'split("\n") | map(select(length > 0))'
}

make_plan() {
  local firewall firewall_rc readable=false status="unknown" allow_lines exact_count unexpected blockers payload digest
  set +e
  firewall="$(read_firewall 2>&1)"
  firewall_rc=$?
  set -e
  if [[ "${firewall_rc}" -eq 0 ]] && grep -Eq '^Status: (active|inactive)$' <<<"${firewall}"; then
    readable=true
    status="$(awk '/^Status:/ {print $2; exit}' <<<"${firewall}")"
  fi
  allow_lines="$(awk \
    '$1 ~ /^9810(\/tcp)?$/ && ($2 == "ALLOW" || ($2 == "(v6)" && $3 == "ALLOW")) {print}' \
    <<<"${firewall}" || true)"
  exact_count="$(awk -v ip="${source_ip}" -v cidr="${source_cidr}" \
    '$1 == "9810/tcp" && $2 == "ALLOW" {
      source = ($3 == "IN" ? $4 : $3)
      if (source == ip || source == cidr) count++
    }
      END {print count + 0}' \
    <<<"${allow_lines}")"
  unexpected="$(awk -v ip="${source_ip}" -v cidr="${source_cidr}" \
    '{
      exact = 0
      if ($1 == "9810/tcp" && $2 == "ALLOW") {
        source = ($3 == "IN" ? $4 : $3)
        exact = (source == ip || source == cidr)
      }
      if (!exact) print
    }' \
    <<<"${allow_lines}" || true)"
  blockers='[]'
  [[ "${readable}" == "true" ]] || blockers="$(jq -c '. + ["ufw_unreadable"]' <<<"${blockers}")"
  [[ "${status}" == "active" ]] || blockers="$(jq -c '. + ["ufw_not_active"]' <<<"${blockers}")"
  [[ "${exact_count}" -le 1 ]] || blockers="$(jq -c '. + ["duplicate_saaa_rule"]' <<<"${blockers}")"
  [[ -z "${unexpected}" ]] || blockers="$(jq -c '. + ["unexpected_gateway_rule"]' <<<"${blockers}")"
  payload="$(jq -cn \
    --arg sourceIpv4 "${source_ip}" \
    --arg sourceCidr "${source_cidr}" \
    --arg status "${status}" \
    --argjson readable "${readable}" \
    --argjson exactRuleCount "${exact_count}" \
    --argjson gatewayAllowRules "$(printf '%s' "${allow_lines}" | json_lines)" \
    --argjson unexpectedRules "$(printf '%s' "${unexpected}" | json_lines)" \
    --argjson blockers "${blockers}" \
    '{schemaVersion:1,action:"ensure-saaa-rest-access",sourceIpv4:$sourceIpv4,sourceCidr:$sourceCidr,
      port:9810,firewall:{readable:$readable,status:$status},exactRuleCount:$exactRuleCount,
      addRequired:($exactRuleCount == 0),gatewayAllowRules:$gatewayAllowRules,
      unexpectedRules:$unexpectedRules,blockers:$blockers,allowed:($blockers|length == 0)}')"
  digest="$(printf '%s' "${payload}" | sha256sum | awk '{print $1}')"
  jq -c --arg confirmation "${digest}" '. + {confirmation:$confirmation}' <<<"${payload}"
}

ensure_state_root() {
  if [[ "${test_mode}" == "1" ]]; then
    install -d -m 0700 -- "${state_root}"
  else
    install -d -o root -g root -m 0700 -- "${state_root}"
  fi
}

lock_mutation() {
  ensure_state_root
  exec 9>"${state_root}/network.lock"
  flock -n 9 || {
    echo "another SAAA network operation is running" >&2
    exit 2
  }
}

save_applied_state() {
  local confirmation="$1" target temporary
  target="${state_root}/applied-${state_key}.json"
  if [[ -L "${target}" || ( -e "${target}" && ! -f "${target}" ) ]]; then
    echo "refusing unsafe applied state target: ${target}" >&2
    exit 2
  fi
  [[ ! -e "${target}" ]] || {
    echo "an applied state already exists for ${source_ip}" >&2
    exit 2
  }
  temporary="$(mktemp "${state_root}/.applied-${state_key}.XXXXXX")"
  chmod 0600 -- "${temporary}"
  jq -cn --arg sourceIpv4 "${source_ip}" --arg sourceCidr "${source_cidr}" \
    --arg confirmation "${confirmation}" \
    '{schemaVersion:1,sourceIpv4:$sourceIpv4,sourceCidr:$sourceCidr,confirmation:$confirmation,added:true}' \
    >"${temporary}"
  mv -T -- "${temporary}" "${target}"
}

make_rollback_plan() {
  local applied_file firewall firewall_rc exact_count blockers payload digest
  applied_file="${state_root}/applied-${state_key}.json"
  blockers='[]'
  if [[ ! -f "${applied_file}" || -L "${applied_file}" ]] \
    || ! jq -e --arg source "${source_cidr}" \
      '.schemaVersion == 1 and .added == true and .sourceCidr == $source' "${applied_file}" >/dev/null 2>&1; then
    blockers="$(jq -c '. + ["applied_state_missing"]' <<<"${blockers}")"
  fi
  set +e
  firewall="$(read_firewall 2>&1)"
  firewall_rc=$?
  set -e
  [[ "${firewall_rc}" -eq 0 ]] || blockers="$(jq -c '. + ["ufw_unreadable"]' <<<"${blockers}")"
  exact_count="$(awk -v ip="${source_ip}" -v cidr="${source_cidr}" \
    '$1 == "9810/tcp" && $2 == "ALLOW" {
      source = ($3 == "IN" ? $4 : $3)
      if (source == ip || source == cidr) count++
    }
      END {print count + 0}' \
    <<<"${firewall}")"
  [[ "${exact_count}" -eq 1 ]] || blockers="$(jq -c '. + ["exact_rule_not_unique"]' <<<"${blockers}")"
  payload="$(jq -cn --arg sourceIpv4 "${source_ip}" --arg sourceCidr "${source_cidr}" \
    --argjson exactRuleCount "${exact_count}" --argjson blockers "${blockers}" \
    '{schemaVersion:1,action:"remove-added-saaa-rest-access",sourceIpv4:$sourceIpv4,
      sourceCidr:$sourceCidr,port:9810,exactRuleCount:$exactRuleCount,blockers:$blockers,
      allowed:($blockers|length == 0)}')"
  digest="$(printf '%s' "${payload}" | sha256sum | awk '{print $1}')"
  jq -c --arg confirmation "${digest}" '. + {confirmation:$confirmation}' <<<"${payload}"
}

case "${action}" in
  plan)
    make_plan | jq .
    ;;
  apply)
    [[ "${test_mode}" == "1" || "$(id -u)" -eq 0 ]] || { echo "apply requires root" >&2; exit 2; }
    lock_mutation
    plan="$(make_plan)"
    expected="$(jq -r .confirmation <<<"${plan}")"
    [[ "$(jq -r .allowed <<<"${plan}")" == "true" ]] || { jq . <<<"${plan}" >&2; exit 1; }
    [[ -n "${LARM_SAAA_NETWORK_CONFIRM:-}" && "${LARM_SAAA_NETWORK_CONFIRM}" == "${expected}" ]] || {
      jq . <<<"${plan}" >&2
      echo "set LARM_SAAA_NETWORK_CONFIRM to the reviewed confirmation digest" >&2
      exit 2
    }
    added=false
    if [[ "$(jq -r .addRequired <<<"${plan}")" == "true" ]]; then
      run_firewall allow from "${source_ip}" to any port 9810 proto tcp
      added=true
    fi
    after="$(make_plan)"
    if [[ "$(jq -r .allowed <<<"${after}")" != "true" || "$(jq -r .addRequired <<<"${after}")" != "false" ]]; then
      jq . <<<"${after}" >&2
      if [[ "${added}" == "true" ]]; then
        run_firewall --force delete allow from "${source_ip}" to any port 9810 proto tcp || true
      fi
      echo "SAAA REST network post-check failed" >&2
      exit 1
    fi
    [[ "${added}" == "false" ]] || save_applied_state "${expected}"
    jq -n --arg confirmation "${expected}" --argjson added "${added}" \
      '{applied:true,added:$added,confirmation:$confirmation}'
    ;;
  rollback-plan)
    make_rollback_plan | jq .
    ;;
  rollback)
    [[ "${test_mode}" == "1" || "$(id -u)" -eq 0 ]] || { echo "rollback requires root" >&2; exit 2; }
    lock_mutation
    rollback_plan="$(make_rollback_plan)"
    expected="$(jq -r .confirmation <<<"${rollback_plan}")"
    [[ "$(jq -r .allowed <<<"${rollback_plan}")" == "true" ]] || {
      jq . <<<"${rollback_plan}" >&2
      exit 1
    }
    [[ -n "${LARM_SAAA_NETWORK_ROLLBACK_CONFIRM:-}" \
      && "${LARM_SAAA_NETWORK_ROLLBACK_CONFIRM}" == "${expected}" ]] || {
      jq . <<<"${rollback_plan}" >&2
      echo "set LARM_SAAA_NETWORK_ROLLBACK_CONFIRM to the reviewed confirmation digest" >&2
      exit 2
    }
    run_firewall --force delete allow from "${source_ip}" to any port 9810 proto tcp
    after="$(make_plan)"
    [[ "$(jq -r .exactRuleCount <<<"${after}")" -eq 0 ]] || {
      echo "SAAA REST network rollback post-check failed" >&2
      exit 1
    }
    mv -T -- "${state_root}/applied-${state_key}.json" \
      "${state_root}/rolled-back-${state_key}-${expected}.json"
    jq -n --arg confirmation "${expected}" '{rolledBack:true,confirmation:$confirmation}'
    ;;
  *)
    echo "usage: SAAA_SOURCE_IPV4=x.x.x.x $0 [plan|apply|rollback-plan|rollback]" >&2
    exit 2
    ;;
esac
