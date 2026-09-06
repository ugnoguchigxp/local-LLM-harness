#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
builder="${repo_root}/deploy/local-node/scripts/build-larm-release.sh"
activator="${repo_root}/deploy/local-node/scripts/activate-larm-release.sh"
gate_recorder="${repo_root}/deploy/local-node/scripts/record-larm-release-gate.sh"
rollback="${repo_root}/deploy/local-node/scripts/rollback-larm-release.sh"
test_root="$(mktemp -d /tmp/larm-release-convergence.XXXXXX)"
trap 'chmod -R u+rwX -- "${test_root}" 2>/dev/null || true; rm -rf -- "${test_root}"' EXIT
source_root="${test_root}/source"
candidate_root="${test_root}/candidates"
inbox_root="${test_root}/inbox"
release_root="${test_root}/releases"
state_root="${test_root}/state"
key_root="${test_root}/keys"
current_link="${test_root}/current"
builder_uid="$(id -u)"
builder_gid="$(id -g)"
builder_bun="$(command -v bun)"
builder_cache="${test_root}/builder-cache"
mkdir -p "${source_root}/packages/core/src" "${source_root}/apps/daemon/src" \
  "${candidate_root}" "${inbox_root}" "${release_root}" "${state_root}" "${key_root}"
git -C "${test_root}" init -q source
git -C "${source_root}" config user.email test@example.invalid
git -C "${source_root}" config user.name LARM-test
printf '%s\n' '{"scripts":{"check":"true"},"dependencies":{"zod":"4.4.3"},"devDependencies":{"typescript":"5.9.2"}}' \
  >"${source_root}/package.json"
printf 'export const LARM_VERSION = "1.0.0";\n' >"${source_root}/packages/core/src/version.ts"
printf 'console.log("%064d");\n' 0 >"${source_root}/apps/daemon/src/print-config-revision.ts"
(cd "${source_root}" && bun install --lockfile-only >/dev/null)
if [[ -d "${source_root}/node_modules" ]]; then
  find -P "${source_root}/node_modules" -mindepth 1 -depth -delete
  rmdir "${source_root}/node_modules"
fi
git -C "${source_root}" add .
git -C "${source_root}" commit -qm first
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${key_root}/private.pem" >/dev/null 2>&1
chmod 0600 "${key_root}/private.pem"
openssl pkey -in "${key_root}/private.pem" -pubout -out "${key_root}/public.pem" >/dev/null 2>&1
chmod 0644 "${key_root}/public.pem"

# The legacy release wrapper runs this suite as root, while the signed release
# builder intentionally rejects root. Exercise the production privilege boundary
# by dropping only builder subprocesses to the original sudo user (or nobody in a
# root-only test environment). The source stays root-owned and read-only to that
# subprocess; only the isolated candidate, inbox, and signing-key roots are writable.
if [[ "${builder_uid}" -eq 0 ]]; then
  if [[ "${SUDO_UID:-}" =~ ^[0-9]+$ && "${SUDO_GID:-}" =~ ^[0-9]+$ \
    && "${SUDO_UID}" -ne 0 ]]; then
    builder_uid="${SUDO_UID}"
    builder_gid="${SUDO_GID}"
  else
    builder_uid="$(id -u nobody)"
    builder_gid="$(id -g nobody)"
  fi
  builder_bun="${test_root}/bun"
  install -m 0755 "$(command -v bun)" "${builder_bun}"
  install -d -m 0700 -o "${builder_uid}" -g "${builder_gid}" "${builder_cache}"
  chmod 0755 "${test_root}"
  chown -R "${builder_uid}:${builder_gid}" \
    "${candidate_root}" "${inbox_root}" "${key_root}"
fi

