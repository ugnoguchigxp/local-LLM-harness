#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tool="${repo_root}/deploy/gnosis/scripts/network-converge.sh"
test_root="$(mktemp -d /tmp/larm-network-test.XXXXXX)"
symlinked_root="${test_root}-symlink"
trap 'rm -rf -- "${test_root}"; rm -f -- "${symlinked_root}"' EXIT

write_safe_fixtures() {
  mkdir -p "${test_root}"
  cat >"${test_root}/ss.txt" <<'EOF'
LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:8081 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:8083 0.0.0.0:*
LISTEN 0 4096 127.0.0.1:8084 0.0.0.0:*
EOF
  cat >"${test_root}/ufw.txt" <<'EOF'
Status: active
To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    192.168.0.0/24
8080/tcp                   ALLOW IN    192.168.0.0/24
8081/tcp                   ALLOW IN    192.168.0.0/24
EOF
}

run_tool() {
  LARM_NETWORK_TEST_MODE=1 LARM_NETWORK_TEST_ROOT="${test_root}" bash "${tool}" "$@"
}

write_safe_fixtures
plan="$(run_tool plan)"
jq -e '.allowed == true and (.deleteRules | length == 2) and (.wildcardListeners | length == 0)' \
  <<<"${plan}" >/dev/null
confirmation="$(jq -er .confirmation <<<"${plan}")"
LARM_NETWORK_TEST_MODE=1 LARM_NETWORK_TEST_ROOT="${test_root}" \
  LARM_NETWORK_CONFIRM="${confirmation}" bash "${tool}" apply >/dev/null
[[ "$(wc -l <"${test_root}/apply.log")" -eq 2 ]]
grep -F 'port 8080 proto tcp' "${test_root}/apply.log" >/dev/null
grep -F 'port 8081 proto tcp' "${test_root}/apply.log" >/dev/null
! grep -F 'port 22 ' "${test_root}/apply.log" >/dev/null
[[ -f "${test_root}/state/before-${confirmation}.json" ]]
rm -- "${test_root}/state/before-${confirmation}.json"
ln -s /tmp "${test_root}/state/before-${confirmation}.json"
if LARM_NETWORK_TEST_MODE=1 LARM_NETWORK_TEST_ROOT="${test_root}" \
  LARM_NETWORK_CONFIRM="${confirmation}" bash "${tool}" apply >/dev/null 2>&1; then
  echo "network tool followed a symlinked state target" >&2
  exit 1
fi
rm -- "${test_root}/state/before-${confirmation}.json"

cat >"${test_root}/ss.txt" <<'EOF'
LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:*
EOF
cat >"${test_root}/ufw.txt" <<'EOF'
Status: active
To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    192.168.0.0/24
EOF
rollback_plan="$(LARM_NETWORK_ROLLBACK_CIDR=192.168.0.0/24 run_tool rollback-plan 8080)"
jq -e '.allowed == true and .port == 8080 and .cidr == "192.168.0.0/24"' \
  <<<"${rollback_plan}" >/dev/null
rollback_confirmation="$(jq -er .confirmation <<<"${rollback_plan}")"
LARM_NETWORK_TEST_MODE=1 LARM_NETWORK_TEST_ROOT="${test_root}" \
  LARM_NETWORK_ROLLBACK_CIDR=192.168.0.0/24 \
  LARM_NETWORK_ROLLBACK_CONFIRM="${rollback_confirmation}" \
  bash "${tool}" rollback 8080 >/dev/null
tail -n 1 "${test_root}/apply.log" | grep -F 'allow from 192.168.0.0/24 to any port 8080 proto tcp' >/dev/null

if LARM_NETWORK_ROLLBACK_CIDR=0.0.0.0/0 run_tool rollback-plan 8080 >/dev/null 2>&1; then
  echo "network rollback accepted an unrestricted CIDR" >&2
  exit 1
fi
if LARM_NETWORK_ROLLBACK_CIDR=192.168.0.0/24 run_tool rollback-plan 22 >/dev/null 2>&1; then
  echo "network rollback accepted a non-Provider port" >&2
  exit 1
fi

write_safe_fixtures
cat >>"${test_root}/ufw.txt" <<'EOF'
8084/tcp                   ALLOW IN    Anywhere
8083/tcp (v6)              ALLOW IN    Anywhere (v6)
EOF
jq -e '.allowed == false and (.blockers | index("unexpected_provider_allow_rule")) != null
  and (.unexpectedAllowRules | length == 2)' \
  <<<"$(run_tool plan)" >/dev/null

ln -s / "${symlinked_root}"
if LARM_NETWORK_TEST_MODE=1 LARM_NETWORK_TEST_ROOT="${symlinked_root}" \
  bash "${tool}" plan >/dev/null 2>&1; then
  echo "network tool accepted a symlinked test root" >&2
  exit 1
fi

echo "network convergence tests passed"
