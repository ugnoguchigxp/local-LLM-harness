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
mkdir -p "${source_root}/packages/core/src" "${source_root}/apps/daemon/src" \
  "${candidate_root}" "${inbox_root}" "${release_root}" "${state_root}" "${key_root}"
git -C "${test_root}" init -q source
git -C "${source_root}" config user.email test@example.invalid
git -C "${source_root}" config user.name LARM-test
printf '%s\n' '{"scripts":{"check":"true"}}' >"${source_root}/package.json"
printf 'lock\n' >"${source_root}/bun.lock"
printf 'export const LARM_VERSION = "1.0.0";\n' >"${source_root}/packages/core/src/version.ts"
printf 'console.log("%064d");\n' 0 >"${source_root}/apps/daemon/src/print-config-revision.ts"
git -C "${source_root}" add .
git -C "${source_root}" commit -qm first
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${key_root}/private.pem" >/dev/null 2>&1
chmod 0600 "${key_root}/private.pem"
openssl pkey -in "${key_root}/private.pem" -pubout -out "${key_root}/public.pem" >/dev/null 2>&1
chmod 0644 "${key_root}/public.pem"

build() {
  local commit="$1"
  LARM_RELEASE_BUILDER_TEST_MODE=1 \
  LARM_RELEASE_SKIP_GATE=1 \
  LARM_RELEASE_SOURCE="${source_root}" \
  LARM_RELEASE_CANDIDATE_ROOT="${candidate_root}" \
  LARM_RELEASE_INBOX_ROOT="${inbox_root}" \
  LARM_RELEASE_SIGNING_KEY="${key_root}/private.pem" \
  LARM_RELEASE_COMMIT="${commit}" \
  LARM_BUN_BIN="$(command -v bun)" \
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
jq -e '.stage == "complete" and .result == "succeeded"' "${state_root}/status.json" >/dev/null

printf 'second\n' >>"${source_root}/bun.lock"
git -C "${source_root}" add bun.lock
git -C "${source_root}" commit -qm second
second_commit="$(git -C "${source_root}" rev-parse HEAD)"
build "${second_commit}" >/dev/null
jq '.intent.commit = "0000000000000000000000000000000000000000"' \
  "${inbox_root}/request.json" >"${inbox_root}/tampered.json"
mv -fT "${inbox_root}/tampered.json" "${inbox_root}/request.json"
if activate >/dev/null 2>&1; then
  echo "activator accepted a tampered desired release" >&2
  exit 1
fi
[[ "$(readlink -f "${current_link}")" == "${release_root}/${first_commit:0:12}" ]]

build "${second_commit}" >/dev/null
chmod u+w "${candidate_root}/${second_commit}/bun.lock"
printf 'tampered\n' >>"${candidate_root}/${second_commit}/bun.lock"
if activate >/dev/null 2>&1; then
  echo "activator accepted a payload modified after signing" >&2
  exit 1
fi
[[ "$(readlink -f "${current_link}")" == "${release_root}/${first_commit:0:12}" ]]
chmod -R u+rwX "${candidate_root}/${second_commit}"
rm -rf "${candidate_root}/${second_commit}"

build "${second_commit}" >/dev/null
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
