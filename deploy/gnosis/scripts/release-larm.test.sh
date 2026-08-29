#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
releaser="${repo_root}/deploy/gnosis/scripts/release-larm.sh"
test_root="$(mktemp -d /tmp/larm-release-test.XXXXXX)"
trap 'rm -rf -- "${test_root}"' EXIT
source_root="${test_root}/source"
mkdir -p "${source_root}/apps/daemon/src" "${source_root}/packages/core/src"
git -C "${test_root}" init -q source
git -C "${source_root}" config user.email test@example.invalid
git -C "${source_root}" config user.name LARM-test
printf '%s\n' \
  '{"scripts":{"check:source-only":"test -d .git","check:operations":"test -d .git","docs:check":"command -v bun >/dev/null && test ! -e .git","typecheck":"true","test":"true","test:deployment":"true"},"dependencies":{"yaml":"2.9.0"}}' \
  >"${source_root}/package.json"
printf 'console.log("%064d");\n' 0 >"${source_root}/apps/daemon/src/print-config-revision.ts"
printf 'export const LARM_VERSION = "0.1.0";\n' >"${source_root}/packages/core/src/version.ts"
(cd "${source_root}" && bun install --lockfile-only >/dev/null)
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

run_gated_release() {
  LARM_RELEASE_TEST_MODE=1 \
  LARM_RELEASE_KEEP=3 \
  LARM_RELEASE_SOURCE="${source_root}" \
  LARM_RELEASE_ROOT="${test_root}/gated-releases" \
  LARM_RELEASE_CURRENT="${test_root}/gated-current" \
  LARM_RELEASE_STATE_ROOT="${test_root}/gated-state" \
  bash "${releaser}" "$@"
}

run_gated_release apply >/dev/null
[[ -L "${test_root}/gated-current" ]]
[[ -f "$(readlink -f "${test_root}/gated-current")/release-manifest.json" ]]

run_release plan | jq -e '.dirty == false and .current == null and (.commit | length == 40)' >/dev/null
first_commit="$(git -C "${source_root}" rev-parse HEAD)"
if LARM_RELEASE_TEST_FAIL_SYSTEMCTL_ONCE='restart larm-daemon.service' \
  run_release apply >/dev/null 2>&1; then
  echo "first release ignored a failed systemctl restart" >&2
  exit 1
fi
[[ ! -e "${test_root}/current" && ! -L "${test_root}/current" ]]
grep -F 'stop larm-daemon.service' "${test_root}/state/systemctl.log" >/dev/null
rm -f -- "${test_root}/state/systemctl-failure-injected"
if LARM_RELEASE_TEST_UNHEALTHY_RELEASE="${first_commit:0:12}" run_release apply >/dev/null 2>&1; then
  echo "unhealthy first release unexpectedly stayed active" >&2
  exit 1
fi
[[ ! -e "${test_root}/current" && ! -L "${test_root}/current" ]]
grep -F 'stop larm-daemon.service' "${test_root}/state/systemctl.log" >/dev/null
run_release apply >/dev/null
first="$(readlink -f "${test_root}/current")"
jq -e '.schemaVersion == 1 and (.lockfileSha256 | length == 64) and (.nodeModulesSha256 | length == 64)
  and (.configRevision | test("^[a-f0-9]{64}$"))' \
  "${first}/release-manifest.json" >/dev/null
loaded_commit="$(LARM_RELEASE_MANIFEST_UNDER_TEST="${first}/release-manifest.json" bun -e \
  'import { loadReleaseCommit } from "./apps/daemon/src/identity";
   console.log(loadReleaseCommit(process.env.LARM_RELEASE_MANIFEST_UNDER_TEST));')"
[[ "${loaded_commit}" == "${first_commit}" ]]
run_release apply >/dev/null
[[ "$(readlink -f "${test_root}/current")" == "${first}" ]]
cp "${first}/bun.lock" "${test_root}/first-lock"
printf 'corrupt\n' >"${first}/bun.lock"
if run_release apply >/dev/null 2>&1; then
  echo "release accepted a digest-mismatched existing generation" >&2
  exit 1
