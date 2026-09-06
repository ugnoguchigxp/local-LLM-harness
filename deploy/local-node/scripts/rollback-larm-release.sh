#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

test_mode="${LARM_RELEASE_ROLLBACK_TEST_MODE:-0}"
if [[ "${test_mode}" == "1" ]]; then
  release_root="${LARM_RELEASE_ROOT:?required in test mode}"
  current_link="${LARM_RELEASE_CURRENT:?required in test mode}"
  state_root="${LARM_RELEASE_STATE_ROOT:?required in test mode}"
else
  [[ "$(id -u)" -eq 0 ]] || { echo "release rollback must run as root" >&2; exit 1; }
  release_root=/srv/ai/apps/larm-releases
  current_link=/srv/ai/apps/larm-current
  state_root=/var/lib/larm/release-controller
fi

fail() { echo "$*" >&2; exit 1; }
for root in "${release_root}" "${state_root}"; do
  [[ -d "${root}" && ! -L "${root}" ]] || fail "release rollback root is missing or unsafe"
done
[[ -L "${current_link}" && -f "${state_root}/previous" && ! -L "${state_root}/previous" ]] \
  || fail "active or previous release pointer is unavailable"
exec 9>"${state_root}/activation.lock"
flock -n 9 || fail "another release convergence operation is running"

active="$(readlink -f -- "${current_link}")"
previous="$(cat "${state_root}/previous")"
for target in "${active}" "${previous}"; do
  [[ "${target}" == "${release_root}/"* && -d "${target}" && ! -L "${target}" \
    && -f "${target}/release-manifest.json" && ! -L "${target}/release-manifest.json" ]] \
    || fail "rollback target is outside the trusted release root"
  jq -e '
    (.schemaVersion == 1 or .schemaVersion == 2)
    and (.commit | type == "string" and test("^[a-f0-9]{40}$"))
    and (.configRevision | type == "string" and test("^[a-f0-9]{64}$"))
    and (.larmVersion | type == "string" and length > 0 and length <= 64)
  ' "${target}/release-manifest.json" >/dev/null || fail "release manifest is invalid"
done
[[ "${active}" != "${previous}" ]] || fail "previous release is already active"

systemctl_run() {
  if [[ "${test_mode}" == "1" ]]; then
    printf '%s\n' "$*" >>"${state_root}/systemctl.log"
    [[ "${LARM_RELEASE_TEST_FAIL_ROLLBACK:-0}" != "1" ]]
  else
    systemctl "$@"
  fi
}

verify_health() {
  local target="$1" commit revision version health ready
  commit="$(jq -er .commit "${target}/release-manifest.json")"
  revision="$(jq -er .configRevision "${target}/release-manifest.json")"
  version="$(jq -er .larmVersion "${target}/release-manifest.json")"
  if [[ "${test_mode}" == "1" ]]; then
    [[ "${LARM_RELEASE_TEST_FAIL_ROLLBACK_HEALTH:-0}" != "1" ]]
    return
  fi
  for _attempt in {1..30}; do
    if health="$(curl -fsS --max-time 3 http://127.0.0.1:9810/health 2>/dev/null)" \
      && ready="$(curl -fsS --max-time 3 http://127.0.0.1:9810/ready 2>/dev/null)" \
      && jq -e --arg commit "${commit}" --arg revision "${revision}" --arg version "${version}" \
        '.status == "ok" and .releaseCommit == $commit and .configRevision == $revision and .version == $version' \
        <<<"${health}" >/dev/null \
      && jq -e '.status == "ready"' <<<"${ready}" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

work="$(mktemp -d "${state_root}/.rollback.XXXXXX")"
trap 'rm -rf -- "${work}" "${current_link}.rollback.$$" "${current_link}.recovery.$$"' EXIT
rollback_link="${current_link}.rollback.$$"
ln -s -- "${previous}" "${rollback_link}"
mv -Tf -- "${rollback_link}" "${current_link}"
if ! systemctl_run restart larm-daemon.service || ! verify_health "${previous}"; then
  recovery="${current_link}.recovery.$$"
  ln -s -- "${active}" "${recovery}"
  mv -Tf -- "${recovery}" "${current_link}"
  systemctl_run restart larm-daemon.service || true
  fail "previous release failed verification; active release was restored"
fi
printf '%s\n' "${active}" >"${work}/previous"
chmod 0600 "${work}/previous"
mv -fT -- "${work}/previous" "${state_root}/previous"
if [[ -f "${state_root}/status.json" ]]; then
  observed="$(jq -er .commit "${previous}/release-manifest.json")"
  jq --arg observed "${observed}" --arg updatedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
    '.observedRelease = $observed | .stage = "activated" | .result = "failed" | .reason = "manual_rollback" | .updatedAt = $updatedAt' \
    "${state_root}/status.json" >"${work}/status.json"
  chmod 0644 "${work}/status.json"
  mv -fT -- "${work}/status.json" "${state_root}/status.json"
fi
trap - EXIT
rm -rf -- "${work}"
echo "rolled back LARM to $(basename "${previous}")"
