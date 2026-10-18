#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

source_root="${LARM_RELEASE_SOURCE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
candidate_root="${LARM_RELEASE_CANDIDATE_ROOT:-/srv/ai/apps/larm-candidates}"
inbox_root="${LARM_RELEASE_INBOX_ROOT:-/var/lib/larm/release-inbox}"
signing_key="${LARM_RELEASE_SIGNING_KEY:-/var/lib/larm/release-builder/signing-key.pem}"
commit="${LARM_RELEASE_COMMIT:-}"
test_mode="${LARM_RELEASE_BUILDER_TEST_MODE:-0}"
bun_bin="${LARM_BUN_BIN:-}"
version_regex='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'

fail() { echo "$*" >&2; exit 1; }
[[ "$(id -u)" -ne 0 ]] || fail "release builder must not run as root"
[[ "${commit}" =~ ^[a-f0-9]{40}$ ]] || fail "LARM_RELEASE_COMMIT must be an explicit full lowercase commit"
for path in "${source_root}" "${candidate_root}" "${inbox_root}" "${signing_key}"; do
  [[ "${path}" == /* && "${path}" != "/" ]] || fail "release builder paths must be absolute and non-root"
done
[[ -d "${source_root}/.git" && ! -L "${source_root}" ]] || fail "source must be a real Git worktree"
source_root="$(realpath -e -- "${source_root}")"
git -C "${source_root}" rev-parse --verify "${commit}^{commit}" >/dev/null \
  || fail "approved commit does not exist"
[[ "$(git -C "${source_root}" rev-parse "${commit}^{commit}")" == "${commit}" ]] \
  || fail "approved commit did not resolve exactly"
[[ -z "$(git -C "${source_root}" status --porcelain=v1 --untracked-files=normal)" ]] \
  || fail "source worktree is dirty"
[[ -d "${candidate_root}" && ! -L "${candidate_root}" ]] || fail "candidate root must be a real directory"
[[ -d "${inbox_root}" && ! -L "${inbox_root}" ]] || fail "release inbox must be a real directory"
[[ -f "${signing_key}" && ! -L "${signing_key}" && "$(stat -c '%h' -- "${signing_key}")" -eq 1 ]] \
  || fail "release signing key must be a regular single-link file"
[[ "$(stat -c '%U' -- "${signing_key}")" == "$(id -un)" && "$(stat -c '%a' -- "${signing_key}")" == "600" ]] \
  || fail "release signing key must be owned by the builder with mode 0600"
if [[ -z "${bun_bin}" ]]; then
  bun_bin="$(command -v bun 2>/dev/null || true)"
fi
[[ "${bun_bin}" == /* && -x "${bun_bin}" && -f "${bun_bin}" ]] \
  || fail "LARM_BUN_BIN must identify an absolute executable Bun binary"
bun_bin="$(realpath -e -- "${bun_bin}")"
export PATH="$(dirname -- "${bun_bin}"):${PATH}"

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

verify_release_gate() {
  local root="$1" actual_inputs
  if [[ "${test_mode}" == "1" && "${LARM_RELEASE_SKIP_GATE:-0}" == "1" ]]; then return; fi
  [[ -f "${root}/release-gate.json" && ! -L "${root}/release-gate.json" ]] \
    || fail "candidate has no mandatory release verification receipt"
  jq -e --arg commit "${commit}" --arg bunVersion "$("${bun_bin}" --version)" '
    .schemaVersion == 1 and .kind == "larm-release-gate" and .passed == true
    and .sourceCommit == $commit and .bunVersion == $bunVersion
    and .sourceDirty == false
    and .productionAudit.status == "passed"
    and (.lockfileSha256 | test("^[a-f0-9]{64}$"))
    and (.inputDigest | test("^[a-f0-9]{64}$"))
    and ([.checks[].id] == ["install","audit","check","coverage"])
    and all(.checks[]; .status == "passed")
  ' "${root}/release-gate.json" >/dev/null || fail "mandatory release verification failed"
  actual_inputs="$(cd "${root}" && "${bun_bin}" -e 'import { releaseInputDigest } from "./scripts/check-release"; console.log(await releaseInputDigest(process.cwd()));')"
  [[ "$(jq -er .inputDigest "${root}/release-gate.json")" == "${actual_inputs}" ]] \
    || fail "release inputs changed after verification"
  [[ "$(jq -er .lockfileSha256 "${root}/release-gate.json")" == "$(sha256sum "${root}/bun.lock" | awk '{print $1}')" ]] \
    || fail "release lockfile changed after verification"
}

candidate="${candidate_root}/${commit}"
if [[ -e "${candidate}" || -L "${candidate}" ]]; then
  [[ -d "${candidate}" && ! -L "${candidate}" && -f "${candidate}/release-manifest.json" ]] \
    || fail "existing candidate is unsafe"
  jq -e --arg commit "${commit}" '.schemaVersion == 2 and .commit == $commit' \
    "${candidate}/release-manifest.json" >/dev/null || fail "existing candidate does not match the approved commit"
  safe_tree "${candidate}" || fail "existing candidate contains an unsafe filesystem entry"
  expected="$(jq -er .payloadSha256 "${candidate}/release-manifest.json")"
  [[ "$(payload_digest "${candidate}")" == "${expected}" ]] || fail "existing candidate payload digest changed"
  verify_release_gate "${candidate}"
  # Reused candidates must also pass the current advisory database before signing.
  if [[ "${test_mode}" != "1" || "${LARM_RELEASE_SKIP_GATE:-0}" != "1" ]]; then
    (
      cd "${candidate}"
      "${bun_bin}" -e 'import { classifyAudit } from "./scripts/check-release";
        const child = Bun.spawn([process.execPath, "audit", "--json", "--audit-level=high"], {stdout:"pipe",stderr:"inherit"});
        const stdout = await new Response(child.stdout).text();
        const result = classifyAudit({exitCode:await child.exited,stdout});
        if (result.status !== "passed") { console.error(result.code); process.exit(1); }'
    )
  fi
else
  staging="$(mktemp -d "${candidate_root}/.building-${commit}.XXXXXX")"
  trap 'chmod -R u+rwX -- "${staging:-}" 2>/dev/null || true; rm -rf -- "${staging:-}" "${request_tmp:-}"' EXIT
  chmod 0750 -- "${staging}"
  git -C "${source_root}" archive "${commit}" | tar -x -C "${staging}"
  if [[ "${LARM_RELEASE_SKIP_GATE:-0}" == "1" ]]; then
    [[ "${test_mode}" == "1" ]] || fail "LARM_RELEASE_SKIP_GATE is restricted to builder test mode"
    install -d -m 0755 "${staging}/node_modules"
    config_revision="$(printf '0%.0s' {1..64})"
  else
    (
      cd "${staging}"
      LARM_RELEASE_GATE_COMMIT="${commit}" "${bun_bin}" run check:release >release-gate.json
      verify_release_gate "${staging}"
      [[ -d node_modules && ! -L node_modules ]] || fail "dependency tree is unsafe"
      find -P node_modules -mindepth 1 -depth -delete
      rmdir node_modules
      "${bun_bin}" install --frozen-lockfile --production >&2
      verify_release_gate "${staging}"
      [[ ! -L coverage ]] || fail "coverage directory is unsafe"
      rm -rf -- coverage
      if find -P node_modules -type d -name ws -print -quit | grep -q .; then
        fail "production dependency tree contains a disallowed transport package"
      fi
    )
    config_revision="$(cd "${staging}" && "${bun_bin}" run apps/daemon/src/print-config-revision.ts)"
  fi
  larm_version="$(sed -n 's/^export const LARM_VERSION = "\([^"]*\)".*/\1/p' \
    "${staging}/packages/core/src/version.ts")"
  [[ "${larm_version}" =~ ${version_regex} && "${config_revision}" =~ ^[a-f0-9]{64}$ ]] \
    || fail "candidate identity metadata is invalid"
  safe_tree "${staging}" || fail "candidate contains an unsafe filesystem entry"
  find -P "${staging}" -type d -exec chmod go-w,u+rwx {} +
  find -P "${staging}" -type f -exec chmod go-w,u+r {} +
  digest="$(payload_digest "${staging}")"
  jq -n --arg commit "${commit}" --arg version "${larm_version}" \
    --arg bunVersion "$("${bun_bin}" --version)" \
    --arg configRevision "${config_revision}" --arg payloadSha256 "${digest}" \
    --arg createdAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion:2,commit:$commit,larmVersion:$version,bunVersion:$bunVersion,configRevision:$configRevision,payloadSha256:$payloadSha256,createdAt:$createdAt}' \
    >"${staging}/release-manifest.json"
  chmod 0444 -- "${staging}/release-manifest.json"
  [[ ! -e "${candidate}" && ! -L "${candidate}" ]] || fail "candidate target appeared during build"
  mv -T -- "${staging}" "${candidate}"
  trap - EXIT
fi

manifest_sha256="$(sha256sum "${candidate}/release-manifest.json" | awk '{print $1}')"
intent="$(jq -cSn --arg commit "${commit}" --arg candidatePath "${candidate}" \
  --arg manifestSha256 "${manifest_sha256}" --arg requestedAt "$(date --utc +%Y-%m-%dT%H:%M:%SZ)" \
  '{schemaVersion:1,commit:$commit,candidatePath:$candidatePath,manifestSha256:$manifestSha256,requestedAt:$requestedAt}')"
signature_file="$(mktemp "${inbox_root}/.signature.XXXXXX")"
request_tmp="$(mktemp "${inbox_root}/.request.XXXXXX")"
trap 'rm -f -- "${signature_file:-}" "${request_tmp:-}"' EXIT
printf '%s\n' "${intent}" | openssl dgst -sha256 -sign "${signing_key}" -out "${signature_file}"
signature="$(base64 -w0 -- "${signature_file}")"
jq -cSn --argjson intent "${intent}" --arg signature "${signature}" \
  '{schemaVersion:1,intent:$intent,signature:$signature}' >"${request_tmp}"
chmod 0600 -- "${request_tmp}"
mv -fT -- "${request_tmp}" "${inbox_root}/request.json"
rm -f -- "${signature_file}"
trap - EXIT
jq -n --arg commit "${commit}" --arg candidate "${candidate}" --arg manifestSha256 "${manifest_sha256}" \
  '{status:"submitted",commit:$commit,candidate:$candidate,manifestSha256:$manifestSha256}'
