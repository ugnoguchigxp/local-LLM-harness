#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

action="${1:-plan}"
source_root="${LARM_RELEASE_SOURCE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
release_root="${LARM_RELEASE_ROOT:-/srv/ai/apps/larm-releases}"
current_link="${LARM_RELEASE_CURRENT:-/srv/ai/apps/larm-current}"
state_root="${LARM_RELEASE_STATE_ROOT:-/var/lib/larm/releases}"
release_ref="${LARM_RELEASE_REF:-HEAD}"
keep="${LARM_RELEASE_KEEP:-3}"
test_mode="${LARM_RELEASE_TEST_MODE:-0}"

fail() { echo "$*" >&2; exit 1; }
[[ "${action}" =~ ^(plan|apply|rollback|cleanup)$ ]] || fail "usage: $0 plan|apply|rollback|cleanup"
[[ "${keep}" =~ ^([2-9]|[1-9][0-9])$ ]] || fail "LARM_RELEASE_KEEP must be between 2 and 99"
[[ "${source_root}" == /* && "${release_root}" == /* && "${current_link}" == /* && "${state_root}" == /* ]] \
  || fail "release paths must be absolute"
for path in "${release_root}" "${current_link}" "${state_root}"; do
  [[ "${path}" != "/" ]] || fail "filesystem root is not a valid release path"
done
[[ ! -L "${release_root}" && ! -L "${state_root}" ]] || fail "release and state roots must not be symlinks"
[[ "$(realpath -sm -- "${release_root}")" == "$(realpath -m -- "${release_root}")" \
  && "$(realpath -sm -- "${state_root}")" == "$(realpath -m -- "${state_root}")" \
  && "$(realpath -sm -- "$(dirname "${current_link}")")" == "$(realpath -m -- "$(dirname "${current_link}")")" ]] \
  || fail "release paths must not traverse symlinked path components"
release_root="$(realpath -sm -- "${release_root}")"
state_root="$(realpath -sm -- "${state_root}")"
current_link="$(realpath -sm -- "${current_link}")"
[[ -d "${source_root}/.git" && ! -L "${source_root}" ]] || fail "source must be a real Git worktree"
source_root="$(realpath -e -- "${source_root}")"
commit="$(git -C "${source_root}" rev-parse --verify "${release_ref}^{commit}")"
short="${commit:0:12}"
release_dir="${release_root}/${short}"

current_release() {
  local active
  if [[ -L "${current_link}" ]]; then
    active="$(readlink -f -- "${current_link}" 2>/dev/null || true)"
    [[ "${active}" == "${release_root}/"* && -d "${active}" && ! -L "${active}" ]] \
      || fail "current release pointer is broken or leaves the release root"
    [[ "$(basename "${active}")" =~ ^[a-f0-9]{12}$ ]] \
      || fail "current release pointer does not name a versioned release"
    printf '%s\n' "${active}"
  elif [[ -e "${current_link}" ]]; then
    fail "current release path must be absent or a safe symlink"
  fi
}

current_release_name() {
  local active
  active="$(current_release)"
  if [[ -n "${active}" ]]; then
    basename "${active}"
  else
    printf 'none\n'
  fi
}

systemctl_run() {
  if [[ "${test_mode}" == "1" ]]; then
    printf '%s\n' "$*" >>"${state_root}/systemctl.log"
  else
    systemctl "$@"
  fi
}

validate_release_manifest() {
  local target="$1"
  [[ -f "${target}/release-manifest.json" && ! -L "${target}/release-manifest.json" ]] || return 1
  jq -e '
    keys == ["bunVersion","commit","configRevision","createdAt","larmVersion","lockfileSha256","nodeModulesSha256","schemaVersion"]
    and .schemaVersion == 1
    and (.commit | type == "string" and test("^[a-f0-9]{40}$"))
    and (.larmVersion | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$"))
    and (.bunVersion | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$"))
    and (.lockfileSha256 | type == "string" and test("^[a-f0-9]{64}$"))
    and (.nodeModulesSha256 | type == "string" and test("^[a-f0-9]{64}$"))
    and (.configRevision | type == "string" and test("^[a-f0-9]{64}$"))
    and (.createdAt | type == "string"
      and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
      and (fromdateiso8601 | type == "number"))
  ' "${target}/release-manifest.json" >/dev/null
}

node_modules_digest() {
  local target="$1" modules
  modules="${target}/node_modules"
  [[ -d "${modules}" && ! -L "${modules}" ]] || return 1
  if find -P "${modules}" -mindepth 1 ! \( -type d -o -type f -o -type l \) -print -quit | grep -q .; then
    return 1
  fi
  (
    cd "${modules}"
    printf 'd\0.\0%s\0' "$(stat -c '%a' -- .)"
    while IFS= read -r -d '' entry; do
      if [[ -L "${entry}" ]]; then
        printf 'l\0%s\0%s\0' "${entry}" "$(stat -c '%a' -- "${entry}")"
        readlink -z -- "${entry}"
      elif [[ -d "${entry}" ]]; then
        printf 'd\0%s\0%s\0' "${entry}" "$(stat -c '%a' -- "${entry}")"
      else
        printf 'f\0%s\0%s\0' "${entry}" "$(stat -c '%a' -- "${entry}")"
        sha256sum -- "${entry}" | awk '{printf "%s%c", $1, 0}'
      fi
    done < <(find -P . -mindepth 1 \( -type d -o -type f -o -type l \) -print0 | sort -z)
  ) | sha256sum | awk '{print $1}'
}

verify_release_source() {
  local target="$1" release_commit="$2" comparison differences expected_difference
  comparison="$(mktemp -d "${release_root}/.verify-${short}.XXXXXX")"
  if git -C "${source_root}" archive "${release_commit}" | tar -x -C "${comparison}"; then
    differences="$(diff -qr --exclude=node_modules -- "${comparison}" "${target}" || true)"
    expected_difference="Only in ${target}: release-manifest.json"
    if [[ "${differences}" == "${expected_difference}" ]]; then
      rm -rf -- "${comparison}"
      return 0
    fi
  fi
  rm -rf -- "${comparison}"
  return 1
}

validate_release_payload() {
  local target="$1" manifest_commit expected_lock actual_lock expected_modules actual_modules
  local expected_version actual_version expected_revision actual_revision
  validate_release_manifest "${target}" || return 1
  manifest_commit="$(jq -er .commit "${target}/release-manifest.json")" || return 1
  expected_lock="$(jq -er .lockfileSha256 "${target}/release-manifest.json")" || return 1
  expected_modules="$(jq -er .nodeModulesSha256 "${target}/release-manifest.json")" || return 1
  [[ -f "${target}/bun.lock" && ! -L "${target}/bun.lock" ]] || return 1
  actual_lock="$(sha256sum "${target}/bun.lock" | awk '{print $1}')" || return 1
  [[ "${actual_lock}" == "${expected_lock}" ]] || return 1
  actual_modules="$(node_modules_digest "${target}")" || return 1
  [[ "${actual_modules}" == "${expected_modules}" ]] || return 1
  verify_release_source "${target}" "${manifest_commit}" || return 1
  expected_version="$(jq -er .larmVersion "${target}/release-manifest.json")" || return 1
  actual_version="$(sed -n 's/^export const LARM_VERSION = "\([^"]*\)".*/\1/p' "${target}/packages/core/src/version.ts")"
  [[ "${actual_version}" == "${expected_version}" ]] || return 1
  expected_revision="$(jq -er .configRevision "${target}/release-manifest.json")" || return 1
  if [[ "${test_mode}" == "1" && "${expected_revision}" == "$(printf '0%.0s' {1..64})" ]]; then
    return 0
  fi
  actual_revision="$(cd "${target}" && bun run apps/daemon/src/print-config-revision.ts)" || return 1
  [[ "${actual_revision}" == "${expected_revision}" ]]
}

verify_release_health() {
  local target="$1" deadline health expected_commit expected_version expected_revision active
  validate_release_manifest "${target}" || return 1
  expected_commit="$(jq -er .commit "${target}/release-manifest.json")"
  expected_version="$(jq -er .larmVersion "${target}/release-manifest.json")"
  expected_revision="$(jq -er .configRevision "${target}/release-manifest.json")"
  if [[ "${test_mode}" == "1" ]]; then
    [[ "$(basename "${target}")" != "${LARM_RELEASE_TEST_UNHEALTHY_RELEASE:-}" ]] || return 1
    active="$(current_release)"
    [[ "${active}" == "${target}" ]] || return 1
    health="$(jq -n --arg commit "$(jq -er .commit "${active}/release-manifest.json")" \
      --arg version "$(jq -er .larmVersion "${active}/release-manifest.json")" \
      --arg revision "$(jq -er .configRevision "${active}/release-manifest.json")" \
      '{status:"ok",releaseCommit:$commit,version:$version,configRevision:$revision}')"
    jq -e --arg commit "${expected_commit}" --arg version "${expected_version}" --arg revision "${expected_revision}" \
      '.status == "ok" and .releaseCommit == $commit and .version == $version and .configRevision == $revision' \
      <<<"${health}" >/dev/null
    return
  fi
  deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    if health="$(curl -fsS --max-time 3 http://127.0.0.1:9810/health 2>/dev/null)" \
      && jq -e --arg commit "${expected_commit}" --arg version "${expected_version}" --arg revision "${expected_revision}" \
        '.status == "ok" and .releaseCommit == $commit and .version == $version and .configRevision == $revision' \
        <<<"${health}" >/dev/null \
      && curl -fsS --max-time 3 http://127.0.0.1:9810/ready >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

release_dirs() {
  [[ -d "${release_root}" ]] || return 0
  find "${release_root}" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/[0-9a-f]{12}' -printf '%T@ %f\n' \
    | sort -rn | awk '{print $2}'
}

cleanup_candidates() {
  local mode="${1:-current}" current_name previous_name protected_count=0 retained=0 retain_nonprotected
  if [[ "${mode}" == "projected" && ! -e "${release_dir}" && ! -L "${release_dir}" ]]; then
    current_name="${short}"
    previous_name="$(current_release_name)"
  else
    current_name="$(current_release_name)"
    previous_name="$(basename "$(cat "${state_root}/previous" 2>/dev/null || printf /none)")"
  fi
  if [[ "${current_name}" != "none" ]] && (
    [[ "${mode}" == "projected" && "${current_name}" == "${short}" ]] \
      || [[ -d "${release_root}/${current_name}" ]]
  ); then
    protected_count=$((protected_count + 1))
  fi
  if [[ "${previous_name}" != "none" && "${previous_name}" != "${current_name}" \
    && -d "${release_root}/${previous_name}" ]]; then
    protected_count=$((protected_count + 1))
  fi
  retain_nonprotected=$((keep - protected_count))
  {
    if [[ "${mode}" == "projected" && ! -e "${release_dir}" && ! -L "${release_dir}" ]]; then
      printf '%s\n' "${short}"
    fi
    release_dirs
  } |
  while read -r name; do
    [[ -n "${name}" ]] || continue
    if [[ "${name}" == "${current_name}" || "${name}" == "${previous_name}" ]]; then
      continue
    fi
    if ((retained < retain_nonprotected)); then
      retained=$((retained + 1))
    else
      printf '%s\n' "${name}"
    fi
  done
}

cleanup_digest() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

remove_cleanup_candidates() {
  local candidates="$1" mode="${2:-current}" current_name previous_name
  if [[ "${mode}" == "projected" ]]; then
    current_name="${short}"
    previous_name="$(current_release_name)"
  else
    current_name="$(current_release_name)"
    previous_name="$(basename "$(cat "${state_root}/previous" 2>/dev/null || printf /none)")"
  fi
  while read -r name; do
    [[ -n "${name}" ]] || continue
    [[ "${name}" =~ ^[0-9a-f]{12}$ ]] || fail "invalid cleanup target ${name}"
    [[ "${name}" != "${current_name}" && "${name}" != "${previous_name}" ]] \
      || fail "cleanup target became active or rollback-protected: ${name}"
    rm -rf -- "${release_root:?}/${name}"
  done <<<"${candidates}"
}

write_previous() {
  local target="$1"
  printf '%s\n' "${target}" >"${state_root}/previous.tmp"
  mv -f "${state_root}/previous.tmp" "${state_root}/previous"
}

restore_previous() {
  local target="$1" existed="$2"
  if [[ "${existed}" == "1" ]]; then
    write_previous "${target}"
  else
    rm -f -- "${state_root}/previous" "${state_root}/previous.tmp"
  fi
}

if [[ "${action}" == "plan" ]]; then
  current="$(current_release)"
  candidates="$(cleanup_candidates projected)"
  confirmation="$([[ -n "${candidates}" ]] && cleanup_digest "${candidates}" || true)"
  jq -n --arg action apply --arg commit "${commit}" --arg target "${release_dir}" \
    --arg current "${current}" --argjson dirty "$([[ -n "$(git -C "${source_root}" status --porcelain=v1 --untracked-files=normal)" ]] && echo true || echo false)" \
    --arg cleanup "$(paste -sd, <<<"${candidates}")" --arg confirmation "${confirmation}" \
    '{action:$action,commit:$commit,target:$target,current:($current|if length>0 then . else null end),dirty:$dirty,cleanupCandidates:($cleanup|if length>0 then split(",") else [] end),cleanupConfirm:($confirmation|if length>0 then . else null end)}'
  exit 0
fi

if [[ "${test_mode}" != "1" && "$(id -u)" -ne 0 ]]; then
  fail "run release mutations with sudo"
fi
if [[ "${test_mode}" == "1" ]]; then
  install -d -m 0755 "${release_root}" "$(dirname "${current_link}")"
  install -d -m 0700 "${state_root}"
else
  install -d -o root -g root -m 0755 "${release_root}"
  install -d -m 0755 "$(dirname "${current_link}")"
  install -d -o root -g root -m 0700 "${state_root}"
fi
exec 9>"${state_root}/release.lock"
flock -n 9 || fail "another LARM release operation is running"

if [[ "${action}" == "cleanup" ]]; then
  candidates="$(cleanup_candidates)"
  digest="$(cleanup_digest "${candidates}")"
  [[ -n "${candidates}" ]] || { echo "no release cleanup candidates"; exit 0; }
  [[ "${LARM_RELEASE_CLEANUP_CONFIRM:-}" == "${digest}" ]] \
    || fail "cleanup confirmation required: LARM_RELEASE_CLEANUP_CONFIRM=${digest} targets=$(paste -sd, <<<"${candidates}")"
  remove_cleanup_candidates "${candidates}"
  echo "release cleanup completed"
  exit 0
fi

if [[ "${action}" == "rollback" ]]; then
  previous="$(cat "${state_root}/previous" 2>/dev/null || true)"
  [[ "${previous}" == "${release_root}/"* && -d "${previous}" && ! -L "${previous}" ]] \
    || fail "no safe previous release is available"
  validate_release_payload "${previous}" || fail "previous release payload failed integrity verification"
  active="$(current_release)"
  [[ -n "${active}" ]] || fail "no active release is available to roll back"
  [[ "${active}" != "${previous}" ]] || fail "previous release is already active"
  temp_link="${current_link}.rollback.$$"
  ln -s -- "${previous}" "${temp_link}"
  mv -Tf -- "${temp_link}" "${current_link}"
  write_previous "${active}"
  systemctl_run restart larm-daemon.service
  if ! verify_release_health "${previous}"; then
    if [[ "${active}" == "${release_root}/"* && -d "${active}" ]]; then
      recovery="${current_link}.recovery.$$"
      ln -s -- "${active}" "${recovery}"
      mv -Tf -- "${recovery}" "${current_link}"
      write_previous "${previous}"
      systemctl_run restart larm-daemon.service
      verify_release_health "${active}" || true
    fi
    fail "rolled-back LARM release failed identity or readiness verification"
  fi
  echo "rolled back LARM to $(basename "${previous}")"
  exit 0
fi

apply_cleanup_candidates="$(cleanup_candidates projected)"
if [[ -n "${apply_cleanup_candidates}" ]]; then
  apply_cleanup_digest="$(cleanup_digest "${apply_cleanup_candidates}")"
  [[ "${LARM_RELEASE_CLEANUP_CONFIRM:-}" == "${apply_cleanup_digest}" ]] \
    || fail "bounded retention requires reviewed cleanup: LARM_RELEASE_CLEANUP_CONFIRM=${apply_cleanup_digest} targets=$(paste -sd, <<<"${apply_cleanup_candidates}")"
fi

[[ -z "$(git -C "${source_root}" status --porcelain=v1 --untracked-files=normal)" ]] \
  || fail "source worktree is dirty"
if [[ -e "${release_dir}" || -L "${release_dir}" ]]; then
  [[ -d "${release_dir}" && ! -L "${release_dir}" ]] || fail "existing release target is unsafe"
  validate_release_payload "${release_dir}" || fail "existing release payload failed integrity verification"
  jq -e --arg commit "${commit}" '.commit == $commit' "${release_dir}/release-manifest.json" >/dev/null \
    || fail "existing release manifest does not match commit"
else
  staging="$(mktemp -d "${release_root}/.staging-${short}.XXXXXX")"
  trap 'rm -rf -- "${staging:-}" "${current_link}.next.$$"' EXIT
  chmod 0755 -- "${staging}"
  git -C "${source_root}" archive "${commit}" | tar -x -C "${staging}"
  lock_digest="$(sha256sum "${staging}/bun.lock" | awk '{print $1}')"
  if [[ "${LARM_RELEASE_SKIP_GATE:-0}" != "1" ]]; then
    (cd "${staging}" && bun install --frozen-lockfile && bun run check)
    config_revision="$(cd "${staging}" && bun run apps/daemon/src/print-config-revision.ts)"
  elif [[ "${test_mode}" != "1" ]]; then
    fail "LARM_RELEASE_SKIP_GATE is restricted to test mode"
  else
    config_revision="$(printf '0%.0s' {1..64})"
    install -d -m 0755 -- "${staging}/node_modules"
  fi
  [[ "${LARM_RELEASE_FAIL_AFTER_ARCHIVE:-0}" != "1" || "${test_mode}" != "1" ]] \
    || fail "injected release failure"
  larm_version="$(sed -n 's/^export const LARM_VERSION = "\([^"]*\)".*/\1/p' "${staging}/packages/core/src/version.ts")"
  [[ "${larm_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ \
    && "${config_revision}" =~ ^[a-f0-9]{64}$ ]] \
    || fail "release identity metadata is invalid"
  [[ ! -e "${staging}/release-manifest.json" && ! -L "${staging}/release-manifest.json" ]] \
    || fail "release-manifest.json is a reserved generated path"
  node_modules_sha256="$(node_modules_digest "${staging}")" \
    || fail "installed node_modules tree contains an unsafe entry"
  jq -n --arg commit "${commit}" --arg version "${larm_version}" --arg bunVersion "$(bun --version)" \
    --arg configRevision "${config_revision}" \
    --arg lockfileSha256 "${lock_digest}" --arg nodeModulesSha256 "${node_modules_sha256}" \
    --arg createdAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion:1,commit:$commit,larmVersion:$version,bunVersion:$bunVersion,lockfileSha256:$lockfileSha256,nodeModulesSha256:$nodeModulesSha256,configRevision:$configRevision,createdAt:$createdAt}' \
    >"${staging}/.release-manifest.json.tmp"
  chmod 0644 -- "${staging}/.release-manifest.json.tmp"
  mv -- "${staging}/.release-manifest.json.tmp" "${staging}/release-manifest.json"
  [[ ! -e "${release_dir}" && ! -L "${release_dir}" ]] || fail "release target appeared during assembly"
  mv -T -- "${staging}" "${release_dir}"
fi
validate_release_payload "${release_dir}" || fail "assembled release payload failed integrity verification"

previous="$(current_release)"
previous_state_existed=0
[[ ! -f "${state_root}/previous" ]] || previous_state_existed=1
previous_state="$(cat "${state_root}/previous" 2>/dev/null || true)"
next_link="${current_link}.next.$$"
ln -s -- "${release_dir}" "${next_link}"
mv -Tf -- "${next_link}" "${current_link}"
if [[ -n "${previous}" && "${previous}" != "${release_dir}" ]]; then
  write_previous "${previous}"
fi
systemctl_run restart larm-daemon.service
if ! verify_release_health "${release_dir}"; then
  if [[ -n "${previous}" && -d "${previous}" ]]; then
    recovery="${current_link}.recovery.$$"
    ln -s -- "${previous}" "${recovery}"
    mv -Tf -- "${recovery}" "${current_link}"
    restore_previous "${previous_state}" "${previous_state_existed}"
    systemctl_run restart larm-daemon.service
    verify_release_health "${previous}" || fail "new and recovered LARM releases both failed verification"
  else
    active="$(current_release)"
    [[ "${active}" == "${release_dir}" ]] || fail "failed first release pointer changed unexpectedly"
    systemctl_run stop larm-daemon.service
    rm -- "${current_link}"
    restore_previous "${previous_state}" "${previous_state_existed}"
  fi
  fail "new LARM release failed readiness and was rolled back"
fi
if [[ -n "${apply_cleanup_candidates}" ]]; then
  remove_cleanup_candidates "${apply_cleanup_candidates}" projected
fi
trap - EXIT
echo "LARM release ${short} is active"
