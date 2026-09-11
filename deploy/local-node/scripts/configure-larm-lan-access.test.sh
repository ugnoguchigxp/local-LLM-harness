#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tool="${repo_root}/deploy/local-node/scripts/configure-larm-lan-access.sh"
test_root="$(mktemp -d /tmp/larm-lan-network-test.XXXXXX)"
symlinked_root="${test_root}-symlink"
trap 'rm -rf -- "${test_root}"; rm -f -- "${symlinked_root}"' EXIT

write_fixtures() {
  rm -rf -- "${test_root}/state"
  rm -f -- "${test_root}/apply.log"
  cat >"${test_root}/routes.json" <<'EOF'
[{"dst":"default","gateway":"10.42.6.1","dev":"wifi-test","protocol":"dhcp","metric":600}]
EOF
  cat >"${test_root}/addresses.json" <<'EOF'
[
  {"ifname":"lo","operstate":"UNKNOWN","addr_info":[{"family":"inet","local":"127.0.0.1","prefixlen":8,"scope":"host"}]},
  {"ifname":"wifi-test","operstate":"UP","addr_info":[{"family":"inet","local":"10.42.7.9","prefixlen":23,"scope":"global"}]}
]
EOF
  cat >"${test_root}/ufw.txt" <<'EOF'
Status: active
To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    10.42.6.0/23
9810/tcp                   ALLOW IN    10.42.6.76/32
EOF
}

run_tool() {
  LARM_LAN_NETWORK_TEST_MODE=1 \
    LARM_LAN_NETWORK_TEST_ROOT="${test_root}" \
    bash "${tool}" "$@"
}

write_fixtures
plan="$(run_tool plan)"
jq -e '.allowed == true and .addRequired == true
  and .interface == "wifi-test" and .address == "10.42.7.9"
  and .prefixLength == 23 and .sourceCidr == "10.42.6.0/23"
  and (.existingSpecificAllowRules | length == 1)' <<<"${plan}" >/dev/null
confirmation="$(jq -er .confirmation <<<"${plan}")"
LARM_LAN_NETWORK_CONFIRM="${confirmation}" run_tool apply >/dev/null
grep -E '^9810/tcp[[:space:]]+ALLOW IN[[:space:]]+10\.42\.6\.0/23$' \
  "${test_root}/ufw.txt" >/dev/null
grep -F 'allow from 10.42.6.0/23 to any port 9810 proto tcp' "${test_root}/apply.log" >/dev/null

converged="$(run_tool plan)"
jq -e '.allowed == true and .addRequired == false and .exactRuleCount == 1' \
  <<<"${converged}" >/dev/null
converged_confirmation="$(jq -er .confirmation <<<"${converged}")"
jq -e '.applied == true and .added == false and .sourceCidr == "10.42.6.0/23"' \
  <<<"$(LARM_LAN_NETWORK_CONFIRM="${converged_confirmation}" run_tool apply)" >/dev/null

rollback_plan="$(run_tool rollback-plan)"
jq -e '.allowed == true and .sourceCidr == "10.42.6.0/23" and .exactRuleCount == 1' \
  <<<"${rollback_plan}" >/dev/null
rollback_confirmation="$(jq -er .confirmation <<<"${rollback_plan}")"
LARM_LAN_NETWORK_ROLLBACK_CONFIRM="${rollback_confirmation}" run_tool rollback >/dev/null
! grep -E '^9810/tcp[[:space:]]+ALLOW IN[[:space:]]+10\.42\.6\.0/23$' \
  "${test_root}/ufw.txt" >/dev/null
grep -E '^9810/tcp[[:space:]]+ALLOW IN[[:space:]]+10\.42\.6\.76/32$' \
  "${test_root}/ufw.txt" >/dev/null

write_fixtures
plan="$(run_tool plan)"
confirmation="$(jq -er .confirmation <<<"${plan}")"
if LARM_LAN_NETWORK_CONFIRM=wrong run_tool apply >/dev/null 2>&1; then
  echo "LAN network tool accepted the wrong confirmation" >&2
  exit 1
fi
[[ ! -e "${test_root}/apply.log" ]]

if LARM_LAN_NETWORK_TEST_FAIL=1 LARM_LAN_NETWORK_CONFIRM="${confirmation}" \
  run_tool apply >/dev/null 2>&1; then
  echo "LAN network tool ignored an injected UFW failure" >&2
  exit 1
fi
! grep -E '^9810/tcp[[:space:]]+ALLOW IN[[:space:]]+10\.42\.6\.0/23$' \
  "${test_root}/ufw.txt" >/dev/null

write_fixtures
sed -i 's/Status: active/Status: inactive/' "${test_root}/ufw.txt"
jq -e '.allowed == false and (.blockers | index("ufw_not_active")) != null' \
  <<<"$(run_tool plan)" >/dev/null

write_fixtures
cat >>"${test_root}/ufw.txt" <<'EOF'
9810/tcp                   ALLOW IN    Anywhere
EOF
jq -e '.allowed == false and (.blockers | index("unexpected_gateway_rule")) != null' \
  <<<"$(run_tool plan)" >/dev/null

write_fixtures
cat >>"${test_root}/ufw.txt" <<'EOF'
9810                       ALLOW IN    10.42.6.0/23
EOF
jq -e '.allowed == false and (.blockers | index("unexpected_gateway_rule")) != null' \
  <<<"$(run_tool plan)" >/dev/null

write_fixtures
cat >"${test_root}/routes.json" <<'EOF'
[
  {"dst":"default","gateway":"10.42.6.1","dev":"wifi-test","metric":600},
  {"dst":"default","gateway":"172.20.0.1","dev":"ethernet-test","metric":100}
]
EOF
if run_tool plan >/dev/null 2>&1; then
  echo "LAN discovery accepted multiple default-route interfaces" >&2
  exit 1
fi
jq -e '.interface == "wifi-test" and .sourceCidr == "10.42.6.0/23"' \
  <<<"$(LARM_LAN_INTERFACE=wifi-test run_tool plan)" >/dev/null

write_fixtures
sed -i 's/10\.42\.7\.9/203.0.113.9/' "${test_root}/addresses.json"
if run_tool plan >/dev/null 2>&1; then
  echo "LAN discovery accepted a non-RFC1918 address" >&2
  exit 1
fi

ln -s / "${symlinked_root}"
if LARM_LAN_NETWORK_TEST_MODE=1 LARM_LAN_NETWORK_TEST_ROOT="${symlinked_root}" \
  bash "${tool}" plan >/dev/null 2>&1; then
  echo "LAN network tool accepted a symlinked test root" >&2
  exit 1
fi

echo "LARM LAN network configuration tests passed"
