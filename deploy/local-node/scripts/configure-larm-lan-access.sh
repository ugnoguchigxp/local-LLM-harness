#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

action="${1:-plan}"
test_mode="${LARM_LAN_NETWORK_TEST_MODE:-0}"
requested_interface="${LARM_LAN_INTERFACE:-}"

if [[ "${test_mode}" == "1" ]]; then
  test_root="${LARM_LAN_NETWORK_TEST_ROOT:-}"
  [[ "${test_root}" == /* && "${test_root}" != "/" && -d "${test_root}" && ! -L "${test_root}" ]] || {
    echo "LARM_LAN_NETWORK_TEST_ROOT must be an absolute non-symlink directory" >&2
    exit 2
  }
  [[ "$(realpath -se -- "${test_root}")" == "$(realpath -e -- "${test_root}")" ]] || {
    echo "LARM_LAN_NETWORK_TEST_ROOT must not traverse symlinked path components" >&2
    exit 2
  }
  test_root="$(realpath -e -- "${test_root}")"
  routes_fixture="${test_root}/routes.json"
  addresses_fixture="${test_root}/addresses.json"
  ufw_fixture="${test_root}/ufw.txt"
  apply_log="${test_root}/apply.log"
  state_root="${test_root}/state"
  for fixture in "${routes_fixture}" "${addresses_fixture}" "${ufw_fixture}"; do
    [[ -f "${fixture}" && ! -L "${fixture}" ]] || {
      echo "network test fixtures must be regular files" >&2
      exit 2
    }
  done
else
  state_root="${LARM_LAN_NETWORK_STATE_ROOT:-/var/lib/larm/lan-gateway-network}"
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

read_routes() {
  if [[ "${test_mode}" == "1" ]]; then
    jq -c . "${routes_fixture}"
  else
    ip -4 -json route show default
  fi
}

read_addresses() {
  if [[ "${test_mode}" == "1" ]]; then
    jq -c . "${addresses_fixture}"
  else
    ip -4 -json address show
  fi
}

discover_lan() {
  local routes addresses
  routes="$(read_routes)"
  addresses="$(read_addresses)"
  python3 - "${requested_interface}" "${routes}" "${addresses}" <<'PY'
import ipaddress
import json
import sys

requested_interface, routes_json, addresses_json = sys.argv[1:]
routes = json.loads(routes_json)
addresses = json.loads(addresses_json)

if requested_interface:
    interface = requested_interface
else:
    interfaces = sorted({
        route.get("dev")
        for route in routes
        if route.get("dst") == "default" and isinstance(route.get("dev"), str)
    })
    if len(interfaces) != 1:
        raise SystemExit(
            "LAN discovery requires exactly one default-route interface; "
            "set LARM_LAN_INTERFACE only after reviewing the alternatives"
        )
    interface = interfaces[0]

matches = [item for item in addresses if item.get("ifname") == interface]
if len(matches) != 1:
    raise SystemExit(f"LAN interface {interface!r} is unavailable or ambiguous")
if matches[0].get("operstate") not in ("UP", "UNKNOWN"):
    raise SystemExit(f"LAN interface {interface!r} is not up")

ipv4 = [
    item
    for item in matches[0].get("addr_info", [])
    if item.get("family") == "inet"
    and item.get("scope") == "global"
    and isinstance(item.get("local"), str)
    and isinstance(item.get("prefixlen"), int)
]
if len(ipv4) != 1:
    raise SystemExit(
        f"LAN interface {interface!r} must have exactly one global IPv4 address"
    )

address = ipaddress.IPv4Address(ipv4[0]["local"])
prefix_length = ipv4[0]["prefixlen"]
network = ipaddress.IPv4Network(f"{address}/{prefix_length}", strict=False)
private_ranges = (
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
)
if not any(address in candidate and network.subnet_of(candidate) for candidate in private_ranges):
    raise SystemExit(
        f"LAN interface {interface!r} does not have an RFC1918 IPv4 prefix"
    )

print(json.dumps({
    "interface": interface,
    "address": str(address),
    "prefixLength": prefix_length,
    "sourceCidr": str(network),
}, separators=(",", ":")))
PY
}

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
  [[ "${LARM_LAN_NETWORK_TEST_FAIL:-0}" != "1" ]] || return 1
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

classify_rules() {
  local source_cidr="$1" allow_lines="$2"
  python3 - "${source_cidr}" "${allow_lines}" <<'PY'
import ipaddress
import json
import sys

desired = ipaddress.IPv4Network(sys.argv[1])
specific = []
unexpected = []
for line in sys.argv[2].splitlines():
    fields = line.split()
    if not fields:
        continue
    if fields[0] != "9810/tcp" or "(v6)" in fields:
        unexpected.append(line)
        continue
    source = fields[3] if len(fields) > 3 and fields[2] == "IN" else fields[2]
    try:
        candidate = ipaddress.IPv4Network(source, strict=False)
    except ValueError:
        unexpected.append(line)
        continue
    if candidate == desired:
        continue
    if candidate.subnet_of(desired):
        specific.append(line)
    else:
        unexpected.append(line)
print(json.dumps({"specific": specific, "unexpected": unexpected}, separators=(",", ":")))
PY
}

make_plan() {
  local discovery interface address prefix_length source_cidr firewall firewall_rc readable=false
  local status="unknown" allow_lines exact_count classified specific unexpected blockers payload digest
  discovery="$(discover_lan)"
  interface="$(jq -er .interface <<<"${discovery}")"
  address="$(jq -er .address <<<"${discovery}")"
  prefix_length="$(jq -er .prefixLength <<<"${discovery}")"
  source_cidr="$(jq -er .sourceCidr <<<"${discovery}")"
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
  exact_count="$(awk -v cidr="${source_cidr}" \
    '$1 == "9810/tcp" && $2 == "ALLOW" {
      source = ($3 == "IN" ? $4 : $3)
      if (source == cidr) count++
    }
      END {print count + 0}' \
    <<<"${allow_lines}")"
  classified="$(classify_rules "${source_cidr}" "${allow_lines}")"
  specific="$(jq -c .specific <<<"${classified}")"
  unexpected="$(jq -c .unexpected <<<"${classified}")"
  blockers='[]'
  [[ "${readable}" == "true" ]] || blockers="$(jq -c '. + ["ufw_unreadable"]' <<<"${blockers}")"
  [[ "${status}" == "active" ]] || blockers="$(jq -c '. + ["ufw_not_active"]' <<<"${blockers}")"
  [[ "${exact_count}" -le 1 ]] || blockers="$(jq -c '. + ["duplicate_lan_rule"]' <<<"${blockers}")"
  [[ "$(jq 'length' <<<"${unexpected}")" -eq 0 ]] \
    || blockers="$(jq -c '. + ["unexpected_gateway_rule"]' <<<"${blockers}")"
  payload="$(jq -cn \
    --arg interface "${interface}" \
    --arg address "${address}" \
    --argjson prefixLength "${prefix_length}" \
    --arg sourceCidr "${source_cidr}" \
    --arg status "${status}" \
    --argjson readable "${readable}" \
    --argjson exactRuleCount "${exact_count}" \
    --argjson gatewayAllowRules "$(printf '%s' "${allow_lines}" | json_lines)" \
    --argjson existingSpecificAllowRules "${specific}" \
    --argjson unexpectedRules "${unexpected}" \
    --argjson blockers "${blockers}" \
    '{schemaVersion:1,action:"ensure-larm-lan-gateway-access",interface:$interface,
      address:$address,prefixLength:$prefixLength,sourceCidr:$sourceCidr,port:9810,
      firewall:{readable:$readable,status:$status},exactRuleCount:$exactRuleCount,
      addRequired:($exactRuleCount == 0),gatewayAllowRules:$gatewayAllowRules,
      existingSpecificAllowRules:$existingSpecificAllowRules,unexpectedRules:$unexpectedRules,
      blockers:$blockers,allowed:($blockers|length == 0)}')"
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
    echo "another LARM LAN network operation is running" >&2
    exit 2
  }
}

save_applied_state() {
  local plan="$1" confirmation="$2" source_cidr state_key target temporary
  source_cidr="$(jq -er .sourceCidr <<<"${plan}")"
  state_key="$(printf '%s' "${source_cidr}" | sha256sum | awk '{print substr($1,1,16)}')"
  target="${state_root}/applied-${state_key}.json"
  if [[ -L "${target}" || ( -e "${target}" && ! -f "${target}" ) ]]; then
    echo "refusing unsafe applied state target: ${target}" >&2
    exit 2
  fi
  [[ ! -e "${target}" ]] || {
    echo "an applied state already exists for ${source_cidr}" >&2
    exit 2
  }
  temporary="$(mktemp "${state_root}/.applied-${state_key}.XXXXXX")"
  chmod 0600 -- "${temporary}"
  jq -cn \
    --arg interface "$(jq -er .interface <<<"${plan}")" \
    --arg sourceCidr "${source_cidr}" \
    --arg confirmation "${confirmation}" \
    '{schemaVersion:1,interface:$interface,sourceCidr:$sourceCidr,
      confirmation:$confirmation,added:true}' >"${temporary}"
  mv -T -- "${temporary}" "${target}"
}

find_applied_state() {
  local source_cidr="$1" candidate found=""
  [[ -d "${state_root}" && ! -L "${state_root}" ]] || return 1
  while IFS= read -r -d '' candidate; do
    jq -e --arg source "${source_cidr}" \
      '.schemaVersion == 1 and .added == true and .sourceCidr == $source' \
      "${candidate}" >/dev/null 2>&1 || continue
    [[ -z "${found}" ]] || return 1
    found="${candidate}"
  done < <(find "${state_root}" -maxdepth 1 -type f -name 'applied-*.json' -print0)
  [[ -n "${found}" ]] || return 1
  printf '%s\n' "${found}"
}

make_rollback_plan() {
  local discovery source_cidr applied_file="" firewall firewall_rc exact_count blockers payload digest
  discovery="$(discover_lan)"
  source_cidr="$(jq -er .sourceCidr <<<"${discovery}")"
  blockers='[]'
  applied_file="$(find_applied_state "${source_cidr}" || true)"
  [[ -n "${applied_file}" ]] || blockers="$(jq -c '. + ["applied_state_missing"]' <<<"${blockers}")"
  set +e
  firewall="$(read_firewall 2>&1)"
  firewall_rc=$?
  set -e
  [[ "${firewall_rc}" -eq 0 ]] || blockers="$(jq -c '. + ["ufw_unreadable"]' <<<"${blockers}")"
  exact_count="$(awk -v cidr="${source_cidr}" \
    '$1 == "9810/tcp" && $2 == "ALLOW" {
      source = ($3 == "IN" ? $4 : $3)
      if (source == cidr) count++
    }
      END {print count + 0}' <<<"${firewall}")"
  [[ "${exact_count}" -eq 1 ]] || blockers="$(jq -c '. + ["exact_rule_not_unique"]' <<<"${blockers}")"
  payload="$(jq -cn \
    --arg interface "$(jq -er .interface <<<"${discovery}")" \
    --arg sourceCidr "${source_cidr}" \
    --arg appliedFile "${applied_file}" \
    --argjson exactRuleCount "${exact_count}" \
    --argjson blockers "${blockers}" \
    '{schemaVersion:1,action:"remove-added-larm-lan-gateway-access",interface:$interface,
      sourceCidr:$sourceCidr,port:9810,appliedFile:$appliedFile,
      exactRuleCount:$exactRuleCount,blockers:$blockers,allowed:($blockers|length == 0)}')"
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
    expected="$(jq -er .confirmation <<<"${plan}")"
    [[ "$(jq -r .allowed <<<"${plan}")" == "true" ]] || { jq . <<<"${plan}" >&2; exit 1; }
    [[ -n "${LARM_LAN_NETWORK_CONFIRM:-}" && "${LARM_LAN_NETWORK_CONFIRM}" == "${expected}" ]] || {
      jq . <<<"${plan}" >&2
      echo "set LARM_LAN_NETWORK_CONFIRM to the reviewed confirmation digest" >&2
      exit 2
    }
    added=false
    source_cidr="$(jq -er .sourceCidr <<<"${plan}")"
    if [[ "$(jq -r .addRequired <<<"${plan}")" == "true" ]]; then
      run_firewall allow from "${source_cidr}" to any port 9810 proto tcp
      added=true
    fi
    after="$(make_plan)"
    if [[ "$(jq -r .allowed <<<"${after}")" != "true" \
      || "$(jq -r .addRequired <<<"${after}")" != "false" \
      || ( "${added}" == "true" && "$(jq -r .confirmation <<<"${after}")" == "${expected}" ) ]]; then
      jq . <<<"${after}" >&2
      if [[ "${added}" == "true" ]]; then
        run_firewall --force delete allow from "${source_cidr}" to any port 9810 proto tcp || true
      fi
      echo "LARM LAN network post-check failed" >&2
      exit 1
    fi
    if [[ "${added}" == "true" ]] && ! save_applied_state "${plan}" "${expected}"; then
      run_firewall --force delete allow from "${source_cidr}" to any port 9810 proto tcp || true
      echo "LARM LAN network state recording failed; the added rule was rolled back" >&2
      exit 1
    fi
    jq -n --arg confirmation "${expected}" --arg sourceCidr "${source_cidr}" \
      --argjson added "${added}" \
      '{applied:true,added:$added,sourceCidr:$sourceCidr,confirmation:$confirmation}'
    ;;
  rollback-plan)
    make_rollback_plan | jq .
    ;;
  rollback)
    [[ "${test_mode}" == "1" || "$(id -u)" -eq 0 ]] || { echo "rollback requires root" >&2; exit 2; }
    lock_mutation
    rollback_plan="$(make_rollback_plan)"
    expected="$(jq -er .confirmation <<<"${rollback_plan}")"
    [[ "$(jq -r .allowed <<<"${rollback_plan}")" == "true" ]] || {
      jq . <<<"${rollback_plan}" >&2
      exit 1
    }
    [[ -n "${LARM_LAN_NETWORK_ROLLBACK_CONFIRM:-}" \
      && "${LARM_LAN_NETWORK_ROLLBACK_CONFIRM}" == "${expected}" ]] || {
      jq . <<<"${rollback_plan}" >&2
      echo "set LARM_LAN_NETWORK_ROLLBACK_CONFIRM to the reviewed confirmation digest" >&2
      exit 2
    }
    source_cidr="$(jq -er .sourceCidr <<<"${rollback_plan}")"
    applied_file="$(jq -er .appliedFile <<<"${rollback_plan}")"
    run_firewall --force delete allow from "${source_cidr}" to any port 9810 proto tcp
    after="$(make_plan)"
    [[ "$(jq -r .exactRuleCount <<<"${after}")" -eq 0 ]] || {
      echo "LARM LAN network rollback post-check failed" >&2
      exit 1
    }
    mv -T -- "${applied_file}" "${applied_file/applied-/rolled-back-}"
    jq -n --arg confirmation "${expected}" --arg sourceCidr "${source_cidr}" \
      '{rolledBack:true,sourceCidr:$sourceCidr,confirmation:$confirmation}'
    ;;
  *)
    echo "usage: $0 [plan|apply|rollback-plan|rollback]" >&2
    exit 2
    ;;
esac
