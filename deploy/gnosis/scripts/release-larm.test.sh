#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
releaser="${repo_root}/deploy/gnosis/scripts/release-larm.sh"
test_root="$(mktemp -d /tmp/larm-release-test.XXXXXX)"
trap 'rm -rf -- "${test_root}"' EXIT
source_root="${test_root}/source"
mkdir -p "${source_root}/packages/core/src"
git -C "${test_root}" init -q source
git -C "${source_root}" config user.email test@example.invalid
git -C "${source_root}" config user.name LARM-test
printf 'lock-v1\n' >"${source_root}/bun.lock"
printf '{"scripts":{"check":"true"}}\n' >"${source_root}/package.json"
printf 'export const LARM_VERSION = "test-1";\n' >"${source_root}/packages/core/src/version.ts"
git -C "${source_root}" add .
git -C "${source_root}" commit -qm first

run_release() {
  LARM_RELEASE_TEST_MODE=1 \
  LARM_RELEASE_SKIP_GATE=1 \
  LARM_RELEASE_KEEP=3 \
  LARM_RELEASE_SOURCE="${source_root}" \
  LARM_RELEASE_ROOT="${test_root}/releases" \
  LARM_RELEASE_CURRENT="${test_root}/current" \
  LARM_RELEASE_STATE_ROOT="${test_root}/state" \
  bash "${releaser}" "$@"
}

run_release plan | jq -e '.dirty == false and (.commit | length == 40)' >/dev/null
run_release apply >/dev/null
first="$(readlink -f "${test_root}/current")"
jq -e '.schemaVersion == 1 and (.lockfileSha256 | length == 64) and .configRevision == "test-gate-skipped"' \
  "${first}/release-manifest.json" >/dev/null
run_release apply >/dev/null
[[ "$(readlink -f "${test_root}/current")" == "${first}" ]]
cp "${first}/bun.lock" "${test_root}/first-lock"
printf 'corrupt\n' >"${first}/bun.lock"
if run_release apply >/dev/null 2>&1; then
  echo "release accepted a digest-mismatched existing generation" >&2
  exit 1
fi
cp "${test_root}/first-lock" "${first}/bun.lock"

printf 'lock-v2\n' >"${source_root}/bun.lock"
printf 'export const LARM_VERSION = "test-2";\n' >"${source_root}/packages/core/src/version.ts"
git -C "${source_root}" add .
git -C "${source_root}" commit -qm second
run_release apply >/dev/null
second="$(readlink -f "${test_root}/current")"
[[ "${second}" != "${first}" ]]
run_release rollback >/dev/null
[[ "$(readlink -f "${test_root}/current")" == "${first}" ]]
jq -e '.larmVersion == "test-1" and .configRevision == "test-gate-skipped"' \
  "$(readlink -f "${test_root}/current")/release-manifest.json" >/dev/null

printf 'dirty\n' >>"${source_root}/bun.lock"
if run_release apply >/dev/null 2>&1; then
  echo "release accepted a dirty worktree" >&2
  exit 1
fi
git -C "${source_root}" restore bun.lock

exec 8>"${test_root}/state/release.lock"
flock -n 8
if run_release apply >/dev/null 2>&1; then
  echo "release accepted a concurrent mutation" >&2
  exit 1
fi
flock -u 8

printf 'lock-v3\n' >"${source_root}/bun.lock"
git -C "${source_root}" add bun.lock
git -C "${source_root}" commit -qm third
before_failure="$(readlink -f "${test_root}/current")"
if LARM_RELEASE_FAIL_AFTER_ARCHIVE=1 run_release apply >/dev/null 2>&1; then
  echo "injected release failure unexpectedly succeeded" >&2
  exit 1
fi
[[ "$(readlink -f "${test_root}/current")" == "${before_failure}" ]]

third_commit="$(git -C "${source_root}" rev-parse HEAD)"
before_failure_previous="$(cat "${test_root}/state/previous")"
if LARM_RELEASE_TEST_UNHEALTHY_RELEASE="${third_commit:0:12}" run_release apply >/dev/null 2>&1; then
  echo "unhealthy release unexpectedly stayed active" >&2
  exit 1
fi
[[ "$(readlink -f "${test_root}/current")" == "${before_failure}" ]]
[[ "$(cat "${test_root}/state/previous")" == "${before_failure_previous}" ]]
run_release apply >/dev/null
third="$(readlink -f "${test_root}/current")"

printf 'lock-v4\n' >"${source_root}/bun.lock"
git -C "${source_root}" add bun.lock
git -C "${source_root}" commit -qm fourth
plan="$(run_release plan)"
confirmation="$(jq -er '.cleanupConfirm' <<<"${plan}")"
jq -e '.cleanupCandidates | length == 1' <<<"${plan}" >/dev/null
if run_release apply >/dev/null 2>&1; then
  echo "release exceeded bounded retention without reviewed cleanup" >&2
  exit 1
fi
fourth_commit="$(git -C "${source_root}" rev-parse HEAD)"
before_retention_failure="$(readlink -f "${test_root}/current")"
before_retention_previous="$(cat "${test_root}/state/previous")"
if LARM_RELEASE_TEST_UNHEALTHY_RELEASE="${fourth_commit:0:12}" \
  LARM_RELEASE_CLEANUP_CONFIRM="${confirmation}" run_release apply >/dev/null 2>&1; then
  echo "unhealthy retained release unexpectedly stayed active" >&2
  exit 1
fi
[[ "$(readlink -f "${test_root}/current")" == "${before_retention_failure}" ]]
[[ "$(cat "${test_root}/state/previous")" == "${before_retention_previous}" ]]
[[ "$(find "${test_root}/releases" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' | wc -l)" -eq 4 ]]
confirmation="$(run_release plan | jq -er '.cleanupConfirm')"
LARM_RELEASE_CLEANUP_CONFIRM="${confirmation}" run_release apply >/dev/null
[[ "$(find "${test_root}/releases" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' | wc -l)" -eq 3 ]]
[[ "$(cat "${test_root}/state/previous")" == "${third}" ]]

ln -s / "${test_root}/symlinked-releases"
if LARM_RELEASE_TEST_MODE=1 LARM_RELEASE_SKIP_GATE=1 \
  LARM_RELEASE_SOURCE="${source_root}" \
  LARM_RELEASE_ROOT="${test_root}/symlinked-releases" \
  LARM_RELEASE_CURRENT="${test_root}/other-current" \
  LARM_RELEASE_STATE_ROOT="${test_root}/other-state" \
  bash "${releaser}" plan >/dev/null 2>&1; then
  echo "release accepted a symlinked release root" >&2
  exit 1
fi
echo "transactional LARM release tests passed"
