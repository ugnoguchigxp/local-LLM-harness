#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tool="${repo_root}/deploy/gnosis/scripts/configure-saaa-rest-access.sh"
prepare_host="${repo_root}/deploy/gnosis/scripts/prepare-host.sh"
test_root="$(mktemp -d /tmp/larm-saaa-network-test.XXXXXX)"
symlinked_root="${test_root}-symlink"
trap 'rm -rf -- "${test_root}"; rm -f -- "${symlinked_root}"' EXIT

write_fixture() {
  rm -rf -- "${test_root}/state"
  rm -f -- "${test_root}/apply.log"
  cat >"${test_root}/ufw.txt" <<'EOF'
Status: active
To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    192.168.0.0/24
8080/tcp                   ALLOW IN    192.168.0.0/24
EOF
}

run_tool() {
  SAAA_SOURCE_IPV4=192.168.0.76 \
    LARM_SAAA_NETWORK_TEST_MODE=1 \
    LARM_SAAA_NETWORK_TEST_ROOT="${test_root}" \
    bash "${tool}" "$@"
}

if grep -Eq '^[[:space:]]*ufw[[:space:]]' "${prepare_host}"; then
  echo "prepare-host.sh still mutates UFW" >&2
  exit 1
fi
if grep -Eq 'port[[:space:]]+22|LAN_CIDR' "${prepare_host}"; then
  echo "prepare-host.sh still stages an SSH or broad LAN rule" >&2
  exit 1
fi

write_fixture
plan="$(run_tool plan)"
jq -e '.allowed == true and .addRequired == true and .sourceCidr == "192.168.0.76/32"
  and (.gatewayAllowRules | length == 0)' <<<"${plan}" >/dev/null
confirmation="$(jq -er .confirmation <<<"${plan}")"
LARM_SAAA_NETWORK_CONFIRM="${confirmation}" run_tool apply >/dev/null
grep -E '^9810/tcp[[:space:]]+ALLOW IN[[:space:]]+192\.168\.0\.76$' \
  "${test_root}/ufw.txt" >/dev/null
grep -E '^22/tcp[[:space:]]+ALLOW IN[[:space:]]+192\.168\.0\.0/24$' \
  "${test_root}/ufw.txt" >/dev/null
grep -F 'allow from 192.168.0.76 to any port 9810 proto tcp' "${test_root}/apply.log" >/dev/null
[[ -f "${test_root}/state/applied-192_168_0_76.json" ]]

converged="$(run_tool plan)"
jq -e '.allowed == true and .addRequired == false and .exactRuleCount == 1' <<<"${converged}" >/dev/null

rollback_plan="$(run_tool rollback-plan)"
jq -e '.allowed == true and .exactRuleCount == 1' <<<"${rollback_plan}" >/dev/null
rollback_confirmation="$(jq -er .confirmation <<<"${rollback_plan}")"
LARM_SAAA_NETWORK_ROLLBACK_CONFIRM="${rollback_confirmation}" run_tool rollback >/dev/null
! grep -E '^9810/tcp[[:space:]]+ALLOW IN[[:space:]]+192\.168\.0\.76$' \
  "${test_root}/ufw.txt" >/dev/null
grep -E '^22/tcp[[:space:]]+ALLOW IN[[:space:]]+192\.168\.0\.0/24$' \
  "${test_root}/ufw.txt" >/dev/null
[[ -f "${test_root}/state/rolled-back-192_168_0_76-${rollback_confirmation}.json" ]]

write_fixture
cat >>"${test_root}/ufw.txt" <<'EOF'
9810/tcp                   ALLOW       192.168.0.76
EOF
jq -e '.allowed == true and .addRequired == false and .exactRuleCount == 1
  and (.gatewayAllowRules | length == 1)' <<<"$(run_tool plan)" >/dev/null

write_fixture
plan="$(run_tool plan)"
if LARM_SAAA_NETWORK_CONFIRM=wrong run_tool apply >/dev/null 2>&1; then
  echo "SAAA network tool accepted the wrong confirmation" >&2
  exit 1
fi
[[ ! -e "${test_root}/apply.log" ]]

write_fixture
plan="$(run_tool plan)"
confirmation="$(jq -er .confirmation <<<"${plan}")"
if LARM_SAAA_NETWORK_TEST_FAIL=1 LARM_SAAA_NETWORK_CONFIRM="${confirmation}" \
  run_tool apply >/dev/null 2>&1; then
  echo "SAAA network tool ignored an injected UFW failure" >&2
  exit 1
fi
! grep -E '^9810/tcp[[:space:]]+ALLOW IN' "${test_root}/ufw.txt" >/dev/null
[[ ! -e "${test_root}/state/applied-192_168_0_76.json" ]]

write_fixture
sed -i 's/Status: active/Status: inactive/' "${test_root}/ufw.txt"
jq -e '.allowed == false and (.blockers | index("ufw_not_active")) != null' \
  <<<"$(run_tool plan)" >/dev/null

write_fixture
cat >>"${test_root}/ufw.txt" <<'EOF'
9810/tcp                   ALLOW IN    192.168.0.0/24
EOF
jq -e '.allowed == false and (.blockers | index("unexpected_gateway_rule")) != null' \
  <<<"$(run_tool plan)" >/dev/null

write_fixture
cat >>"${test_root}/ufw.txt" <<'EOF'
9810/tcp (v6)              ALLOW IN    Anywhere (v6)
EOF
jq -e '.allowed == false and (.blockers | index("unexpected_gateway_rule")) != null
  and (.unexpectedRules | length == 1)' <<<"$(run_tool plan)" >/dev/null

write_fixture
cat >>"${test_root}/ufw.txt" <<'EOF'
9810/tcp                   ALLOW IN    192.168.0.76/32
9810/tcp                   ALLOW IN    192.168.0.76/32
EOF
jq -e '.allowed == false and (.blockers | index("duplicate_saaa_rule")) != null' \
  <<<"$(run_tool plan)" >/dev/null

for invalid in '' 192.168.0.0/24 192.168.000.76 127.0.0.1 224.0.0.1 999.1.1.1; do
  if SAAA_SOURCE_IPV4="${invalid}" LARM_SAAA_NETWORK_TEST_MODE=1 \
    LARM_SAAA_NETWORK_TEST_ROOT="${test_root}" bash "${tool}" plan >/dev/null 2>&1; then
    echo "SAAA network tool accepted invalid source: ${invalid}" >&2
    exit 1
  fi
done

ln -s / "${symlinked_root}"
if SAAA_SOURCE_IPV4=192.168.0.76 LARM_SAAA_NETWORK_TEST_MODE=1 \
  LARM_SAAA_NETWORK_TEST_ROOT="${symlinked_root}" bash "${tool}" plan >/dev/null 2>&1; then
  echo "SAAA network tool accepted a symlinked test root" >&2
  exit 1
fi

echo "SAAA REST network configuration tests passed"
