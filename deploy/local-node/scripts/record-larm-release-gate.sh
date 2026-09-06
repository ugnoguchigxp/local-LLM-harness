#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

gate="${1:-}"
evidence="${2:-}"
test_mode="${LARM_RELEASE_GATE_TEST_MODE:-0}"
if [[ "${test_mode}" == "1" ]]; then
  state_root="${LARM_RELEASE_STATE_ROOT:?required in test mode}"
  current_link="${LARM_RELEASE_CURRENT:?required in test mode}"
else
  [[ "$(id -u)" -eq 0 ]] || { echo "release gate recorder must run as root" >&2; exit 1; }
  state_root=/var/lib/larm/release-controller
  current_link=/srv/ai/apps/larm-current
fi

fail() { echo "$*" >&2; exit 1; }
[[ "${gate}" == "canary" || "${gate}" == "consumer" ]] \
  || fail "usage: $0 canary|consumer /absolute/path/to/evidence.json"
[[ "${evidence}" == /* && -f "${evidence}" && ! -L "${evidence}" && "$(stat -c '%h' -- "${evidence}")" -eq 1 ]] \
  || fail "evidence must be an absolute regular single-link file"
[[ "$(stat -c '%s' -- "${evidence}")" -le 65536 ]] || fail "evidence is too large"
[[ -d "${state_root}" && ! -L "${state_root}" && -f "${state_root}/status.json" ]] \
  || fail "release convergence state is unavailable"
[[ -L "${current_link}" ]] || fail "active release pointer is unavailable"

exec 9>"${state_root}/activation.lock"
flock -n 9 || fail "another release convergence operation is running"
release="$(readlink -f -- "${current_link}")"
[[ -d "${release}" && ! -L "${release}" && -f "${release}/release-manifest.json" ]] \
  || fail "active release is unsafe"
desired="$(jq -er .desiredRelease "${state_root}/status.json")"
observed="$(jq -er .observedRelease "${state_root}/status.json")"
live_commit="$(jq -er .commit "${release}/release-manifest.json")"
config_revision="$(jq -er .configRevision "${release}/release-manifest.json")"
[[ "${desired}" == "${observed}" && "${observed}" == "${live_commit}" ]] \
  || fail "desired, observed, and active releases do not match"
work="$(mktemp -d "${state_root}/.gate.XXXXXX")"
trap 'rm -rf -- "${work}"' EXIT
validated_evidence="${work}/evidence.json"
cp --no-dereference -- "${evidence}" "${validated_evidence}"
[[ -f "${validated_evidence}" && ! -L "${validated_evidence}" \
  && "$(stat -c '%h' -- "${validated_evidence}")" -eq 1 \
  && "$(stat -c '%s' -- "${validated_evidence}")" -le 65536 ]] \
  || fail "copied evidence is unsafe"
chmod 0600 "${validated_evidence}"

if [[ "${gate}" == "canary" ]]; then
  jq -e --arg commit "${live_commit}" --arg revision "${config_revision}" '
    .schemaVersion == 1
    and .kind == "http-provider-canary"
    and .ok == true
    and .releaseCommit == $commit
    and .desiredRelease == $commit
    and .configRevision == $revision
    and (.bootEpoch | type == "string" and length > 0 and length <= 128)
    and (.observedAt | type == "string")
    and (.observedAt | fromdateiso8601 | type == "number")
    and .jsonValidated == true
    and (.sse.chunks | type == "number" and . > 0)
    and (.sse.deltas | type == "number" and . > 0)
    and (.sse.finishReasons | type == "number" and . > 0)
  ' "${validated_evidence}" >/dev/null || fail "HTTP Provider canary evidence is invalid"
  jq -e '.stage == "contract_verified" and .result == "succeeded"' \
    "${state_root}/status.json" >/dev/null || fail "canary cannot be recorded before contract verification"
  stage=canary_verified
else
  canary_evidence="${state_root}/canary-evidence.json"
  [[ -f "${canary_evidence}" && ! -L "${canary_evidence}" ]] \
    || fail "recorded HTTP Provider canary evidence is unavailable"
  canary_revision="$(jq -er .configRevision "${canary_evidence}")"
  canary_epoch="$(jq -er .bootEpoch "${canary_evidence}")"
  jq -e --arg commit "${live_commit}" --arg revision "${canary_revision}" --arg epoch "${canary_epoch}" '
    keys == ["bootEpoch","configurationRevision","consumer","desiredRelease","jobIdSha256","kind","nextBoundaryActivityRechecked","observedAt","persistenceCount","result","schemaVersion"]
    and .schemaVersion == 1
    and .kind == "consumer-completion"
    and .consumer == "contextstill"
    and .desiredRelease == $commit
    and .configurationRevision == $revision
    and .bootEpoch == $epoch
    and (.jobIdSha256 | type == "string" and test("^[a-f0-9]{64}$"))
    and .result == "completed"
    and .persistenceCount == 1
    and .nextBoundaryActivityRechecked == true
    and (.observedAt | type == "string")
    and (.observedAt | fromdateiso8601 | type == "number")
  ' "${validated_evidence}" >/dev/null || fail "consumer completion evidence is invalid"
  jq -e '.stage == "canary_verified" and .result == "succeeded"' \
    "${state_root}/status.json" >/dev/null || fail "consumer completion cannot be recorded before canary verification"
  stage=complete
fi

mv -fT -- "${validated_evidence}" "${state_root}/${gate}-evidence.json"
jq --arg stage "${stage}" --arg updatedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
  '.stage = $stage | .result = "succeeded" | .reason = null | .updatedAt = $updatedAt' \
  "${state_root}/status.json" >"${work}/status.json"
chmod 0644 "${work}/status.json"
mv -fT -- "${work}/status.json" "${state_root}/status.json"
trap - EXIT
rm -rf -- "${work}"
echo "release convergence advanced to ${stage}"