build() {
  local commit="$1"
  local skip_gate="${2:-0}"
  local -a command=(env)
  if [[ "$(id -u)" -eq 0 ]]; then
    command=(setpriv --reuid "${builder_uid}" --regid "${builder_gid}" --clear-groups env \
      GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="${source_root}")
  fi
  "${command[@]}" \
    LARM_RELEASE_BUILDER_TEST_MODE=1 \
    LARM_RELEASE_SKIP_GATE="${skip_gate}" \
    LARM_RELEASE_SOURCE="${source_root}" \
    LARM_RELEASE_CANDIDATE_ROOT="${candidate_root}" \
    LARM_RELEASE_INBOX_ROOT="${inbox_root}" \
    LARM_RELEASE_SIGNING_KEY="${key_root}/private.pem" \
    LARM_RELEASE_COMMIT="${commit}" \
    LARM_BUN_BIN="${builder_bun}" \
    BUN_INSTALL_CACHE_DIR="${builder_cache}" \
    bash "${builder}"
}

activate() {
  LARM_RELEASE_ACTIVATOR_TEST_MODE=1 \
  LARM_RELEASE_CANDIDATE_ROOT="${candidate_root}" \
  LARM_RELEASE_INBOX_ROOT="${inbox_root}" \
  LARM_RELEASE_ROOT="${release_root}" \
  LARM_RELEASE_CURRENT="${current_link}" \
  LARM_RELEASE_STATE_ROOT="${state_root}" \
  LARM_RELEASE_PUBLIC_KEY="${key_root}/public.pem" \
  bash "${activator}"
}

record_gate() {
  LARM_RELEASE_GATE_TEST_MODE=1 \
  LARM_RELEASE_STATE_ROOT="${state_root}" \
  LARM_RELEASE_CURRENT="${current_link}" \
  bash "${gate_recorder}" "$1" "$2"
}

rollback_release() {
  LARM_RELEASE_ROLLBACK_TEST_MODE=1 \
  LARM_RELEASE_ROOT="${release_root}" \
  LARM_RELEASE_CURRENT="${current_link}" \
  LARM_RELEASE_STATE_ROOT="${state_root}" \
  bash "${rollback}"
}

first_commit="$(git -C "${source_root}" rev-parse HEAD)"
build "${first_commit}" | jq -e --arg commit "${first_commit}" '.status == "submitted" and .commit == $commit' >/dev/null
[[ -d "${candidate_root}/${first_commit}/node_modules/zod" ]]
[[ ! -e "${candidate_root}/${first_commit}/node_modules/typescript" ]]
jq -e '.schemaVersion == 1 and (.signature | length > 100)' "${inbox_root}/request.json" >/dev/null
jq -e --arg commit "${first_commit}" '.schemaVersion == 2 and .commit == $commit and (.payloadSha256 | length == 64)' \
  "${candidate_root}/${first_commit}/release-manifest.json" >/dev/null
activate >/dev/null
[[ "$(readlink -f "${current_link}")" == "${release_root}/${first_commit:0:12}" ]]
jq -e --arg commit "${first_commit}" '.stage == "contract_verified" and .result == "succeeded" and .desiredRelease == $commit and .observedRelease == $commit' \
  "${state_root}/status.json" >/dev/null
[[ ! -e "${inbox_root}/request.json" ]]
grep -Fqx 'restart larm-daemon.service' "${state_root}/systemctl.log"

test_revision="$(printf '0%.0s' {1..64})"
jq -n --arg commit "${first_commit}" --arg revision "${test_revision}" --arg epoch "epoch-test" \
  --arg observedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion:1,kind:"consumer-completion",consumer:"contextstill",desiredRelease:$commit,configurationRevision:$revision,bootEpoch:$epoch,jobIdSha256:("c"*64),result:"completed",persistenceCount:1,nextBoundaryActivityRechecked:true,observedAt:$observedAt}' \
  >"${test_root}/consumer.json"
if record_gate consumer "${test_root}/consumer.json" >/dev/null 2>&1; then
  echo "consumer completion advanced before HTTP canary" >&2
  exit 1
fi
jq -n --arg commit "${first_commit}" --arg revision "${test_revision}" \
  --arg observedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion:1,kind:"http-provider-canary",ok:true,desiredRelease:$commit,releaseCommit:$commit,configRevision:$revision,bootEpoch:"epoch-test",observedAt:$observedAt,jsonValidated:true,sse:{chunks:2,deltas:1,finishReasons:1},audio:null}' \
  >"${test_root}/canary.json"