fi
cp "${test_root}/first-lock" "${first}/bun.lock"
cp "${first}/packages/core/src/version.ts" "${test_root}/first-version"
printf 'export const LARM_VERSION = "9.9.9";\n' >"${first}/packages/core/src/version.ts"
if run_release apply >/dev/null 2>&1; then
  echo "release accepted a source-modified existing generation" >&2
  exit 1
fi
cp "${test_root}/first-version" "${first}/packages/core/src/version.ts"
printf 'tampered dependency\n' >"${first}/node_modules/tampered.js"
if run_release apply >/dev/null 2>&1; then
  echo "release accepted a modified dependency tree" >&2
  exit 1
fi
rm "${first}/node_modules/tampered.js"

printf 'lock-v2\n' >"${source_root}/bun.lock"
printf 'export const LARM_VERSION = "0.2.0";\n' >"${source_root}/packages/core/src/version.ts"
git -C "${source_root}" add .
git -C "${source_root}" commit -qm second
if LARM_RELEASE_TEST_FAIL_SYSTEMCTL_ONCE='restart larm-daemon.service' \
  run_release apply >/dev/null 2>&1; then
  echo "upgrade ignored a failed systemctl restart" >&2
  exit 1
fi
[[ "$(readlink -f "${test_root}/current")" == "${first}" ]]
[[ ! -e "${test_root}/state/previous" ]]
rm -f -- "${test_root}/state/systemctl-failure-injected"
run_release apply >/dev/null
second="$(readlink -f "${test_root}/current")"
[[ "${second}" != "${first}" ]]
printf 'tampered rollback dependency\n' >"${first}/node_modules/tampered.js"
if run_release rollback >/dev/null 2>&1; then
  echo "rollback accepted a modified previous dependency tree" >&2
  exit 1
fi
[[ "$(readlink -f "${test_root}/current")" == "${second}" ]]
rm "${first}/node_modules/tampered.js"
before_rollback_previous="$(cat "${test_root}/state/previous")"
if LARM_RELEASE_TEST_FAIL_SYSTEMCTL_ONCE='restart larm-daemon.service' \
  run_release rollback >/dev/null 2>&1; then
  echo "rollback ignored a failed systemctl restart" >&2
  exit 1
fi
[[ "$(readlink -f "${test_root}/current")" == "${second}" ]]
[[ "$(cat "${test_root}/state/previous")" == "${before_rollback_previous}" ]]
rm -f -- "${test_root}/state/systemctl-failure-injected"
printf 'tampered active dependency\n' >"${second}/node_modules/tampered.js"
if LARM_RELEASE_TEST_FAIL_SYSTEMCTL_ONCE='restart larm-daemon.service' \
  run_release rollback >/dev/null 2>&1; then
  echo "rollback restored an invalid former active release" >&2
  exit 1
fi
[[ "$(readlink -f "${test_root}/current")" == "${first}" ]]
rm "${second}/node_modules/tampered.js"
rm -f -- "${test_root}/state/systemctl-failure-injected"
run_release rollback >/dev/null
[[ "$(readlink -f "${test_root}/current")" == "${second}" ]]
run_release rollback >/dev/null
[[ "$(readlink -f "${test_root}/current")" == "${first}" ]]
jq -e '.larmVersion == "0.1.0" and (.configRevision | test("^[a-f0-9]{64}$"))' \
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
third_commit="$(git -C "${source_root}" rev-parse HEAD)"
printf 'tampered active dependency\n' >"${before_failure}/node_modules/tampered.js"
if run_release apply >/dev/null 2>&1; then
  echo "release accepted an invalid active recovery source" >&2
  exit 1
fi
[[ "$(readlink -f "${test_root}/current")" == "${before_failure}" ]]
[[ ! -e "${test_root}/releases/${third_commit:0:12}" ]]
rm "${before_failure}/node_modules/tampered.js"
if LARM_RELEASE_FAIL_AFTER_ARCHIVE=1 run_release apply >/dev/null 2>&1; then
  echo "injected release failure unexpectedly succeeded" >&2
  exit 1
fi
[[ "$(readlink -f "${test_root}/current")" == "${before_failure}" ]]

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
