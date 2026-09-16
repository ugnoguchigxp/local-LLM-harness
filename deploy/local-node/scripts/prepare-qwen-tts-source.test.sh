#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/deploy/local-node/scripts/prepare-qwen-tts-source.sh"
fixture="$(mktemp -d /tmp/larm-qwen-tts-source.XXXXXX)"
fixture_assets="$(mktemp -d /tmp/larm-qwen-tts-assets.XXXXXX)"
trap 'rm -rf -- "${fixture}" "${fixture_assets}"' EXIT

mkdir -p "${fixture}/api/backends" "${fixture}/api/routers"
git -C "${fixture}" init -q
git -C "${fixture}" config user.name test
git -C "${fixture}" config user.email test@example.invalid
touch "${fixture}/api/main.py" \
  "${fixture}/api/backends/optimized_backend.py" \
  "${fixture}/api/routers/openai_compatible.py"
git -C "${fixture}" add .
git -C "${fixture}" commit -qm base

if LARM_QWEN_TTS_SOURCE="${fixture}" bash "${script}" verify >/dev/null 2>&1; then
  echo "source verifier accepted the wrong revision" >&2
  exit 1
fi

cat >"${fixture}/api/routers/openai_compatible.py" <<'PY'
MODEL_ALIASES = {
    "qwen3-tts": "qwen3-tts",
}
PY
cat >"${fixture}/api/backends/optimized_backend.py" <<'PY'
MODEL_ALIASES = {
    "qwen3-tts": "0.6B-CustomVoice",
}
PY
git -C "${fixture}" add .
git -C "${fixture}" commit -qm fixture-base
fixture_revision="$(git -C "${fixture}" rev-parse HEAD)"

sed -i '/"qwen3-tts": "qwen3-tts",/a\    "qwen3-tts-expressive": "qwen3-tts",' \
  "${fixture}/api/routers/openai_compatible.py"
sed -i '/"qwen3-tts": "0.6B-CustomVoice",/a\    "qwen3-tts-expressive": "0.6B-CustomVoice",' \
  "${fixture}/api/backends/optimized_backend.py"
git -C "${fixture}" diff --binary >"${fixture_assets}/managed.patch"
git -C "${fixture}" restore --worktree -- \
  api/backends/optimized_backend.py api/routers/openai_compatible.py
printf 'default_model: fixture\n' >"${fixture_assets}/repository-config.yaml"

fixture_env=(
  LARM_QWEN_TTS_PREPARE_TEST_MODE=1
  LARM_QWEN_TTS_SOURCE="${fixture}"
  LARM_QWEN_TTS_EXPECTED_REVISION="${fixture_revision}"
  LARM_QWEN_TTS_PATCH_FILE="${fixture_assets}/managed.patch"
  LARM_QWEN_TTS_CONFIG_FILE="${fixture_assets}/repository-config.yaml"
)
env "${fixture_env[@]}" bash "${script}" apply >/dev/null
env "${fixture_env[@]}" bash "${script}" verify >/dev/null

printf 'default_model: tampered\n' >"${fixture}/config.production.yaml"
if env "${fixture_env[@]}" bash "${script}" verify >/dev/null 2>&1; then
  echo "source verifier accepted modified production config content" >&2
  exit 1
fi

env "${fixture_env[@]}" bash "${script}" apply >/dev/null
chmod 0600 "${fixture}/config.production.yaml"
if env "${fixture_env[@]}" bash "${script}" verify >/dev/null 2>&1; then
  echo "source verifier accepted modified production config mode" >&2
  exit 1
fi

grep -F 'prepare-qwen-tts-source.sh" apply' "${repo_root}/deploy/local-node/scripts/install-services.sh" >/dev/null

echo "Qwen TTS source preparation tests passed"
