#!/usr/bin/env bash
set -Eeuo pipefail

readonly interface="${LARM_NETWORK_INTERFACE:-wlp195s0}"
readonly test_mode="${LARM_DHCP_TEST_MODE:-0}"
test_root="${LARM_DHCP_TEST_ROOT:-}"

if [[ "${test_mode}" == "1" ]]; then
  [[ "${test_root}" == /* && "${test_root}" != "/" && -d "${test_root}" && ! -L "${test_root}" ]] || {
    printf 'LARM_DHCP_TEST_ROOT must be an existing absolute non-symlink directory.\n' >&2
    exit 1
  }
  test_root="$(realpath -e -- "${test_root}")"
  legacy_overlay="${test_root}/etc/netplan/99-larm-static-ip.yaml"
  rollback_copy="${test_root}/run/larm-static-ip-overlay.rollback.yaml"
else
  legacy_overlay="/etc/netplan/99-larm-static-ip.yaml"
  rollback_copy="/run/larm-static-ip-overlay.rollback.yaml"
fi
readonly legacy_overlay rollback_copy

ip_run() {
  if [[ "${test_mode}" != "1" ]]; then
    ip "$@"
    return
  fi
  case "$*" in
    "-4 -brief address show dev ${interface}")
      printf '%s UP 192.0.2.50/24\n' "${interface}"
      ;;
    "-4 -o address show dev ${interface}")
      printf '2: %s inet 192.0.2.50/24 brd 192.0.2.255 scope global dynamic %s\n' \
        "${interface}" "${interface}"
      ;;
    "-4 route show default dev ${interface}")
      printf 'default via 192.0.2.1 dev %s proto dhcp metric 600\n' "${interface}"
      ;;
    *)
      printf 'unexpected test ip invocation: %s\n' "$*" >&2
      return 1
      ;;
  esac
}

netplan_run() {
  if [[ "${test_mode}" == "1" ]]; then
    printf 'netplan %s\n' "$*" >>"${test_root}/apply.log"
  else
    netplan "$@"
  fi
}

ping_run() {
  if [[ "${test_mode}" == "1" ]]; then
    [[ "${LARM_DHCP_TEST_FAIL:-0}" != "1" ]]
  else
    ping "$@"
  fi
}

usage() {
  cat <<'EOF'
Usage: restore-dhcp.sh plan|apply

  plan   Show whether the legacy LARM static-address overlay is installed.
  apply  Remove that overlay with an attended netplan try and verify DHCP.
EOF
}

show_state() {
  printf 'Interface: %s\n' "${interface}"
  printf 'Legacy overlay: %s (%s)\n' "${legacy_overlay}" \
    "$([[ -e "${legacy_overlay}" ]] && printf installed || printf absent)"
  ip_run -4 -brief address show dev "${interface}" || true
  ip_run -4 route show default dev "${interface}" || true
}

dhcp_ready() {
  local gateway
  ip_run -4 -o address show dev "${interface}" | grep -Eq ' scope global .*dynamic ' || return 1
  ip_run -4 route show default dev "${interface}" | grep -Fq ' proto dhcp ' || return 1
  gateway="$(ip_run -4 route show default dev "${interface}" \
    | awk '$1 == "default" && $2 == "via" { print $3; exit }')"
  [[ -n "${gateway}" ]] || return 1
  ping_run -c 1 -W 2 -I "${interface}" "${gateway}" >/dev/null
}

apply_dhcp() {
  [[ "${test_mode}" == "1" || "${EUID}" -eq 0 ]] || {
    printf 'Run apply with sudo.\n' >&2
    exit 1
  }
  if [[ ! -e "${legacy_overlay}" ]]; then
    printf 'Legacy LARM static-address overlay is already absent.\n'
    dhcp_ready
    return
  fi
  [[ -f "${legacy_overlay}" && ! -L "${legacy_overlay}" ]] || {
    printf 'Refusing unsafe legacy overlay: %s\n' "${legacy_overlay}" >&2
    exit 1
  }
  [[ ! -e "${rollback_copy}" ]] || {
    printf 'Refusing to replace rollback copy: %s\n' "${rollback_copy}" >&2
    exit 1
  }
  grep -Fq "${interface}:" "${legacy_overlay}" \
    && grep -Fq 'dhcp4: false' "${legacy_overlay}" || {
      printf 'Refusing to remove an unrecognized Netplan file: %s\n' "${legacy_overlay}" >&2
      exit 1
    }

  mv -- "${legacy_overlay}" "${rollback_copy}"
  restore_overlay() {
    mv -- "${rollback_copy}" "${legacy_overlay}" 2>/dev/null || true
    netplan_run apply || true
  }
  trap restore_overlay EXIT HUP INT TERM

  netplan_run generate
  printf 'The legacy overlay is staged for removal. Confirm netplan try only if connectivity remains healthy.\n'
  netplan_run try --timeout 120
  dhcp_ready || {
    printf 'DHCP validation failed; restoring the legacy overlay.\n' >&2
    exit 1
  }

  trap - EXIT HUP INT TERM
  rm -- "${rollback_copy}"
  printf 'Legacy static-address overlay removed; DHCP address, route, and gateway are healthy.\n'
}

case "${1:-}" in
  plan)
    show_state
    ;;
  apply)
    show_state
    apply_dhcp
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
