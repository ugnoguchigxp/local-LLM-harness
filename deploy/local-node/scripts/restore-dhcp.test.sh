#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tool="${repo_root}/deploy/local-node/scripts/restore-dhcp.sh"
test_root="$(mktemp -d /tmp/larm-dhcp-test.XXXXXX)"
symlinked_root="${test_root}-symlink"
trap 'rm -rf -- "${test_root}"; rm -f -- "${symlinked_root}"' EXIT

prepare_overlay() {
  rm -rf -- "${test_root}/etc" "${test_root}/run"
  rm -f -- "${test_root}/apply.log"
  mkdir -p -- "${test_root}/etc/netplan" "${test_root}/run"
  cat >"${test_root}/etc/netplan/99-larm-static-ip.yaml" <<'EOF'
network:
  version: 2
  wifis:
    wlp195s0:
      dhcp4: false
      addresses:
        - 192.0.2.50/24
EOF
}

run_tool() {
  LARM_DHCP_TEST_MODE=1 LARM_DHCP_TEST_ROOT="${test_root}" bash "${tool}" "$@"
}

prepare_overlay
plan="$(run_tool plan)"
grep -Fq '(installed)' <<<"${plan}"
run_tool apply >/dev/null
[[ ! -e "${test_root}/etc/netplan/99-larm-static-ip.yaml" ]]
[[ ! -e "${test_root}/run/larm-static-ip-overlay.rollback.yaml" ]]
grep -Fx 'netplan generate' "${test_root}/apply.log" >/dev/null
grep -Fx 'netplan try --timeout 120' "${test_root}/apply.log" >/dev/null

prepare_overlay
if LARM_DHCP_TEST_FAIL=1 run_tool apply >/dev/null 2>&1; then
  echo "DHCP restore ignored failed connectivity validation" >&2
  exit 1
fi
[[ -f "${test_root}/etc/netplan/99-larm-static-ip.yaml" ]]
grep -Fx 'netplan apply' "${test_root}/apply.log" >/dev/null

prepare_overlay
sed -i 's/dhcp4: false/dhcp4: true/' "${test_root}/etc/netplan/99-larm-static-ip.yaml"
if run_tool apply >/dev/null 2>&1; then
  echo "DHCP restore removed an unrecognized overlay" >&2
  exit 1
fi
[[ -f "${test_root}/etc/netplan/99-larm-static-ip.yaml" ]]

ln -s / "${symlinked_root}"
if LARM_DHCP_TEST_MODE=1 LARM_DHCP_TEST_ROOT="${symlinked_root}" \
  bash "${tool}" plan >/dev/null 2>&1; then
  echo "DHCP restore accepted a symlinked test root" >&2
  exit 1
fi

echo "DHCP restore tests passed"