record_gate canary "${test_root}/canary.json" >/dev/null
jq -e '.stage == "canary_verified" and .result == "succeeded"' "${state_root}/status.json" >/dev/null
jq '.bootEpoch = "wrong-epoch"' "${test_root}/consumer.json" >"${test_root}/consumer-wrong-generation.json"
if record_gate consumer "${test_root}/consumer-wrong-generation.json" >/dev/null 2>&1; then
  echo "consumer completion advanced with a mismatched Provider generation" >&2
  exit 1
fi
record_gate consumer "${test_root}/consumer.json" >/dev/null
jq -e '.stage == "consumer_verified" and .result == "succeeded"' "${state_root}/status.json" >/dev/null
jq -n --arg commit "${first_commit}" --arg revision "${test_revision}" '
  {
    schemaVersion:1,
    kind:"http-provider-soak",
    ok:true,
    releaseCommit:$commit,
    configRevision:$revision,
    bootEpoch:"epoch-test",
    startedAt:"2026-09-06T00:00:00Z",
    lastAttemptAt:"2026-09-06T01:00:00Z",
    lastSuccessAt:"2026-09-06T01:00:00Z",
    durationSeconds:3600,
    sampleCount:5,
    failureCount:0,
    maxGapSeconds:900
  }
' >"${test_root}/soak.json"
if record_gate soak "${test_root}/soak.json" >/dev/null 2>&1; then
  echo "release convergence accepted a short HTTP soak" >&2
  exit 1
fi
jq '.lastAttemptAt = "2026-09-07T00:00:00Z"
  | .lastSuccessAt = "2026-09-07T00:00:00Z"
  | .durationSeconds = 86400
  | .sampleCount = 97' "${test_root}/soak.json" >"${test_root}/soak-complete.json"
record_gate soak "${test_root}/soak-complete.json" >/dev/null
jq -e '.stage == "complete" and .result == "succeeded"' "${state_root}/status.json" >/dev/null

printf 'second\n' >>"${source_root}/bun.lock"
git -C "${source_root}" add bun.lock
git -C "${source_root}" commit -qm second
second_commit="$(git -C "${source_root}" rev-parse HEAD)"
build "${second_commit}" 1 >/dev/null
jq '.intent.commit = "0000000000000000000000000000000000000000"' \
  "${inbox_root}/request.json" >"${inbox_root}/tampered.json"
mv -fT "${inbox_root}/tampered.json" "${inbox_root}/request.json"
if activate >/dev/null 2>&1; then
  echo "activator accepted a tampered desired release" >&2
  exit 1
fi
[[ "$(readlink -f "${current_link}")" == "${release_root}/${first_commit:0:12}" ]]

build "${second_commit}" 1 >/dev/null
chmod u+w "${candidate_root}/${second_commit}/bun.lock"
printf 'tampered\n' >>"${candidate_root}/${second_commit}/bun.lock"
if activate >/dev/null 2>&1; then
  echo "activator accepted a payload modified after signing" >&2
  exit 1
fi
[[ "$(readlink -f "${current_link}")" == "${release_root}/${first_commit:0:12}" ]]
chmod -R u+rwX "${candidate_root}/${second_commit}"
rm -rf "${candidate_root}/${second_commit}"

build "${second_commit}" 1 >/dev/null
if LARM_RELEASE_TEST_FAIL_CONTRACT=1 activate >/dev/null 2>&1; then
  echo "activator kept a release that failed its contract gate" >&2
  exit 1
fi
[[ "$(readlink -f "${current_link}")" == "${release_root}/${first_commit:0:12}" ]]
jq -e --arg commit "${first_commit}" '.stage == "contract_verified" and .result == "failed" and .observedRelease == $commit' \
  "${state_root}/status.json" >/dev/null

activate >/dev/null
[[ "$(readlink -f "${current_link}")" == "${release_root}/${second_commit:0:12}" ]]
rollback_release >/dev/null
[[ "$(readlink -f "${current_link}")" == "${release_root}/${first_commit:0:12}" ]]
[[ "$(cat "${state_root}/previous")" == "${release_root}/${second_commit:0:12}" ]]
jq -e --arg commit "${first_commit}" '.stage == "activated" and .result == "failed" and .reason == "manual_rollback" and .observedRelease == $commit' \
  "${state_root}/status.json" >/dev/null

echo "signed release convergence tests passed"
