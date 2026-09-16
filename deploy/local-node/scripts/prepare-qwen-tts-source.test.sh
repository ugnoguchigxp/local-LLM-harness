#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/deploy/local-node/scripts/prepare-qwen-tts-source.sh"
fixture="$(mktemp -d /tmp/larm-qwen-tts-source.XXXXXX)"
trap 'rm -rf -- "${fixture}"' EXIT

mkdir -p "${fixture}/api/backends" "${fixture}/api/routers"
git -C "${fixture}" init -q
git -C "${fixture}" config user.name test
git -C "${fixture}" config user.email test@example.invalid
touch "${fixture}/api/backends/optimized_backend.py" "${fixture}/api/routers/openai_compatible.py"
git -C "${fixture}" add .
git -C "${fixture}" commit -qm base

if LARM_QWEN_TTS_SOURCE="${fixture}" bash "${script}" verify >/dev/null 2>&1; then
  echo "source verifier accepted the wrong revision" >&2
  exit 1
fi

# The production patch fixture is covered structurally without fabricating the pinned Git object.
grep -Fq 'git -C "${source_root}" apply --reverse --check' "${script}"
grep -Fq '"qwen3-tts-expressive": "qwen3-tts"' "${script}"
grep -Fq '"qwen3-tts-expressive": "0.6B-CustomVoice"' "${script}"
grep -Fq 'git -C "${source_root}" restore --source=HEAD --worktree' "${script}"
grep -F 'prepare-qwen-tts-source.sh" apply' "${repo_root}/deploy/local-node/scripts/install-services.sh" >/dev/null

echo "Qwen TTS source preparation tests passed"
