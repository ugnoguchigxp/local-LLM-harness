#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

test_mode="${LARM_RELEASE_ACTIVATOR_TEST_MODE:-0}"
if [[ "${test_mode}" == "1" ]]; then
  candidate_root="${LARM_RELEASE_CANDIDATE_ROOT:?required in test mode}"
  inbox_root="${LARM_RELEASE_INBOX_ROOT:?required in test mode}"
  release_root="${LARM_RELEASE_ROOT:?required in test mode}"
  current_link="${LARM_RELEASE_CURRENT:?required in test mode}"
  state_root="${LARM_RELEASE_STATE_ROOT:?required in test mode}"
  public_key="${LARM_RELEASE_PUBLIC_KEY:?required in test mode}"
else
  [[ "$(id -u)" -eq 0 ]] || { echo "release activator must run as root" >&2; exit 1; }
  candidate_root=/srv/ai/apps/larm-candidates
  inbox_root=/var/lib/larm/release-inbox
  release_root=/srv/ai/apps/larm-releases
  current_link=/srv/ai/apps/larm-current
  state_root=/var/lib/larm/release-controller
  public_key=/etc/larm/release-signing.pub
fi

fail() { echo "$*" >&2; exit 1; }
for path in "${candidate_root}" "${inbox_root}" "${release_root}" "${current_link}" "${state_root}" "${public_key}"; do
  [[ "${path}" == /* && "${path}" != "/" ]] || fail "release activator paths must be absolute and non-root"
done
for root in "${candidate_root}" "${inbox_root}" "${release_root}" "${state_root}"; do
  [[ -d "${root}" && ! -L "${root}" ]] || fail "release activator root is missing or unsafe: ${root}"
done
[[ -f "${public_key}" && ! -L "${public_key}" && "$(stat -c '%h' -- "${public_key}")" -eq 1 ]] \
  || fail "release public key is missing or unsafe"
if [[ "${test_mode}" != "1" ]]; then
  [[ "$(stat -c '%U:%G:%a' -- "${public_key}")" == "root:root:644" ]] \
    || fail "release public key must be root-owned with mode 0644"
fi

exec 9>"${state_root}/activation.lock"
flock -n 9 || fail "another release activation is running"
request="${inbox_root}/request.json"
[[ -f "${request}" && ! -L "${request}" && "$(stat -c '%h' -- "${request}")" -eq 1 ]] \
  || fail "no safe signed release request is pending"
[[ "$(stat -c '%s' -- "${request}")" -le 65536 ]] || fail "signed release request is too large"

work="$(mktemp -d "${state_root}/.activation.XXXXXX")"
staging=""
trap 'rm -rf -- "${work:-}" "${staging:-}" "${current_link}.next.$$" "${current_link}.recovery.$$"' EXIT
jq -e '
  keys == ["intent","schemaVersion","signature"]
  and .schemaVersion == 1
  and (.intent | type == "object")
  and (.signature | type == "string" and test("^[A-Za-z0-9+/]+={0,2}$"))
' "${request}" >/dev/null || fail "signed release request schema is invalid"
jq -cS '.intent' "${request}" >"${work}/intent.json"
jq -er .signature "${request}" | base64 -d >"${work}/signature.bin" \
  || fail "release request signature encoding is invalid"
openssl dgst -sha256 -verify "${public_key}" -signature "${work}/signature.bin" "${work}/intent.json" >/dev/null \
  || fail "release request signature is not trusted"
jq -e '
  keys == ["candidatePath","commit","manifestSha256","requestedAt","schemaVersion"]
  and .schemaVersion == 1
  and (.commit | type == "string" and test("^[a-f0-9]{40}$"))
  and (.candidatePath | type == "string")
  and (.manifestSha256 | type == "string" and test("^[a-f0-9]{64}$"))
  and (.requestedAt | type == "string")
  and (.requestedAt | fromdateiso8601 | type == "number")
' "${work}/intent.json" >/dev/null || fail "trusted release intent schema is invalid"
commit="$(jq -er .commit "${work}/intent.json")"
candidate="$(jq -er .candidatePath "${work}/intent.json")"
manifest_sha256="$(jq -er .manifestSha256 "${work}/intent.json")"
[[ "${candidate}" == "${candidate_root}/${commit}" ]] || fail "release intent candidate path is outside the fixed slot"
[[ -d "${candidate}" && ! -L "${candidate}" ]] || fail "release candidate is missing or unsafe"
[[ "$(realpath -e -- "${candidate}")" == "${candidate}" ]] || fail "release candidate path traverses a symlink"

safe_tree() {
  local root="$1" link target resolved
  if find -P "${root}" -mindepth 1 ! \( -type d -o -type f -o -type l \) -print -quit | grep -q .; then
    return 1
  fi
  while IFS= read -r -d '' link; do
    target="$(readlink -- "${link}")" || return 1
    [[ "${target}" != /* ]] || return 1
    resolved="$(realpath -m -- "$(dirname -- "${link}")/${target}")"
    [[ "${resolved}" == "${root}" || "${resolved}" == "${root}/"* ]] || return 1
  done < <(find -P "${root}" -mindepth 1 -type l -print0)
}

payload_digest() {
  local root="$1"
  (
    cd "${root}"
    while IFS= read -r -d '' entry; do
      [[ "${entry}" != "./release-manifest.json" ]] || continue
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

write_status() {
  local stage="$1" result="$2" reason="${3:-}" observed="${4:-}"
  jq -n --arg operationId "${manifest_sha256}" --arg desiredRelease "${commit}" \
    --arg observedRelease "${observed}" --arg stage "${stage}" --arg result "${result}" \
    --arg reason "${reason}" --arg updatedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion:1,operationId:$operationId,desiredRelease:$desiredRelease,observedRelease:($observedRelease|if length>0 then . else null end),stage:$stage,result:$result,reason:($reason|if length>0 then . else null end),updatedAt:$updatedAt}' \
    >"${work}/status.json"
  chmod 0644 "${work}/status.json"
  mv -fT -- "${work}/status.json" "${state_root}/status.json"
}

current_release() {
  local active
  if [[ -L "${current_link}" ]]; then
    active="$(readlink -f -- "${current_link}" 2>/dev/null || true)"
    [[ "${active}" == "${release_root}/"* && -d "${active}" && ! -L "${active}" ]] \
      || return 1
    printf '%s\n' "${active}"
  elif [[ -e "${current_link}" ]]; then
    return 1
  fi
}

systemctl_run() {
  if [[ "${test_mode}" == "1" ]]; then
    printf '%s\n' "$*" >>"${state_root}/systemctl.log"
    [[ "${LARM_RELEASE_TEST_FAIL_SYSTEMCTL:-0}" != "1" ]]
  else
    systemctl "$@"
  fi
}

verify_health() {
  local target="$1" expected_commit expected_revision expected_version health ready openapi models activity profiles token=""
  expected_commit="$(jq -er .commit "${target}/release-manifest.json")"
  expected_revision="$(jq -er .configRevision "${target}/release-manifest.json")"
  expected_version="$(jq -er .larmVersion "${target}/release-manifest.json")"
  if [[ "${test_mode}" == "1" ]]; then
    [[ "${LARM_RELEASE_TEST_FAIL_CONTRACT:-0}" != "1" ]]
    return
  fi
  for _attempt in {1..30}; do
    if health="$(curl -fsS --max-time 3 http://127.0.0.1:9810/health 2>/dev/null)" \
      && ready="$(curl -fsS --max-time 3 http://127.0.0.1:9810/ready 2>/dev/null)" \
      && jq -e --arg commit "${expected_commit}" --arg revision "${expected_revision}" --arg version "${expected_version}" \
        '.status == "ok" and .releaseCommit == $commit and .configRevision == $revision and .version == $version' \
        <<<"${health}" >/dev/null \
      && jq -e '.status == "ready"' <<<"${ready}" >/dev/null; then
      break
    fi
    sleep 1
  done
  jq -e --arg commit "${expected_commit}" '.releaseCommit == $commit' <<<"${health:-null}" >/dev/null || return 1
  token="$(sed -n 's/^LARM_API_TOKEN=//p' /etc/larm/larm.env | head -n 1)"
  [[ -n "${token}" ]] || return 1
  openapi="$(curl -fsS --max-time 5 -H "Authorization: Bearer ${token}" http://127.0.0.1:9810/openapi.json)" \
    && models="$(curl -fsS --max-time 5 -H "Authorization: Bearer ${token}" http://127.0.0.1:9810/v1/models)" \
    && activity="$(curl -fsS --max-time 5 -H "Authorization: Bearer ${token}" http://127.0.0.1:9810/v1/activity)" \
    && profiles="$(curl -fsS --max-time 5 http://127.0.0.1:9810/v2/agent-profiles)" \
    || return 1
  jq -e '.openapi == "3.1.0" and (.paths["/v1/chat/completions"] | type == "object") and (.paths["/v1/audio/transcriptions"] | type == "object") and (.paths["/v1/audio/speech"] | type == "object")' \
    <<<"${openapi}" >/dev/null \
    && jq -e '.object == "list" and (.data | type == "array" and length > 0)' <<<"${models}" >/dev/null \
    && jq -e '.state == "idle" or .state == "active" or .state == "draining"' <<<"${activity}" >/dev/null \
    && jq -e --arg revision "${expected_revision}" '.contractVersion == "agent-connection.v2" and .catalogRevision == $revision' \
      <<<"${profiles}" >/dev/null
}

write_status "approved" "running"
cp -- "${work}/intent.json" "${work}/desired.json"
chmod 0600 "${work}/desired.json"
mv -fT -- "${work}/desired.json" "${state_root}/desired.json"

safe_tree "${candidate}" || { write_status "validated" "failed" "unsafe_candidate_tree"; fail "candidate tree is unsafe"; }
[[ -f "${candidate}/release-manifest.json" && ! -L "${candidate}/release-manifest.json" ]] \
  || { write_status "validated" "failed" "manifest_missing"; fail "candidate manifest is missing"; }
[[ "$(sha256sum "${candidate}/release-manifest.json" | awk '{print $1}')" == "${manifest_sha256}" ]] \
  || { write_status "validated" "failed" "manifest_signature_mismatch"; fail "candidate manifest changed after approval"; }
short="${commit:0:12}"
release="${release_root}/${short}"
if [[ ! -e "${release}" && ! -L "${release}" ]]; then
  staging="$(mktemp -d "${release_root}/.activating-${short}.XXXXXX")"
  cp -a --no-preserve=ownership -- "${candidate}/." "${staging}/"
  chown -R root:root -- "${staging}" 2>/dev/null || [[ "${test_mode}" == "1" ]]
  find -P "${staging}" -type d -exec chmod go-w {} +
  find -P "${staging}" -type f -exec chmod go-w {} +
  safe_tree "${staging}" || { write_status "validated" "failed" "unsafe_copied_tree"; fail "copied candidate tree is unsafe"; }
  [[ "$(sha256sum "${staging}/release-manifest.json" | awk '{print $1}')" == "${manifest_sha256}" ]] \
    || { write_status "validated" "failed" "copied_manifest_mismatch"; fail "copied manifest does not match approval"; }
  jq -e --arg commit "${commit}" '
    keys == ["bunVersion","commit","configRevision","createdAt","larmVersion","payloadSha256","schemaVersion"]
    and .schemaVersion == 2 and .commit == $commit
    and (.configRevision | type == "string" and test("^[a-f0-9]{64}$"))
    and (.payloadSha256 | type == "string" and test("^[a-f0-9]{64}$"))
  ' "${staging}/release-manifest.json" >/dev/null \
    || { write_status "validated" "failed" "manifest_invalid"; fail "candidate manifest schema is invalid"; }
  expected_payload="$(jq -er .payloadSha256 "${staging}/release-manifest.json")"
  [[ "$(payload_digest "${staging}")" == "${expected_payload}" ]] \
    || { write_status "validated" "failed" "payload_digest_mismatch"; fail "candidate payload digest is invalid"; }
  mv -T -- "${staging}" "${release}"
  staging=""
else
  [[ -d "${release}" && ! -L "${release}" ]] || fail "release target is unsafe"
  [[ "$(sha256sum "${release}/release-manifest.json" | awk '{print $1}')" == "${manifest_sha256}" ]] \
    || fail "existing release target differs from the approved candidate"
fi
write_status "validated" "running"

previous="$(current_release || true)"
if [[ "${previous}" == "${release}" ]]; then
  verify_health "${release}" || { write_status "contract_verified" "failed" "contract_failure" "${commit}"; fail "active release contract verification failed"; }
  write_status "contract_verified" "succeeded" "" "${commit}"
  rm -f -- "${request}"
  exit 0
fi
next="${current_link}.next.$$"
ln -s -- "${release}" "${next}"
mv -Tf -- "${next}" "${current_link}"
if [[ -n "${previous}" ]]; then
  printf '%s\n' "${previous}" >"${work}/previous"
  chmod 0600 "${work}/previous"
  mv -fT -- "${work}/previous" "${state_root}/previous"
fi
write_status "activated" "running" "" "${commit}"
if ! systemctl_run restart larm-daemon.service || ! verify_health "${release}"; then
  if [[ -n "${previous}" && -d "${previous}" && ! -L "${previous}" ]]; then
    recovery="${current_link}.recovery.$$"
    ln -s -- "${previous}" "${recovery}"
    mv -Tf -- "${recovery}" "${current_link}"
    systemctl_run restart larm-daemon.service || true
  else
    rm -f -- "${current_link}"
    systemctl_run stop larm-daemon.service || true
  fi
  observed=""
  if [[ -n "${previous}" && -f "${previous}/release-manifest.json" ]]; then
    observed="$(jq -r '.commit // empty' "${previous}/release-manifest.json")"
  fi
  write_status "contract_verified" "failed" "activation_contract_failure_rolled_back" "${observed}"
  fail "release activation failed contract verification and was rolled back"
fi
write_status "contract_verified" "succeeded" "" "${commit}"
rm -f -- "${request}"
echo "LARM release ${short} passed trusted activation and lightweight contract verification"
