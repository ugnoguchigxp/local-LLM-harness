#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

action="${1:-verify}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source_root="${LARM_QWEN_TTS_SOURCE:-/srv/ai/apps/Qwen3-TTS-Openai-Fastapi}"
expected_revision="eb14f6e6a50445cf442979abb9203ff0d5042c43"
patch_file="${repo_root}/apps/qwen-tts/rocm-gfx1151.patch"
config_file="${repo_root}/apps/qwen-tts/config.production.yaml"

fail() { echo "$*" >&2; exit 1; }
unmanaged_changes() {
  git -C "${source_root}" status --porcelain=v1 --untracked-files=normal \
    | awk '$2 != "config.production.yaml" \
      && $2 != "api/backends/optimized_backend.py" \
      && $2 != "api/routers/openai_compatible.py"'
}
[[ "${action}" == "apply" || "${action}" == "verify" ]] \
  || fail "usage: $0 apply|verify"
[[ "${source_root}" == /* && "${source_root}" != "/" ]] \
  || fail "LARM_QWEN_TTS_SOURCE must be an absolute non-root path"
[[ -d "${source_root}/.git" && ! -L "${source_root}" ]] \
  || fail "Qwen TTS source must be a real Git worktree: ${source_root}"
source_root="$(realpath -e -- "${source_root}")"
[[ "$(git -C "${source_root}" rev-parse HEAD)" == "${expected_revision}" ]] \
  || fail "Qwen TTS source is not at pinned revision ${expected_revision}"

patch_applied=false
if git -C "${source_root}" apply --reverse --check "${patch_file}" >/dev/null 2>&1; then
  patch_applied=true
elif [[ "${action}" == "apply" ]]; then
  unmanaged_status="$(unmanaged_changes)"
  [[ -z "${unmanaged_status}" ]] \
    || fail "Qwen TTS source has changes other than the managed patch"
  # Converge a prior partial/manual application back to the pinned base before
  # applying the repository-owned patch atomically. Only the two patch-owned
  # files are restored; unrelated checkout state remains fail-closed above.
  git -C "${source_root}" restore --source=HEAD --worktree -- \
    api/backends/optimized_backend.py \
    api/routers/openai_compatible.py
  git -C "${source_root}" apply --check "${patch_file}" \
    || fail "Qwen TTS patch does not apply cleanly to the pinned revision"
  git -C "${source_root}" apply "${patch_file}"
  git -C "${source_root}" apply --reverse --check "${patch_file}" >/dev/null 2>&1 \
    || fail "Qwen TTS patch could not be verified after application"
  patch_applied=true
fi
[[ "${patch_applied}" == "true" ]] \
  || fail "Qwen TTS managed patch is not applied"
[[ -z "$(unmanaged_changes)" ]] \
  || fail "Qwen TTS source has changes outside the managed patch and config"

router="${source_root}/api/routers/openai_compatible.py"
backend="${source_root}/api/backends/optimized_backend.py"
grep -Fq '"qwen3-tts-expressive": "qwen3-tts"' "${router}" \
  || fail "Qwen TTS router alias is missing"
grep -Fq '"qwen3-tts-expressive": "0.6B-CustomVoice"' "${backend}" \
  || fail "Qwen TTS optimized backend alias is missing"

if [[ "${action}" == "apply" ]]; then
  target="${source_root}/config.production.yaml"
  [[ ! -L "${target}" && ( ! -e "${target}" || -f "${target}" ) ]] \
    || fail "Qwen TTS production config target is unsafe"
  install -m 0644 "${config_file}" "${target}"
fi

printf '{"valid":true,"revision":"%s","patchApplied":true,"aliasesVerified":true}\n' \
  "${expected_revision}"
